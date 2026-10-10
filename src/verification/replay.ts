import type { SandboxBackend, CreateContainerOptions } from "../sandbox/types.ts";
import type { ArtifactStore } from "../storage/artifacts.ts";
import type { ReplayResult, TrajectoryEvent } from "../types/index.ts";
import type { Recipe } from "../environments/recipe.ts";
import type { ForgeTool, ToolContext } from "../harness/types.ts";
import { currentTreeSha, placeSnapshot } from "../environments/workspace.ts";
import { runTests } from "../environments/run.ts";
import { RecordedUser } from "../user-simulator/index.ts";
import type { Logger } from "../util/logger.ts";

/**
 * Replay.
 *
 * Restores the parent state in a clean container and re-executes the recorded tool calls in
 * order, feeding the recorded synthetic-user answers back where the original run asked questions.
 * Copying the final patch in, or replaying stored logs, would not be a replay and is never done:
 * every command runs again for real.
 *
 * Timestamps and durations are expected to differ and are ignored by policy. Anything that
 * changes what happened — a different exit code, a different tool result, a different final tree,
 * a different test outcome — is a divergence and invalidates the replay.
 */

export interface ReplayInput {
  events: readonly TrajectoryEvent[];
  /**
   * Parent snapshot, used only when the image does not already carry the starting state.
   *
   * Normally left undefined: the prepared task image IS the state the solver started from —
   * parent snapshot plus installed dependencies plus the repository initialised over it — and
   * re-extracting a pristine archive on top would drop the install artefacts, so tools like
   * `list_files` would legitimately see a different workspace and every replay would "diverge"
   * for a reason that has nothing to do with the agent.
   */
  parentArchive?: Uint8Array;
  parentTreeSha: string;
  expectedTreeSha: string | null;
  recipe: Recipe;
  backend: SandboxBackend;
  containerOptions: Omit<CreateContainerOptions, "network">;
  tools: readonly ForgeTool[];
  artifacts: ArtifactStore;
  timeoutMs: number;
  maxOutputChars: number;
  network: boolean;
  logger: Logger;
  /** uid:gid the workspace is handed to after the archive is unpacked. */
  runAs: string;
  /** Re-run the reference suite at the end and compare against the original result. */
  expectedFinalTestsGreen: boolean | null;
  signal?: AbortSignal;
}

