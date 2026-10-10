import type { TokenUsage } from "../types/index.ts";
import { TrajectoryRecorder, extractDecisionSummaries } from "./recorder.ts";
import type { AgentHarness, SolveRequest, SolveResponse } from "./types.ts";

/**
 * Harness that replays a fixed script instead of calling a model.
 *
 * The SCRIPT is synthetic; the TOOL EXECUTION is not. Every step runs the real tool against the
 * real sandbox and records the real result, which is what makes it useful for testing the
 * verification and replay machinery without a model.
 *
 * Trajectories produced here are stamped `execution_mode: "scripted_fixture"`. The exporter
 * refuses to write them unless `export.allow_fixture_provenance` is explicitly enabled, and even
 * then they are labelled and kept out of the real-execution output. A scripted trajectory is
 * never presented as a verified model run.
 */
export interface ScriptedStep {
  /** Assistant prose emitted before the tool call. May contain a ```decision_summary block. */
  say?: string;
  /** Tool invocation. Omit for a step that only speaks. */
  call?: { tool: string; input: unknown };
}

export type Script = (request: SolveRequest) => ScriptedStep[] | Promise<ScriptedStep[]>;

export class ScriptedHarness implements AgentHarness {
  readonly name = "scripted";
  readonly version = "1";
  private readonly script: Script;

  constructor(script: Script) {
    this.script = script;
  }

  async available(): Promise<{ ok: boolean; detail: string }> {
    return {
      ok: true,
      detail: "scripted fixture harness: no model is called; trajectories are not exportable as real runs",
    };
  }

  async solve(request: SolveRequest): Promise<SolveResponse> {
    const recorder = new TrajectoryRecorder();
    recorder.userMessage(request.userPrompt, "synthetic_user");

    const usage: TokenUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      // No model was called, so there is no cost to report. Saying "unknown" would be wrong too:
      // the honest statement is a known zero with the scripted execution mode alongside it.
      cost_usd: 0,
      cost_known: true,
    };

    let outcome: SolveResponse["outcome"] = "completed";
    let error: string | null = null;

    try {
      const steps = await this.script(request);
      let callIndex = 0;
      for (const step of steps) {
        if (request.signal?.aborted) {
          outcome = "aborted";
          error = "cancelled";
          break;
        }
        if (step.say) {
          const extraction = extractDecisionSummaries(step.say, recorder.knownIds());
          for (const { summary, raw } of extraction.summaries) recorder.decisionSummary(summary, raw);
          for (const bad of extraction.rejected) {
            recorder.assistantMessage(bad.raw);
            recorder.annotation(`rejected decision_summary block: ${bad.reason}`);
          }
          if (extraction.remainder.length > 0) recorder.assistantMessage(extraction.remainder);
        }
        if (!step.call) continue;

        const tool = request.tools.find((t) => t.name === step.call!.tool);
        if (!tool) throw new Error(`script referenced an unavailable tool: ${step.call.tool}`);
        const toolCallId = `scripted_${String(callIndex++).padStart(3, "0")}`;
        const input = tool.parse(step.call.input);

        if (tool.name === "ask_user") {
          recorder.userQuestion(toolCallId, (input as { question: string }).question);
          const result = await tool.execute(input, request.toolContext);
          recorder.userAnswer(toolCallId, result.text);
          continue;
        }

        recorder.toolCall(toolCallId, tool.name, input);
        const result = await tool.execute(input, request.toolContext);
        recorder.toolResult(toolCallId, tool.name, result.output, {
          isError: result.isError,
          truncated: result.truncated,
          fullOutputArtifact: result.fullOutputArtifact,
          text: result.text,
        });
      }
    } catch (caught) {
      outcome = "error";
      error = (caught as Error).message;
    }

    return {
      events: recorder.all(),
      usage,
      outcome,
      error,
      executionMode: "scripted_fixture",
      harness: this.name,
      harnessVersion: this.version,
    };
  }
}
