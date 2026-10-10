import type { TokenUsage, TrajectoryEvent } from "../types/index.ts";
import type { SandboxContainer } from "../sandbox/types.ts";
import type { ArtifactStore } from "../storage/artifacts.ts";
import type { Logger } from "../util/logger.ts";

/**
 * Tool layer shared by every harness.
 *
 * The tools are the only way an agent touches the workspace, and every one of them executes for
 * real inside the sandbox. Nothing here ever returns a fabricated result: an error is reported
 * as an error, and a truncated payload is flagged with the artifact hash of the full output.
 */

export interface ToolContext {
  container: SandboxContainer;
  workdir: string;
  timeoutMs: number;
  artifacts: ArtifactStore;
  /** Characters of tool output the model may see before truncation kicks in. */
  maxOutputChars: number;
  /** Handles `ask_user`. Null disables the tool. */
  askUser: ((question: string) => Promise<string>) | null;
  logger: Logger;
  signal?: AbortSignal;
}

export interface ToolOutcome {
  /** Text handed to the model. Possibly truncated. */
  text: string;
  /** Structured result recorded on the trajectory event. */
  output: unknown;
  isError: boolean;
  truncated: boolean;
  /** Artifact hash of the untruncated payload, set whenever `truncated` is true. */
  fullOutputArtifact: string | null;
}

export interface ForgeTool<Input = unknown> {
  name: string;
  description: string;
  /** JSON Schema (TypeBox-compatible) describing the accepted input. */
  inputSchema: Record<string, unknown>;
  /** JSON Schema describing the structured output recorded on the event. */
  outputSchema: Record<string, unknown>;
  parse(raw: unknown): Input;
  execute(input: Input, ctx: ToolContext): Promise<ToolOutcome>;
}

// ---------------------------------------------------------------------------
// Harness abstraction
// ---------------------------------------------------------------------------

export interface SolveRequest {
  /** The synthetic user request. The only task information the agent receives. */
  userPrompt: string;
  systemPrompt: string;
  tools: ForgeTool[];
  toolContext: ToolContext;
  maxTurns: number;
  /** Emit short decision summaries alongside actions. Never chain-of-thought. */
  decisionSummaries: boolean;
  model: { provider: string; model: string; thinking: string };
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface SolveResponse {
  events: TrajectoryEvent[];
  usage: TokenUsage;
  outcome: "completed" | "error" | "timeout" | "aborted";
  error: string | null;
  /** Identifies how the trajectory was produced. Only "real_model" is exportable by default. */
  executionMode: "real_model" | "scripted_fixture";
  harness: string;
  harnessVersion: string;
}

/**
 * Pluggable agent harness.
 *
 * The dataset logic never imports a harness implementation directly: `forge` selects one at
 * runtime, so swapping the agent (or the model provider underneath it) is a configuration
 * change rather than a rewrite.
 */
export interface AgentHarness {
  readonly name: string;
  readonly version: string;
  /** Whether the harness can run right now, and why not when it cannot. */
  available(model: { provider: string; model: string }): Promise<{ ok: boolean; detail: string }>;
  solve(request: SolveRequest): Promise<SolveResponse>;
}

// ---------------------------------------------------------------------------
// Structured single-shot model calls (grader, task generator, reviewer, user simulator)
// ---------------------------------------------------------------------------

export interface CompletionRequest {
  role: "grader" | "taskgen" | "taskreview" | "user_simulator" | "judge";
  systemPrompt: string;
  userPrompt: string;
  /** JSON Schema the response must satisfy. Responses are validated, never trusted. */
  responseSchema?: Record<string, unknown>;
  model: { provider: string; model: string; thinking: string };
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface CompletionResponse {
  text: string;
  usage: TokenUsage;
  model: string;
  executionMode: "real_model" | "scripted_fixture";
}

export interface ModelProvider {
  readonly name: string;
  available(model: { provider: string; model: string }): Promise<{ ok: boolean; detail: string }>;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}
