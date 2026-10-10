import { loadPrompt } from "../prompts.ts";
import { toolSchemas, toolsFor } from "../harness/tools.ts";
import type {
  EvaluatorManifest,
  Judgment,
  Sample,
  ToolSchema,
  TrajectoryEvent,
} from "../types/index.ts";

/**
 * Trainer-facing views of a verified sample.
 *
 *   - OpenAI chat format, for supervised fine-tuning / distillation: the exact system prompt and
 *     tool definitions the teacher acted under, then the trajectory, with `weight: 1` on every
 *     assistant turn and nothing else marked as a target.
 *   - RL task + reward spec, for reinforcement learning: what the policy may see, and — in a
 *     separate record — what the reward side needs. The split mirrors the evaluator manifest:
 *     nothing that identifies the historical solution is ever written into the policy-side record.
 */

// ---------------------------------------------------------------------------
// Agent context
// ---------------------------------------------------------------------------

export interface AgentContext {
  systemPrompt: string;
  systemPromptVersion: string;
  tools: ToolSchema[];
  /** True when the record predates these fields and the current prompt/tools were substituted. */
  reconstructed: boolean;
}

/**
 * The system prompt and tools the agent was given.
 *
 * Read from the sample when recorded. Older records did not store them; the prompt is then loaded
 * by the version the pipeline uses today and the result says it was reconstructed.
 */
export function agentContext(sample: Sample): AgentContext {
  const agent = sample.agent;
  if (agent.system_prompt && agent.tool_schemas.length > 0) {
    return {
      systemPrompt: agent.system_prompt,
      systemPromptVersion: agent.system_prompt_version ?? "unknown",
      tools: agent.tool_schemas,
      reconstructed: false,
    };
  }
  const prompt = loadPrompt("solver");
  const names = new Set(agent.tool_names);
  return {
    systemPrompt: prompt.text,
    systemPromptVersion: prompt.version,
    tools: toolSchemas(toolsFor({ allowAskUser: true }).filter((t) => names.has(t.name))),
    reconstructed: true,
  };
}

// ---------------------------------------------------------------------------
// OpenAI chat format (SFT / distillation)
// ---------------------------------------------------------------------------

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[]; weight: 0 | 1 }
  | { role: "tool"; tool_call_id: string; content: string };

export interface OpenAITool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface OpenAIChatOptions {
  includeDecisionSummaries: boolean;
}

export interface OpenAIChatResult {
  messages: OpenAIMessage[];
  /** Tool calls the run never finished; left out so every call in the view has its real result. */
  droppedToolCalls: string[];
}

/**
 * Convert a trajectory into OpenAI chat messages.
 *
 * Assistant text and the tool calls that follow it become one assistant message, as a chat model
 * emits them. `ask_user` is a tool like any other: its answer comes back as a tool message.
 * Post-hoc annotations never appear. A tool call with no recorded result is dropped rather than
 * paired with an invented one.
 */
export function eventsToOpenAI(
  events: readonly TrajectoryEvent[],
  context: { systemPrompt: string },
  options: OpenAIChatOptions,
): OpenAIChatResult {
  const messages: OpenAIMessage[] = [{ role: "system", content: context.systemPrompt }];
  const answered = new Set(
    events
      .filter((e) => (e.type === "tool_result" || e.type === "user_answer") && e.tool_call_id)
      .map((e) => e.tool_call_id as string),
  );
  const dropped: string[] = [];

  let text: string[] = [];
  let calls: OpenAIToolCall[] = [];
  const flush = () => {
    if (text.length === 0 && calls.length === 0) return;
    const message: OpenAIMessage = {
      role: "assistant",
      content: text.length > 0 ? text.join("\n\n") : null,
      weight: 1,
    };
    if (calls.length > 0) message.tool_calls = calls;
    messages.push(message);
    text = [];
    calls = [];
  };

  for (const event of events) {
    if (event.origin === "posthoc_annotation") continue;
    switch (event.type) {
      case "user_message":
        flush();
        messages.push({ role: "user", content: event.text ?? "" });
        break;

      case "assistant_message":
        // Text after tool calls starts a new turn: the model wrote it after seeing their results.
        if (calls.length > 0) flush();
        if (event.text) text.push(event.text);
        break;

      case "decision_summary":
        if (!options.includeDecisionSummaries || !event.decision_summary) break;
        if (calls.length > 0) flush();
        text.push("```decision_summary\n" + JSON.stringify(event.decision_summary, null, 2) + "\n```");
        break;

      case "tool_call":
      case "user_question": {
        const id = event.tool_call_id ?? "";
        if (!answered.has(id)) {
          dropped.push(id);
          break;
        }
        const name = event.type === "user_question" ? "ask_user" : (event.tool_name ?? "");
        const args = event.type === "user_question" ? { question: event.text ?? "" } : event.tool_input;
        calls.push({ id, type: "function", function: { name, arguments: JSON.stringify(args ?? {}) } });
        break;
      }

      case "tool_result":
      case "user_answer":
        flush();
        messages.push({ role: "tool", tool_call_id: event.tool_call_id ?? "", content: event.text ?? "" });
        break;

      case "annotation":
        break;
    }
  }
  flush();
  return { messages, droppedToolCalls: dropped };
}

