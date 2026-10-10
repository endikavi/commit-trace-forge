import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TokenUsage } from "../types/index.ts";
import type { Logger } from "../util/logger.ts";
import { ADAPTER_VERSION } from "../storage/versions.ts";
import { TrajectoryRecorder, extractDecisionSummaries } from "./recorder.ts";
import type {
  AgentHarness,
  CompletionRequest,
  CompletionResponse,
  ForgeTool,
  ModelProvider,
  SolveRequest,
  SolveResponse,
  ToolContext,
} from "./types.ts";

/**
 * Adapter for the Pi coding agent (@earendil-works/pi-coding-agent).
 *
 * Verified against the installed 0.85.1 API surface: `createAgentSession`, `defineTool`,
 * `DefaultResourceLoader`, `ModelRuntime`, `SessionManager` and `SettingsManager`.
 *
 * Isolation choices, all deliberate (see docs/security.md):
 *   - `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, `noContextFiles`: nothing is
 *     auto-discovered, so a file inside the repository under test cannot change the agent's rules
 *   - `noTools: "all"` plus an explicit allowlist: only the six forge tools are reachable, and
 *     every one of them executes inside the sandbox container
 *   - in-memory session and settings: no host session files are read or written
 *   - the model runtime lives in this process; the provider credential is never handed to the
 *     shell the solver drives
 */
export class PiHarness implements AgentHarness {
  readonly name = "pi";
  readonly version: string;
  private readonly logger: Logger;
  private readonly agentDir: string | undefined;
  private runtime: ModelRuntime | undefined;

  constructor(options: { logger: Logger; agentDir?: string; version?: string }) {
    this.logger = options.logger;
    this.agentDir = options.agentDir;
    this.version = options.version ?? PI_PACKAGE_VERSION;
  }

  private async modelRuntime(): Promise<ModelRuntime> {
    if (!this.runtime) {
      this.runtime = await ModelRuntime.create(
        this.agentDir ? { authPath: join(this.agentDir, "auth.json"), modelsPath: join(this.agentDir, "models.json") } : {},
      );
    }
    return this.runtime;
  }

  async available(model: { provider: string; model: string }): Promise<{ ok: boolean; detail: string }> {
    try {
      const runtime = await this.modelRuntime();
      const resolved = runtime.getModel(model.provider, model.model);
      if (!resolved) {
        return {
          ok: false,
          detail: `pi does not know model "${model.provider}/${model.model}". Check ~/.pi/agent/models.json or run \`pi --list-models\`.`,
        };
      }
      const status = await runtime.checkAuth(model.provider);
      const ready = typeof status === "object" && status !== null && "status" in status
        ? (status as { status: string }).status === "ready"
        : Boolean(status);
      if (!ready) {
        return {
          ok: false,
          detail:
            `pi has no usable credential for provider "${model.provider}" ` +
            `(${JSON.stringify(status)}). Configure it with \`pi auth\` or an environment variable.`,
        };
      }
      return { ok: true, detail: `pi ${this.version} ready for ${model.provider}/${model.model}` };
    } catch (error) {
      return { ok: false, detail: `pi model runtime failed to initialise: ${(error as Error).message}` };
    }
  }

  async solve(request: SolveRequest): Promise<SolveResponse> {
    const recorder = new TrajectoryRecorder();
    recorder.userMessage(request.userPrompt, "synthetic_user");

    const runtime = await this.modelRuntime();
    const model = runtime.getModel(request.model.provider, request.model.model);
    if (!model) {
      throw new Error(`pi does not know model "${request.model.provider}/${request.model.model}"`);
    }

    // A throwaway cwd: pi resolves session naming and relative tool paths against it, but every
    // forge tool executes inside the container, so nothing here is ever read or written by the agent.
    const scratch = await mkdtemp(join(tmpdir(), "forge-pi-"));
    const usage: TokenUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0,
      cost_known: modelHasKnownPrice(model),
    };

    let outcome: SolveResponse["outcome"] = "completed";
    let error: string | null = null;