export async function replayTrajectory(input: ReplayInput): Promise<ReplayResult> {
  const divergences: ReplayResult["divergences"] = [];
  const recordedAnswers = input.events
    .filter((e) => e.type === "user_answer")
    .map((e, index, all) => ({
      question: input.events.find((q) => q.type === "user_question" && q.tool_call_id === e.tool_call_id)?.text ?? `question_${index}/${all.length}`,
      answer: e.text ?? "",
      origin: "synthetic_user" as const,
    }));
  const user = new RecordedUser(recordedAnswers);

  const container = await input.backend.createContainer({
    ...input.containerOptions,
    network: input.network,
    label: "replay",
  });

  let replayedTreeSha: string | null = null;
  let finalTests: ReplayResult["final_tests"] = null;

  try {
    // Establish the starting state and check it before replaying anything. Either the image
    // already carries it, or a parent archive is placed; in both cases the workspace must hash to
    // the parent tree, otherwise the replay would be measuring a different starting point.
    const startingTree = input.parentArchive
      ? (
          await placeSnapshot(container, input.parentArchive, {
            workdir: input.recipe.workdir,
            expectedTreeSha: input.parentTreeSha,
            timeoutMs: input.timeoutMs,
            owner: input.runAs,
          })
        ).treeSha
      : (await currentTreeSha(container, input.recipe.workdir, input.timeoutMs)).treeSha;

    if (startingTree !== input.parentTreeSha) {
      divergences.push({
        event_id: "<setup>",
        kind: "precondition_mismatch",
        detail: `the starting state hashes to ${startingTree}, expected ${input.parentTreeSha}`,
      });
      return {
        attempted: true,
        passed: false,
        divergences,
        replayed_tree_sha: null,
        final_tests: null,
        note: "replay aborted: the starting state does not match the state the agent worked from",
      };
    }

    const toolContext: ToolContext = {
      container,
      workdir: input.recipe.workdir,
      timeoutMs: input.timeoutMs,
      artifacts: input.artifacts,
      maxOutputChars: input.maxOutputChars,
      askUser: (question) => user.ask(question),
      logger: input.logger.child("replay"),
      signal: input.signal,
    };

    for (const event of input.events) {
      if (input.signal?.aborted) {
        divergences.push({ event_id: event.event_id, kind: "missing_event", detail: "replay cancelled" });
        break;
      }

      if (event.type === "user_question") {
        const answer = await user.ask(event.text ?? "");
        const original = input.events.find(
          (e) => e.type === "user_answer" && e.tool_call_id === event.tool_call_id,
        );
        if (original && original.text !== answer) {
          divergences.push({
            event_id: event.event_id,
            kind: "tool_result_mismatch",
            detail: "the recorded synthetic-user answer could not be matched to this question",
          });
        }
        continue;
      }

      if (event.type !== "tool_call") continue;
      const tool = input.tools.find((t) => t.name === event.tool_name);
      if (!tool) {
        divergences.push({
          event_id: event.event_id,
          kind: "missing_event",
          detail: `tool "${event.tool_name}" is not available during replay`,
        });
        continue;
      }

      const originalResult = input.events.find(
        (e) => e.type === "tool_result" && e.tool_call_id === event.tool_call_id,
      );
      // The harness refused this call without running it; re-executing it now would apply a
      // change the original run never made.
      if (originalResult?.origin === "harness") continue;

      let outcome;
      try {
        outcome = await tool.execute(tool.parse(event.tool_input), toolContext);
      } catch (error) {
        divergences.push({
          event_id: event.event_id,
          kind: "tool_result_mismatch",
          detail: `re-execution threw where the original run did not: ${(error as Error).message}`,
        });
        continue;
      }

      if (!originalResult) {
        divergences.push({
          event_id: event.event_id,
          kind: "missing_event",
          detail: "the original trajectory has no result for this tool call",
        });
        continue;
      }

      const mismatch = compareToolOutputs(event.tool_name ?? "", originalResult, outcome);
      if (mismatch) divergences.push({ event_id: event.event_id, kind: mismatch.kind, detail: mismatch.detail });
    }

    const tree = await currentTreeSha(container, input.recipe.workdir, input.timeoutMs);
    replayedTreeSha = tree.treeSha;
    if (input.expectedTreeSha && replayedTreeSha !== input.expectedTreeSha) {
      divergences.push({
        event_id: "<final>",
        kind: "final_tree_mismatch",
        detail: `replay produced tree ${replayedTreeSha}, the original run produced ${input.expectedTreeSha}`,
      });
    }

    if (input.expectedFinalTestsGreen !== null) {
      finalTests = await runTests({
        container,
        recipe: input.recipe,
        workdir: input.recipe.workdir,
        timeoutMs: input.timeoutMs,
        artifacts: input.artifacts,
        label: "replay_final_suite",
        signal: input.signal,
      });
      const green = finalTests.command.exit_code === 0;
      if (green !== input.expectedFinalTestsGreen) {
        divergences.push({
          event_id: "<final>",
          kind: "test_result_mismatch",
          detail: `replay suite ${green ? "passed" : "failed"} but the original run ${input.expectedFinalTestsGreen ? "passed" : "failed"}`,
        });
      }
    }

    for (const question of user.unmatchedQuestions) {
      divergences.push({
        event_id: "<user>",
        kind: "tool_result_mismatch",
        detail: `a replayed question did not match any recorded question: "${question.slice(0, 120)}"`,
      });
    }
  } finally {
    await container.destroy();
  }

  return {
    attempted: true,
    passed: divergences.length === 0,
    divergences,
    replayed_tree_sha: replayedTreeSha,
    final_tests: finalTests,
    note:
      divergences.length === 0
        ? "every recorded tool call was re-executed from a clean parent state and produced the same stable results"
        : `${divergences.length} divergence(s) invalidated the replay`,
  };
}

/**
 * Compare a replayed tool result against the recorded one.
 *
 * Only stable fields participate. Durations and timestamps are excluded by policy because they
 * legitimately vary; exit codes, error status and structural results are not allowed to vary.
 */
function compareToolOutputs(
  toolName: string,
  original: TrajectoryEvent,
  replayed: { output: unknown; isError: boolean; text: string },
): { kind: ReplayResult["divergences"][number]["kind"]; detail: string } | null {
  if (original.tool_is_error !== replayed.isError) {
    return {
      kind: "tool_result_mismatch",
      detail: `error status changed: originally ${original.tool_is_error}, on replay ${replayed.isError}`,
    };
  }

  const before = original.tool_output as Record<string, unknown> | null;
  const after = replayed.output as Record<string, unknown> | null;
  if (!before || !after) return null;

  const unstable = new Set(["duration_ms"]);
  const fields = new Set([...Object.keys(before), ...Object.keys(after)].filter((k) => !unstable.has(k)));

  for (const field of fields) {
    const a = JSON.stringify(before[field]);
    const b = JSON.stringify(after[field]);
    if (a === b) continue;
    if (field === "exit_code") {
      return { kind: "exit_code_mismatch", detail: `${toolName}: exit code ${a} on the original run, ${b} on replay` };
    }
    return { kind: "tool_result_mismatch", detail: `${toolName}: field "${field}" was ${a}, on replay ${b}` };
  }
  return null;
}
