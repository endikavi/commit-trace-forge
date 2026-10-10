import type { JudgeConfig } from "../config/schema.ts";
import type { ModelProvider } from "../harness/types.ts";
import type { Store } from "../storage/state.ts";
import { loadPrompt } from "../prompts.ts";
import { extractJsonObject } from "../util/json.ts";
import {
  JudgeVerdict,
  type Judgment,
  type TaskSpec,
  type TrajectoryEvent,
  type VerifiableOutcome,
} from "../types/index.ts";

/**
 * LLM judge.
 *
 * Scores one trajectory against a fixed rubric (prompts/judge/<version>.md). The model returns
 * per-dimension scores with evidence and two flags; the response is schema-validated, and the
 * weighted score is computed here. The judge is told the measured test results as ground truth:
 * it judges what tests cannot see — coverage, quality, process, honesty — and never decides
 * whether the solution passes.
 */

export interface JudgeInput {
  task: TaskSpec;
  events: readonly TrajectoryEvent[];
  /** Unified diff of the agent's final workspace against the starting state. */
  solutionPatch: string;
  verifiable: VerifiableOutcome;
  /** Ids of hidden checks still failing, and regressions, for the judge's context. */
  failingChecks: readonly string[];
  /** Historical reference patch. Only passed when `judge.show_reference_patch` is on. */
  referencePatch: string | null;
  provider: ModelProvider;
  model: { provider: string; model: string; thinking: string };
  config: JudgeConfig;
  store: Store;
  candidateId: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
}

export async function judgeTrajectory(input: JudgeInput): Promise<Judgment> {
  const prompt = loadPrompt("judge");
  const userPrompt = buildJudgePrompt(input);

  const started = Date.now();
  const response = await input.provider.complete({
    role: "judge",
    systemPrompt: prompt.text,
    userPrompt,
    model: input.model,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
  input.store.recordUsage(input.candidateId, "judge", response.model, response.usage, Date.now() - started);

  let verdict: JudgeVerdict;
  try {
    verdict = JudgeVerdict.parse(extractJsonObject(response.text));
  } catch (error) {
    throw new Error(`the judge did not return a valid verdict: ${(error as Error).message}`);
  }

  return {
    verdict,
    score: judgeScore(verdict, input.config.weights),
    judge_model: response.model,
    prompt_version: prompt.version,
    prompt_hash: prompt.hash,
    saw_reference: input.referencePatch !== null,
    usage: response.usage,
    judged_at: new Date().toISOString(),
  };
}

/** Weighted mean of the dimension scores, normalised to [0, 1]. */
export function judgeScore(verdict: JudgeVerdict, weights: JudgeConfig["weights"]): number {
  const d = verdict.dimensions;
  const sum =
    d.requirement_coverage.score * weights.requirement_coverage +
    d.solution_quality.score * weights.solution_quality +
    d.verification_discipline.score * weights.verification_discipline +
    d.scope_discipline.score * weights.scope_discipline +
    d.communication_honesty.score * weights.communication_honesty +
    d.efficiency.score * weights.efficiency;
  return Math.round((sum / 5) * 10_000) / 10_000;
}

export function buildJudgePrompt(
  input: Omit<JudgeInput, "provider" | "store" | "model" | "timeoutMs" | "candidateId" | "signal">,
): string {
  const v = input.verifiable;
  const facts = [
    `agent loop completed: ${v.agent_completed}`,
    `hidden tests passed: ${v.tests_passed}`,
    `fail-to-pass checks satisfied: ${v.fail_to_pass_satisfied} of ${v.fail_to_pass_total}`,
    `regressions: ${v.regressions}`,
    `existing test files modified by the agent: ${v.visible_tests_tampered} (deleted: ${v.visible_tests_deleted}; ` +
      "the hidden copies were restored before the tests ran, so this cannot change the result)",
    input.failingChecks.length > 0 ? `still failing: ${input.failingChecks.slice(0, 20).join(", ")}` : "",
  ].filter(Boolean);

  const sections = [
    "## User request",
    input.task.user_prompt,
    "",
    "## Acceptance criteria",
    ...input.task.acceptance_criteria.map((c) => `- ${c}`),
    "",
    "## Measured facts (ground truth, from a clean container)",
    ...facts,
    "",
    "## Trajectory",
    renderTrajectory(input.events, input.config.max_trajectory_chars),
    "",
    "## Diff of the agent's final workspace",
    "```diff",
    clip(input.solutionPatch, input.config.max_diff_chars) || "(no changes)",
    "```",
  ];
  if (input.referencePatch !== null) {
    sections.push(
      "",
      "## Historical reference patch",
      "One valid solution, for comparison only. A different approach that meets the criteria is not worse for being different.",
      "```diff",
      clip(input.referencePatch, input.config.max_diff_chars),
      "```",
    );
  }
  sections.push("", "Return the JSON object now.");
  return sections.join("\n");
}

/**
 * Render a trajectory compactly with event ids, so the judge can cite them.
 *
 * Tool outputs are clipped per event first; if the whole rendering is still too long, the middle
 * of the trajectory is elided and the elision is stated, never silently dropped.
 */
export function renderTrajectory(events: readonly TrajectoryEvent[], maxChars: number): string {
  const perOutput = Math.max(400, Math.floor(maxChars / Math.max(8, events.length)));
  const lines: string[] = [];
  for (const e of events) {
    if (e.origin === "posthoc_annotation") continue;
    switch (e.type) {
      case "user_message":
        lines.push(`[${e.event_id}] USER: ${e.text ?? ""}`);
        break;
      case "assistant_message":
        lines.push(`[${e.event_id}] AGENT: ${e.text ?? ""}`);
        break;
      case "decision_summary":
        lines.push(`[${e.event_id}] AGENT (summary): ${JSON.stringify(e.decision_summary)}`);
        break;
      case "user_question":
        lines.push(`[${e.event_id}] AGENT asks user: ${e.text ?? ""}`);
        break;
      case "user_answer":
        lines.push(`[${e.event_id}] USER answers: ${e.text ?? ""}`);
        break;
      case "tool_call":
        lines.push(`[${e.event_id}] CALL ${e.tool_name}: ${clip(JSON.stringify(e.tool_input), 2_000)}`);
        break;
      case "tool_result":
        lines.push(
          `[${e.event_id}] RESULT${e.tool_is_error ? " (error)" : ""}: ${clip(e.text ?? JSON.stringify(e.tool_output), perOutput)}`,
        );
        break;
      case "annotation":
        break;
    }
  }
  const full = lines.join("\n");
  if (full.length <= maxChars) return full;
  const head = full.slice(0, Math.floor(maxChars * 0.4));
  const tail = full.slice(full.length - Math.floor(maxChars * 0.6));
  return `${head}\n\n[... ${full.length - head.length - tail.length} characters of the trajectory elided ...]\n\n${tail}`;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.max(0, max - 80);
  return `${text.slice(0, Math.floor(keep * 0.7))}\n[... ${text.length - keep} characters elided ...]\n${text.slice(text.length - Math.floor(keep * 0.3))}`;
}