    try {
      const executed = new Map<string, ExecutedTool>();
      const customTools = request.tools.map((tool) => this.wrapTool(tool, request.toolContext, executed));
      const settingsManager = SettingsManager.inMemory({
        // Compaction would rewrite the transcript mid-run and break the correspondence between
        // recorded events and what actually happened.
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 2 },
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd: scratch,
        agentDir: scratch,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPromptOverride: () => request.systemPrompt,
        extensionFactories: [pinSystemPrompt(request.systemPrompt)],
      });
      await resourceLoader.reload();

      const { session } = await createAgentSession({
        cwd: scratch,
        agentDir: scratch,
        model,
        thinkingLevel: request.model.thinking as never,
        modelRuntime: runtime,
        noTools: "all",
        tools: request.tools.map((t) => t.name),
        customTools: customTools as ToolDefinition[],
        resourceLoader,
        sessionManager: SessionManager.inMemory(scratch),
        settingsManager,
      });

      let turns = 0;
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "turn_start") turns++;
      });

      const timer = request.timeoutMs > 0 ? setTimeout(() => void session.abort(), request.timeoutMs) : undefined;
      const onAbort = () => void session.abort();
      request.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        await session.prompt(request.userPrompt);
      } finally {
        if (timer) clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
        unsubscribe();
      }

      if (turns > request.maxTurns) {
        outcome = "aborted";
        error = `agent exceeded the ${request.maxTurns} turn budget (${turns} turns)`;
      }
      if (request.signal?.aborted) {
        outcome = "aborted";
        error = error ?? "cancelled";
      }

      this.collectMessages(session.messages as PiMessage[], recorder, usage, request.decisionSummaries, executed);
    } catch (caught) {
      outcome = "error";
      error = (caught as Error).message;
      this.logger.warn("pi solve failed", { error });
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }

    return {
      events: recorder.all(),
      usage,
      outcome,
      error,
      executionMode: "real_model",
      harness: this.name,
      harnessVersion: `${this.version}/${ADAPTER_VERSION}`,
    };
  }

  /**
   * Bridge one forge tool into a pi tool.
   *
   * Results are captured here, at the moment of execution, so what is stored is exactly what the
   * sandbox returned. They are keyed by tool call id and stitched into the trajectory afterwards
   * in message order: recording directly into the trajectory from here would place every tool
   * event before every assistant message, because pi surfaces assistant prose only once the
   * message completes.
   */
  private wrapTool(tool: ForgeTool, ctx: ToolContext, results: Map<string, ExecutedTool>): ToolDefinition {
    return defineTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as never,
      // pi runs the tool calls of one assistant turn in parallel by default. The trajectory records
      // them in message order and replay re-executes them in that order, so they must also RUN in
      // that order: a test run racing a file edit would record a result no sequential re-execution
      // can reproduce.
      executionMode: "sequential",
      execute: async (toolCallId: string, params: unknown) => {
        let input: unknown;
        try {
          input = tool.parse(params);
        } catch (validationError) {
          const message = `invalid arguments for ${tool.name}: ${(validationError as Error).message}`;
          results.set(toolCallId, {
            name: tool.name,
            input: params,
            output: { error: message },
            text: message,
            isError: true,
            truncated: false,
            fullOutputArtifact: null,
          });
          return { content: [{ type: "text" as const, text: message }], details: {}, isError: true };
        }

        try {
          const result = await tool.execute(input, ctx);
          results.set(toolCallId, {
            name: tool.name,
            input,
            output: result.output,
            text: result.text,
            isError: result.isError,
            truncated: result.truncated,
            fullOutputArtifact: result.fullOutputArtifact,
          });
          return {
            content: [{ type: "text" as const, text: result.text }],
            details: result.output ?? {},
            isError: result.isError,
          };
        } catch (executionError) {
          const message = `${tool.name} failed: ${(executionError as Error).message}`;
          results.set(toolCallId, {
            name: tool.name,
            input,
            output: { error: message },
            text: message,
            isError: true,
            truncated: false,
            fullOutputArtifact: null,
          });
          return { content: [{ type: "text" as const, text: message }], details: {}, isError: true };
        }
      },
    }) as unknown as ToolDefinition;
  }

  /**
   * Assemble the trajectory from pi's message list, in message order.
   *
   * Tool calls come from the assistant messages that issued them; each is immediately followed by
   * the result the sandbox actually produced, looked up by tool call id. Building the stream this
   * way keeps prose, calls and results interleaved exactly as they happened.
   *
   * Provider `thinking` blocks are dropped: private reasoning never enters the dataset.
   */
  private collectMessages(
    messages: readonly PiMessage[],
    recorder: TrajectoryRecorder,
    usage: TokenUsage,
    decisionSummaries: boolean,
    results: ReadonlyMap<string, ExecutedTool>,
  ): void {
    // pi answers some tool calls itself, without executing them: invalid arguments, an unknown
    // tool, or a call cut off by the output-token limit. The model saw those answers, so they are
    // recorded — as harness answers, never as sandbox executions.
    const harnessAnswers = new Map<string, string>();
    for (const message of messages) {
      if (message.role !== "toolResult" || !message.toolCallId) continue;
      const text = (message.content ?? [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n");
      harnessAnswers.set(message.toolCallId, text);
    }

    for (const message of messages) {
      if (message.role !== "assistant") continue;

      if (message.usage) {
        usage.input_tokens += message.usage.input ?? 0;
        usage.output_tokens += message.usage.output ?? 0;
        usage.cache_read_tokens += message.usage.cacheRead ?? 0;
        usage.cache_write_tokens += message.usage.cacheWrite ?? 0;
        if (usage.cost_known && typeof message.usage.cost?.total === "number") {
          usage.cost_usd = (usage.cost_usd ?? 0) + message.usage.cost.total;
        }
      }

      const text = (message.content ?? [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n")
        .trim();

      if (text.length > 0) {
        if (!decisionSummaries) {
          recorder.assistantMessage(text);
        } else {
          const extraction = extractDecisionSummaries(text, recorder.knownIds());
          for (const { summary, raw } of extraction.summaries) recorder.decisionSummary(summary, raw);
          for (const bad of extraction.rejected) {
            // Keep the model's words, but never let a malformed block pass as a validated summary.
            recorder.assistantMessage(bad.raw);
            recorder.annotation(`rejected decision_summary block: ${bad.reason}`);
          }
          if (extraction.remainder.length > 0) recorder.assistantMessage(extraction.remainder);
        }
      }

      for (const part of message.content ?? []) {
        if (part.type !== "toolCall" || !part.id) continue;
        const executed = results.get(part.id);
        const name = executed?.name ?? part.name ?? "<unknown>";
        const input = executed ? executed.input : part.arguments;

        if (name === "ask_user") {
          recorder.userQuestion(part.id, String((input as { question?: string })?.question ?? ""));
          if (executed) recorder.userAnswer(part.id, executed.text);
          else recorder.annotation(`ask_user ${part.id} has no recorded answer`);
          continue;
        }

        recorder.toolCall(part.id, name, input);
        if (!executed) {
          const answer = harnessAnswers.get(part.id);
          if (answer !== undefined) {
            recorder.harnessRejection(part.id, name, answer);
            continue;
          }
          // A call with no result at all means the run was cut short. Saying so is better than
          // inventing an outcome for it.
          recorder.annotation(`tool call ${part.id} (${name}) has no recorded result; the run did not finish it`);
          continue;
        }
        recorder.toolResult(part.id, name, executed.output, {
          isError: executed.isError,
          truncated: executed.truncated,
          fullOutputArtifact: executed.fullOutputArtifact,
          text: executed.text,
        });
      }
    }
    if (!usage.cost_known) usage.cost_usd = null;
  }
}

/** A tool result captured at execution time, awaiting placement in message order. */
interface ExecutedTool {
  name: string;
  input: unknown;
  output: unknown;
  text: string;
  isError: boolean;
  truncated: boolean;
  fullOutputArtifact: string | null;
}

interface PiMessage {
  role: string;
  /** Set on `toolResult` messages. */
  toolCallId?: string;
  content?: Array<{ type: string; text?: string; id?: string; name?: string; arguments?: unknown }>;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  };
}

/**
 * A model whose catalog entry carries no price yields an unknown cost.
 *
 * An explicit zero price (a self-hosted OpenAI-compatible endpoint, for example) is a KNOWN cost
 * of zero, which is different from not knowing the price at all.
 */
function modelHasKnownPrice(model: unknown): boolean {
  const cost = (model as { cost?: Record<string, unknown> }).cost;
  if (!cost || typeof cost !== "object") return false;
  return ["input", "output"].every((key) => typeof cost[key] === "number");
}

export const PI_PACKAGE_VERSION = "0.85.1";

/**
 * Keep the system prompt exactly as written.
 *
 * Pi appends `Current working directory: <cwd>` to every custom system prompt. Here that cwd is a
 * throwaway directory on the HOST, which the agent can never reach: every tool runs inside the
 * container. Left in, it leaks the host path (and user name) into the dataset and sends the agent
 * chasing a directory that does not exist. `before_agent_start` is pi's documented hook for
 * replacing the assembled prompt; inline factories load even with `noExtensions`.
 */
export function pinSystemPrompt(systemPrompt: string): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", () => ({ systemPrompt }));
  };
}

