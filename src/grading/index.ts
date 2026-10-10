import type { Grading } from "../config/schema.ts";
import { CommitGrade } from "../types/index.ts";
import type { CandidateIdentity, CommitMetrics, EnvironmentVerification } from "../types/index.ts";
import type { ModelProvider } from "../harness/types.ts";
import type { Store } from "../storage/state.ts";
import type { Git } from "../sources/git.ts";
import { loadPrompt } from "../prompts.ts";
import { extractJsonObject } from "../util/json.ts";
import { ForgeError, type RejectionCause } from "../util/errors.ts";

/**
 * Structured commit evaluation.
 *
 * The deterministic filters have already run; this stage exists to judge what a rule cannot.
 * Its output is validated against a schema — a free-form comment is never accepted as an
 * evaluation — and the weighted total is computed here, not by the model.
 *
 * A score selects candidates. It never establishes that the resulting trajectory is correct;
 * that is what verification is for.
 */

export interface GradeInput {
  identity: CandidateIdentity;
  metrics: CommitMetrics;
  environment: EnvironmentVerification;
  git: Git;
  provider: ModelProvider;
  model: { provider: string; model: string; thinking: string };
  grading: Grading;
  store: Store;
  timeoutMs: number;
  renameSimilarity: number;
  /** Cap on diff characters shown to the grader. */
  maxDiffChars?: number;
  signal?: AbortSignal;
}

export interface GradeOutput {
  grade: CommitGrade;
  totalScore: number;
  passed: boolean;
  cause: RejectionCause | null;
  detail: string;
  promptVersion: string;
  promptHash: string;
  modelUsed: string;
}

export function weightedTotal(grade: CommitGrade, grading: Grading): number {
  const d = grade.dimensions;
  const w = grading.weights;
  const sum =
    d.task_clarity.score * w.task_clarity +
    d.testability.score * w.testability +
    d.context_independence.score * w.context_independence +
    d.change_coherence.score * w.change_coherence +
    d.training_value.score * w.training_value +
    d.environment_reproducibility.score * w.environment_reproducibility;
  // Dimensions are 0-5 and the weights sum to 1, so the weighted sum is 0-5.
  return Math.round((sum / 5) * 100 * 100) / 100;
}

