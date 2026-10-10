import { TrajectoryEvent } from "../types/index.ts";

/**
 * Import a trajectory produced outside forge, so `forge score` can reward it.
 *
 * Accepts either forge's own event stream (`{"events": [...]}`) or OpenAI chat messages
 * (`{"messages": [...]}`, as written to sft-openai.jsonl or produced by any OpenAI-compatible
 * agent loop). Tool calls must use the forge tool names and argument schemas; their supplied
 * results are kept only to be compared against re-execution, never trusted.
 */

export interface ImportedTrajectory {
  taskId: string | null;
  events: TrajectoryEvent[];
  format: "forge_events" | "openai_messages";
}

export function importTrajectory(raw: unknown): ImportedTrajectory {
  if (!raw || typeof raw !== "object") throw new Error("trajectory must be a JSON object");
  const record = raw as Record<string, unknown>;
  const taskId =
    typeof record.task_id === "string"
      ? record.task_id
      : typeof record.sample_id === "string"
        ? record.sample_id
        : typeof (record.metadata as Record<string, unknown> | undefined)?.sample_id === "string"
          ? ((record.metadata as Record<string, unknown>).sample_id as string)
          : null;

  if (Array.isArray(record.events)) {
    return { taskId, events: record.events.map((e) => TrajectoryEvent.parse(e)), format: "forge_events" };
  }
  if (Array.isArray(record.messages)) {
    return { taskId, events: openAIToEvents(record.messages), format: "openai_messages" };
  }
  throw new Error('trajectory has neither "events" (forge format) nor "messages" (OpenAI chat format)');
}

interface RawMessage {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>;
  tool_call_id?: string;
}

export function openAIToEvents(messages: readonly unknown[]): TrajectoryEvent[] {
  const events: TrajectoryEvent[] = [];
  const askUserIds = new Set<string>();
  const timestamp = new Date().toISOString();

  const push = (partial: Partial<TrajectoryEvent> & Pick<TrajectoryEvent, "role" | "type" | "origin">) => {
    const seq = events.length;
    events.push(
      TrajectoryEvent.parse({
        event_id: `event_${String(seq).padStart(4, "0")}`,
        seq,
        timestamp,
        ...partial,
      }),
    );
  };

  for (const value of messages) {
    const m = value as RawMessage;
    const text = contentText(m.content);
    switch (m.role) {
      case "system":
        break;
      case "user":
        push({ role: "user", type: "user_message", origin: "synthetic_user", text });
        break;
      case "assistant":
        if (text) push({ role: "assistant", type: "assistant_message", origin: "model_generated", text });
        for (const call of m.tool_calls ?? []) {
          const id = call.id ?? `call_${events.length}`;
          const name = call.function?.name ?? "";
          const args = parseArguments(call.function?.arguments);
          if (name === "ask_user") {
            askUserIds.add(id);
            const question = (args as { question?: unknown }).question;
            push({ role: "assistant", type: "user_question", origin: "model_generated", tool_call_id: id, text: String(question ?? "") });
          } else {
            push({ role: "assistant", type: "tool_call", origin: "model_generated", tool_call_id: id, tool_name: name, tool_input: args });
          }
        }
        break;
      case "tool": {
        const id = m.tool_call_id ?? "";
        if (askUserIds.has(id)) {
          push({ role: "user", type: "user_answer", origin: "synthetic_user", tool_call_id: id, text });
        } else {
          push({ role: "tool", type: "tool_result", origin: "executed_tool", tool_call_id: id, text });
        }
        break;
      }
      default:
        throw new Error(`unsupported message role: ${String(m.role)}`);
    }
  }
  return events;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
      .join("\n");
  }
  return "";
}

function parseArguments(args: unknown): unknown {
  if (typeof args !== "string") return args ?? {};
  try {
    return JSON.parse(args) as unknown;
  } catch {
    throw new Error(`tool call arguments are not valid JSON: ${args.slice(0, 120)}`);
  }
}