/**
 * Structured single-shot completions through pi.
 *
 * The grader, task generator, task reviewer and user simulator do not need an agent loop; they
 * need one validated JSON answer. Running them through the same adapter keeps a single model
 * path, a single credential path and a single usage ledger.
 */
export class PiModelProvider implements ModelProvider {
  readonly name = "pi";
  private readonly harness: PiHarness;
  private readonly agentDir: string | undefined;
  private runtime: ModelRuntime | undefined;

  constructor(options: { logger: Logger; agentDir?: string }) {
    this.agentDir = options.agentDir;
    this.harness = new PiHarness(options);
  }

  available(model: { provider: string; model: string }): Promise<{ ok: boolean; detail: string }> {
    return this.harness.available(model);
  }

  private async modelRuntime(): Promise<ModelRuntime> {
    if (!this.runtime) {
      this.runtime = await ModelRuntime.create(
        this.agentDir ? { authPath: join(this.agentDir, "auth.json"), modelsPath: join(this.agentDir, "models.json") } : {},
      );
    }
    return this.runtime;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const runtime = await this.modelRuntime();
    const model = runtime.getModel(request.model.provider, request.model.model);
    if (!model) throw new Error(`pi does not know model "${request.model.provider}/${request.model.model}"`);

    const scratch = await mkdtemp(join(tmpdir(), "forge-pi-call-"));
    try {
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2 } });
      const resourceLoader = new DefaultResourceLoader({
        cwd: scratch,
        agentDir: scratch,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPromptOverride: () => request.systemPrompt,
        extensionFactories: [pinSystemPrompt(request.systemPrompt)],
      });
      await resourceLoader.reload();

      const { session } = await createAgentSession({
        cwd: scratch,
        agentDir: scratch,
        model,
        thinkingLevel: request.model.thinking as never,
        modelRuntime: runtime,
        // No tools at all: this call must produce text, not act on anything.
        noTools: "all",
        tools: [],
        resourceLoader,
        sessionManager: SessionManager.inMemory(scratch),
        settingsManager,
      });

      const timer = request.timeoutMs > 0 ? setTimeout(() => void session.abort(), request.timeoutMs) : undefined;
      try {
        await session.prompt(request.userPrompt);
      } finally {
        if (timer) clearTimeout(timer);
      }

      const usage: TokenUsage = {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd: 0,
        cost_known: modelHasKnownPrice(model),
      };
      const texts: string[] = [];
      for (const message of session.messages as unknown as PiMessage[]) {
        if (message.role !== "assistant") continue;
        if (message.usage) {
          usage.input_tokens += message.usage.input ?? 0;
          usage.output_tokens += message.usage.output ?? 0;
          usage.cache_read_tokens += message.usage.cacheRead ?? 0;
          usage.cache_write_tokens += message.usage.cacheWrite ?? 0;
          if (usage.cost_known && typeof message.usage.cost?.total === "number") {
            usage.cost_usd = (usage.cost_usd ?? 0) + message.usage.cost.total;
          }
        }
        for (const part of message.content ?? []) {
          if (part.type === "text" && part.text) texts.push(part.text);
        }
      }
      if (!usage.cost_known) usage.cost_usd = null;

      session.dispose();
      return {
        text: texts.join("\n").trim(),
        usage,
        model: `${request.model.provider}/${request.model.model}`,
        executionMode: "real_model",
      };
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