export async function gradeCommit(input: GradeInput): Promise<GradeOutput> {
  const prompt = loadPrompt("grader");
  const maxDiffChars = input.maxDiffChars ?? 60_000;

  const patch = await input.git.patch(input.identity.parent_sha, input.identity.target_sha, input.renameSimilarity);
  const message = await input.git.commitMessage(input.identity.target_sha);
  const truncatedPatch =
    patch.length > maxDiffChars
      ? `${patch.slice(0, maxDiffChars)}\n\n[... diff truncated at ${maxDiffChars} characters ...]`
      : patch;

  const env = input.environment;
  const testEvidence = [
    `parent reference suite: exit ${env.parent_tests?.command.exit_code ?? "n/a"}, ` +
      `${env.parent_tests?.totals.passed ?? 0} passed / ${env.parent_tests?.totals.failed ?? 0} failed`,
    `target reference suite: exit ${env.target_tests?.command.exit_code ?? "n/a"}, ` +
      `${env.target_tests?.totals.passed ?? 0} passed / ${env.target_tests?.totals.failed ?? 0} failed`,
    `tests failing at the parent and passing at the target: ${
      env.fail_to_pass.length > 0 ? env.fail_to_pass.join(", ") : "(none found)"
    }`,
    `dependency manifests changed by the target: ${
      env.dependency_changes.length > 0 ? env.dependency_changes.join(", ") : "(none)"
    }`,
  ].join("\n");

  const userPrompt = [
    "## Repository",
    `${input.identity.repository_url} (family: ${input.identity.repository_family})`,
    "",
    "## Commit message",
    message.trim() || "(empty)",
    "",
    "## Change metrics",
    `files changed: ${input.metrics.filtered.changed_files}`,
    `lines added: ${input.metrics.filtered.added_lines}, lines deleted: ${input.metrics.filtered.deleted_lines}`,
    `paths: ${input.metrics.files.map((f) => f.path).join(", ")}`,
    "",
    "## Verified environment facts",
    "These come from real container runs, not from estimation:",
    testEvidence,
    "",
    "## Target diff",
    "```diff",
    truncatedPatch,
    "```",
    "",
    "Return the JSON object now.",
  ].join("\n");

  const started = Date.now();
  const response = await input.provider.complete({
    role: "grader",
    systemPrompt: prompt.text,
    userPrompt,
    model: input.model,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
  input.store.recordUsage(input.identity.candidate_id, "grader", response.model, response.usage, Date.now() - started);

  let parsed: CommitGrade;
  try {
    parsed = CommitGrade.parse(extractJsonObject(response.text));
  } catch (error) {
    throw new ForgeError(
      "grade_invalid_response",
      `the grader did not return a valid evaluation: ${(error as Error).message}`,
      { raw: response.text.slice(0, 2000) },
    );
  }

  const totalScore = weightedTotal(parsed, input.grading);
  parsed.total_score = totalScore;

  // Gates are independent of the score and are checked first.
  const gate = firstFailedGate(parsed, env);
  if (gate) {
    return {
      grade: parsed,
      totalScore,
      passed: false,
      cause: gate.cause,
      detail: gate.detail,
      promptVersion: prompt.version,
      promptHash: prompt.hash,
      modelUsed: response.model,
    };
  }

  const dimensionFailure = firstDimensionBelowMinimum(parsed, input.grading);
  if (dimensionFailure) {
    return {
      grade: parsed,
      totalScore,
      passed: false,
      cause: "grade_below_dimension_minimum",
      detail: dimensionFailure,
      promptVersion: prompt.version,
      promptHash: prompt.hash,
      modelUsed: response.model,
    };
  }

  if (totalScore < input.grading.min_score) {
    return {
      grade: parsed,
      totalScore,
      passed: false,
      cause: "grade_below_total_threshold",
      detail: `weighted total ${totalScore} < required ${input.grading.min_score}`,
      promptVersion: prompt.version,
      promptHash: prompt.hash,
      modelUsed: response.model,
    };
  }

  return {
    grade: parsed,
    totalScore,
    passed: true,
    cause: null,
    detail: "",
    promptVersion: prompt.version,
    promptHash: prompt.hash,
    modelUsed: response.model,
  };
}

/**
 * Rejection gates.
 *
 * These are evaluated before the score. Environment facts recorded from real runs override the
 * model's opinion: if no fail-to-pass evidence was measured, the candidate is rejected for missing
 * relevant tests even if the grader claimed the change is well tested.
 */
function firstFailedGate(
  grade: CommitGrade,
  env: EnvironmentVerification,
): { cause: RejectionCause; detail: string } | null {
  if (grade.gates.depends_on_external_context) {
    return {
      cause: "grade_gate_isolation",
      detail: `grader flagged external context dependence: ${grade.rejection_reasons.join("; ") || "(no reason given)"}`,
    };
  }
  if (grade.gates.multiple_unrelated_intents) {
    return {
      cause: "taskgen_multiple_intents",
      detail: `grader flagged multiple unrelated intents: ${grade.rejection_reasons.join("; ") || "(no reason given)"}`,
    };
  }
  if (grade.gates.environment_irreproducible) {
    return { cause: "grade_gate_environment", detail: "grader flagged the environment as irreproducible" };
  }
  if (grade.gates.no_relevant_tests) {
    return { cause: "grade_gate_no_relevant_tests", detail: "grader found no test covering the changed behaviour" };
  }
  if (!env.ok) {
    return { cause: "grade_gate_environment", detail: `environment verification did not succeed: ${env.rejection_cause}` };
  }
  return null;
}

function firstDimensionBelowMinimum(grade: CommitGrade, grading: Grading): string | null {
  const checks: Array<[keyof CommitGrade["dimensions"], number]> = [
    ["task_clarity", grading.min_task_clarity],
    ["testability", grading.min_testability],
    ["context_independence", grading.min_context_independence],
    ["change_coherence", grading.min_change_coherence],
    ["training_value", grading.min_training_value],
    ["environment_reproducibility", grading.min_environment_reproducibility],
  ];
  for (const [name, minimum] of checks) {
    const score = grade.dimensions[name].score;
    if (score < minimum) return `${name}=${score} below the minimum ${minimum}`;
  }
  return null;
}