export function openAITools(tools: readonly ToolSchema[]): OpenAITool[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export interface OpenAIChatRecord {
  messages: OpenAIMessage[];
  tools: OpenAITool[];
  metadata: {
    sample_id: string;
    split: string | null;
    task_type: string;
    repository_family: string;
    teacher_model: string;
    execution_mode: string;
    system_prompt_version: string;
    system_prompt_reconstructed: boolean;
    behavioral_checks_passed: boolean;
    exact_tree_match: boolean;
    replay_passed: boolean;
    judge_score: number | null;
    dropped_tool_calls: string[];
  };
}

export function toOpenAIChat(
  sample: Sample,
  options: OpenAIChatOptions,
  judgment: Judgment | null = null,
): OpenAIChatRecord {
  const context = agentContext(sample);
  const { messages, droppedToolCalls } = eventsToOpenAI(sample.events, context, options);
  return {
    messages,
    tools: openAITools(context.tools),
    metadata: {
      sample_id: sample.sample_id,
      split: sample.split,
      task_type: sample.task.task_type,
      repository_family: sample.source.repository_family,
      teacher_model: sample.agent.model,
      execution_mode: sample.agent.execution_mode,
      system_prompt_version: context.systemPromptVersion,
      system_prompt_reconstructed: context.reconstructed,
      behavioral_checks_passed: sample.verification.behavioral_checks_passed,
      exact_tree_match: sample.verification.exact_tree_match,
      replay_passed: sample.verification.replay_passed,
      judge_score: judgment?.score ?? null,
      dropped_tool_calls: droppedToolCalls,
    },
  };
}

// ---------------------------------------------------------------------------
// RL task and reward spec
// ---------------------------------------------------------------------------

export interface RlLimits {
  max_turns: number;
  max_user_questions: number;
  command_timeout_seconds: number;
  task_timeout_seconds: number;
  network: boolean;
  run_as: string;
}

/** What a policy may see. Contains nothing that identifies the historical solution. */
export interface RlTask {
  task_id: string;
  split: string | null;
  task_type: string;
  prompt: { system: string; user: string };
  tools: OpenAITool[];
  environment: {
    image_ref: string;
    image_digest: string | null;
    recipe_hash: string;
    ecosystem: string;
    workdir: string;
  };
  limits: RlLimits;
  repository_family: string;
  license: string | null;
}

/**
 * What the reward side needs. RESERVED: like the evaluator manifest, never shown to the policy.
 * `forge score` and `forge rollout` read the same information from the workspace database.
 */
export interface RlRewardSpec {
  task_id: string;
  acceptance_criteria: string[];
  /** Facts the simulated user may reveal if the policy calls `ask_user`. */
  user_fact_sheet: Array<{ topic: string; fact: string }>;
  fail_to_pass: string[];
  pass_to_pass: string[];
  hidden_test_paths: string[];
  target_tree_sha: string;
  target_patch_artifact: string | null;
  /** The teacher's verified solution, usable as a reference trajectory for comparison. */
  reference_result_tree_sha: string | null;
}

export function toRlTask(sample: Sample, limits: RlLimits): RlTask {
  const context = agentContext(sample);
  return {
    task_id: sample.sample_id,
    split: sample.split,
    task_type: sample.task.task_type,
    prompt: { system: context.systemPrompt, user: sample.task.user_prompt },
    tools: openAITools(context.tools),
    environment: {
      image_ref: sample.environment.image_ref,
      image_digest: sample.environment.image_digest,
      recipe_hash: sample.environment.recipe_hash,
      ecosystem: sample.environment.ecosystem,
      workdir: sample.environment.workdir,
    },
    limits,
    repository_family: sample.source.repository_family,
    license: sample.source.license,
  };
}

export function toRlRewardSpec(sample: Sample, manifest: EvaluatorManifest): RlRewardSpec {
  const accepted = sample.attempts[sample.accepted_attempt_index];
  return {
    task_id: sample.sample_id,
    acceptance_criteria: sample.task.acceptance_criteria,
    user_fact_sheet: sample.task.user_fact_sheet,
    fail_to_pass: manifest.environment?.fail_to_pass ?? [],
    pass_to_pass: manifest.environment?.pass_to_pass ?? [],
    hidden_test_paths: manifest.hidden_test_ids,
    target_tree_sha: manifest.target_tree_sha,
    target_patch_artifact: manifest.target_patch_artifact,
    reference_result_tree_sha: accepted?.result_tree_sha ?? null,
  };
}
