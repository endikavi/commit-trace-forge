import { TaskReview, TaskSpec } from "../types/index.ts";
import type { CandidateIdentity, CommitMetrics, EnvironmentVerification } from "../types/index.ts";
import type { ModelProvider } from "../harness/types.ts";
import type { Store } from "../storage/state.ts";
import type { Git } from "../sources/git.ts";
import { loadPrompt } from "../prompts.ts";
import { extractJsonObject } from "../util/json.ts";
import { ForgeError } from "../util/errors.ts";
import { detectLeaks } from "./leak.ts";

/**
 * Task generation and independent review.
 *
 * The generator sees the target diff; the solver never will. A second model, with its own prompt,
 * reviews the produced request for sufficiency, coherence and leakage before any solve attempt is
 * allowed to start, and a deterministic leak scan runs alongside it.
 */

export interface GenerateInput {
  identity: CandidateIdentity;
  metrics: CommitMetrics;
  environment: EnvironmentVerification;
  git: Git;
  provider: ModelProvider;
  generatorModel: { provider: string; model: string; thinking: string };
  reviewerModel: { provider: string; model: string; thinking: string };
  store: Store;
  timeoutMs: number;
  renameSimilarity: number;
  maxDiffChars?: number;
  signal?: AbortSignal;
}

export interface GenerateOutput {
  task: TaskSpec;
  review: TaskReview;
  /** Deterministic leak findings, merged into the review. */
  deterministicLeaks: string[];
  promptVersions: { taskgen: string; taskreview: string };
  promptHashes: { taskgen: string; taskreview: string };
}

export async function generateTask(input: GenerateInput): Promise<GenerateOutput> {
  const genPrompt = loadPrompt("taskgen");
  const reviewPrompt = loadPrompt("taskreview");
  const maxDiffChars = input.maxDiffChars ?? 60_000;

  const patch = await input.git.patch(input.identity.parent_sha, input.identity.target_sha, input.renameSimilarity);
  const message = await input.git.commitMessage(input.identity.target_sha);
  const truncatedPatch =
    patch.length > maxDiffChars ? `${patch.slice(0, maxDiffChars)}\n\n[... diff truncated ...]` : patch;

  const parentFiles = await input.git.listPathsAt(input.identity.parent_sha);
  const env = input.environment;

  const generatorPrompt = [
    "## Repository",
    input.identity.repository_url,
    "",
    "## Commit message (context for you only; never quote it)",
    message.trim() || "(empty)",
    "",
    "## Files present at the parent state",
    parentFiles.slice(0, 400).join("\n"),
    parentFiles.length > 400 ? `[... ${parentFiles.length - 400} more paths ...]` : "",
    "",
    "## Behaviour evidence measured by running the tests",
    `tests failing at the parent and passing at the target: ${
      env.fail_to_pass.length > 0 ? env.fail_to_pass.join(", ") : "(none)"
    }`,
    "",
    "## Target diff",
    "```diff",
    truncatedPatch,
    "```",
    "",
    "Return the JSON object now.",
  ].join("\n");

  const genStarted = Date.now();
  const genResponse = await input.provider.complete({
    role: "taskgen",
    systemPrompt: genPrompt.text,
    userPrompt: generatorPrompt,
    model: input.generatorModel,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
  input.store.recordUsage(
    input.identity.candidate_id,
    "taskgen",
    genResponse.model,
    genResponse.usage,
    Date.now() - genStarted,
  );

  const raw = extractJsonObject(genResponse.text) as Record<string, unknown>;
  if (raw.reject === true) {
    throw new ForgeError(
      "taskgen_multiple_intents",
      `the task generator declined this commit: ${String(raw.reason ?? "no reason given")}`,
    );
  }

  let task: TaskSpec;
  try {
    task = TaskSpec.parse({
      ...raw,
      provenance: {
        generator_prompt_version: genPrompt.version,
        generator_model: genResponse.model,
        generated_at: new Date().toISOString(),
        synthetic_fixture: genResponse.executionMode === "scripted_fixture",
      },
    });
  } catch (error) {
    throw new ForgeError(
      "taskgen_invalid_response",
      `the task generator did not return a valid task: ${(error as Error).message}`,
      { raw: genResponse.text.slice(0, 2000) },
    );
  }

  // ---- deterministic leak scan -------------------------------------------
  const deterministicLeaks = detectLeaks({
    task,
    targetSha: input.identity.target_sha,
    parentSha: input.identity.parent_sha,
    commitMessage: message,
    patch,
    parentPaths: parentFiles,
  });

  // ---- independent review -------------------------------------------------
  const reviewUserPrompt = [
    "## The generated request",
    task.user_prompt,
    "",
    "## Acceptance criteria",
    task.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join("\n"),
    "",
    "## User fact sheet",
    task.user_fact_sheet.length > 0
      ? task.user_fact_sheet.map((f) => `- ${f.topic}: ${f.fact}`).join("\n")
      : "(empty)",
    "",
    "## Ambiguity assessment",
    JSON.stringify(task.ambiguity_assessment),
    "",
    "## Target diff (the engineer will NOT see this)",
    "```diff",
    truncatedPatch,
    "```",
    "",
    "## Commit message (the engineer will NOT see this)",
    message.trim() || "(empty)",
    "",
    "Return the JSON object now.",
  ].join("\n");

  const reviewStarted = Date.now();
  const reviewResponse = await input.provider.complete({
    role: "taskreview",
    systemPrompt: reviewPrompt.text,
    userPrompt: reviewUserPrompt,
    model: input.reviewerModel,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
  input.store.recordUsage(
    input.identity.candidate_id,
    "taskreview",
    reviewResponse.model,
    reviewResponse.usage,
    Date.now() - reviewStarted,
  );

  let review: TaskReview;
  try {
    review = TaskReview.parse(extractJsonObject(reviewResponse.text));
  } catch (error) {
    throw new ForgeError(
      "taskgen_invalid_response",
      `the task reviewer did not return a valid review: ${(error as Error).message}`,
      { raw: reviewResponse.text.slice(0, 2000) },
    );
  }

  // The deterministic scan can only tighten the verdict, never loosen it.
  if (deterministicLeaks.length > 0) {
    review.leaks_solution = true;
    review.leak_evidence = [...review.leak_evidence, ...deterministicLeaks];
    review.verdict = "reject";
  }

  return {
    task,
    review,
    deterministicLeaks,
    promptVersions: { taskgen: genPrompt.version, taskreview: reviewPrompt.version },
    promptHashes: { taskgen: genPrompt.hash, taskreview: reviewPrompt.hash },
  };
}

export function reviewRejectionCause(review: TaskReview): "taskgen_review_leak" | "taskgen_review_insufficient" | "taskgen_review_incoherent" {
  if (review.leaks_solution) return "taskgen_review_leak";
  if (!review.sufficient) return "taskgen_review_insufficient";
  return "taskgen_review_incoherent";
}
