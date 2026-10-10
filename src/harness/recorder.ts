import { z } from "zod";
import { DecisionSummary, type EventOrigin, type TrajectoryEvent } from "../types/index.ts";

/**
 * Builds the ordered event stream of a solve attempt.
 *
 * Ids are assigned here so that a tool call and its result always share `tool_call_id`, and so a
 * decision summary can cite the ids of evidence that already exists. Nothing is appended that did
 * not actually happen.
 */
type EventInput = Pick<TrajectoryEvent, "role" | "type" | "origin"> &
  Partial<Omit<TrajectoryEvent, "event_id" | "seq" | "role" | "type" | "origin">>;

export class TrajectoryRecorder {
  private readonly events: TrajectoryEvent[] = [];
  private seq = 0;

  private nextId(): string {
    return `event_${String(this.seq).padStart(4, "0")}`;
  }

  private push(event: EventInput): TrajectoryEvent {
    const full: TrajectoryEvent = {
      event_id: this.nextId(),
      seq: this.seq,
      timestamp: event.timestamp ?? new Date().toISOString(),
      role: event.role,
      type: event.type,
      origin: event.origin,
      text: event.text ?? null,
      tool_call_id: event.tool_call_id ?? null,
      tool_name: event.tool_name ?? null,
      tool_input: event.tool_input ?? null,
      tool_output: event.tool_output ?? null,
      tool_is_error: event.tool_is_error ?? null,
      truncated: event.truncated ?? false,
      full_output_artifact: event.full_output_artifact ?? null,
      decision_summary: event.decision_summary ?? null,
    };
    this.seq++;
    this.events.push(full);
    return full;
  }

  userMessage(text: string, origin: EventOrigin = "synthetic_user"): TrajectoryEvent {
    return this.push({ role: "user", type: "user_message", origin, text });
  }

  assistantMessage(text: string): TrajectoryEvent {
    return this.push({ role: "assistant", type: "assistant_message", origin: "model_generated", text });
  }

  decisionSummary(summary: DecisionSummary, rawText: string): TrajectoryEvent {
    return this.push({
      role: "assistant",
      type: "decision_summary",
      origin: "model_generated",
      text: rawText,
      decision_summary: summary,
    });
  }

  toolCall(toolCallId: string, name: string, input: unknown): TrajectoryEvent {
    return this.push({
      role: "assistant",
      type: "tool_call",
      origin: "model_generated",
      tool_call_id: toolCallId,
      tool_name: name,
      tool_input: input,
    });
  }

  toolResult(
    toolCallId: string,
    name: string,
    output: unknown,
    options: { isError: boolean; truncated: boolean; fullOutputArtifact: string | null; text: string },
  ): TrajectoryEvent {
    return this.push({
      role: "tool",
      type: "tool_result",
      origin: "executed_tool",
      tool_call_id: toolCallId,
      tool_name: name,
      tool_output: output,
      tool_is_error: options.isError,
      truncated: options.truncated,
      full_output_artifact: options.fullOutputArtifact,
      text: options.text,
    });
  }

  /** A tool call the harness refused without executing anything; see the `harness` origin. */
  harnessRejection(toolCallId: string, name: string, text: string): TrajectoryEvent {
    return this.push({
      role: "tool",
      type: "tool_result",
      origin: "harness",
      tool_call_id: toolCallId,
      tool_name: name,
      tool_output: { error: text, not_executed: true },
      tool_is_error: true,
      truncated: false,
      full_output_artifact: null,
      text,
    });
  }

  userQuestion(toolCallId: string, question: string): TrajectoryEvent {
    return this.push({
      role: "assistant",
      type: "user_question",
      origin: "model_generated",
      tool_call_id: toolCallId,
      text: question,
    });
  }

  userAnswer(toolCallId: string, answer: string): TrajectoryEvent {
    return this.push({
      role: "user",
      type: "user_answer",
      origin: "synthetic_user",
      tool_call_id: toolCallId,
      text: answer,
    });
  }

  /** Annotations added after the fact. Excluded from the original conversation flow on export. */
  annotation(text: string): TrajectoryEvent {
    return this.push({ role: "system", type: "annotation", origin: "posthoc_annotation", text });
  }

  all(): TrajectoryEvent[] {
    return [...this.events];
  }

  lastEventId(): string | null {
    const last = this.events[this.events.length - 1];
    return last ? last.event_id : null;
  }

  /** Ids of events that already exist, for validating `evidence_event_ids`. */
  knownIds(): Set<string> {
    return new Set(this.events.map((e) => e.event_id));
  }
}

// ---------------------------------------------------------------------------
// Decision summaries
// ---------------------------------------------------------------------------

const SUMMARY_BLOCK = /```decision_summary\s*\n([\s\S]*?)\n?```/g;

export const MIN_SUMMARY_WORDS = 30;
export const MAX_SUMMARY_WORDS = 90;

export interface SummaryExtraction {
  summaries: Array<{ summary: DecisionSummary; raw: string }>;
  /** Text with the summary blocks removed, i.e. what is left as plain assistant prose. */
  remainder: string;
  /** Blocks that looked like a summary but failed validation, with the reason. */
  rejected: Array<{ raw: string; reason: string }>;
}

function wordCount(summary: DecisionSummary): number {
  return [summary.observation, summary.action, summary.verification]
    .join(" ")
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

/**
 * Extract decision summaries from assistant text.
 *
 * A block is accepted only when it validates against the schema, stays within the word budget and
 * cites evidence ids that already exist. A block that fails any of these is NOT silently repaired
 * or dropped: it is reported, and the raw text stays in the transcript as ordinary prose.
 */
export function extractDecisionSummaries(text: string, knownEventIds: ReadonlySet<string>): SummaryExtraction {
  const summaries: SummaryExtraction["summaries"] = [];
  const rejected: SummaryExtraction["rejected"] = [];
  let remainder = text;

  SUMMARY_BLOCK.lastIndex = 0;
  const matches = [...text.matchAll(SUMMARY_BLOCK)];
  for (const match of matches) {
    const raw = match[0];
    const body = match[1] ?? "";
    remainder = remainder.replace(raw, "").trim();

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(body);
    } catch (error) {
      rejected.push({ raw, reason: `not valid JSON: ${(error as Error).message}` });
      continue;
    }
    const parsed = DecisionSummary.safeParse(parsedJson);
    if (!parsed.success) {
      rejected.push({ raw, reason: `schema violation: ${parsed.error.issues.map((i) => i.message).join("; ")}` });
      continue;
    }
    const words = wordCount(parsed.data);
    if (words < MIN_SUMMARY_WORDS || words > MAX_SUMMARY_WORDS) {
      rejected.push({ raw, reason: `${words} words, outside the ${MIN_SUMMARY_WORDS}-${MAX_SUMMARY_WORDS} range` });
      continue;
    }
    const unknown = parsed.data.evidence_event_ids.filter((id) => !knownEventIds.has(id));
    if (unknown.length > 0) {
      rejected.push({ raw, reason: `cites evidence that does not exist: ${unknown.join(", ")}` });
      continue;
    }
    summaries.push({ summary: parsed.data, raw });
  }

  return { summaries, remainder: remainder.trim(), rejected };
}

/** Provider reasoning blocks are never part of the dataset. */
export const ExcludedContent = z.object({ type: z.literal("thinking") });
