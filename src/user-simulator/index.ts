import type { TaskSpec } from "../types/index.ts";
import type { ModelProvider } from "../harness/types.ts";
import type { Store } from "../storage/state.ts";
import { loadPrompt } from "../prompts.ts";
import type { Logger } from "../util/logger.ts";

/**
 * Simulated user behind the `ask_user` tool.
 *
 * The simulator runs in its own model call with a deliberately narrow view. It receives only:
 *   - the initial request
 *   - the reviewed `user_fact_sheet`
 *   - the question
 *   - the visible conversation so far
 *
 * It never receives the target patch, the target SHA, the acceptance criteria internals beyond
 * the fact sheet, or any evaluator output. It therefore cannot steer the solver toward the
 * historical patch, because it has never seen it.
 */
export interface UserSimulatorOptions {
  task: TaskSpec;
  provider: ModelProvider;
  model: { provider: string; model: string; thinking: string };
  maxQuestions: number;
  timeoutMs: number;
  store: Store;
  candidateId: string;
  logger: Logger;
}

export interface RecordedAnswer {
  question: string;
  answer: string;
  origin: "synthetic_user";
}

export class UserSimulator {
  private readonly options: UserSimulatorOptions;
  private readonly transcript: Array<{ role: "user" | "assistant"; text: string }> = [];
  private readonly answers: RecordedAnswer[] = [];

  constructor(options: UserSimulatorOptions) {
    this.options = options;
    this.transcript.push({ role: "user", text: options.task.user_prompt });
  }

  get asked(): number {
    return this.answers.length;
  }

  recorded(): RecordedAnswer[] {
    return [...this.answers];
  }

  /** Note a visible assistant message so the simulator sees the same conversation the solver does. */
  observeAssistant(text: string): void {
    this.transcript.push({ role: "assistant", text });
  }

  async ask(question: string): Promise<string> {
    if (this.answers.length >= this.options.maxQuestions) {
      const answer =
        "I have already answered as much as I can. Please proceed with your best judgement based on what I described.";
      this.answers.push({ question, answer, origin: "synthetic_user" });
      return answer;
    }

    const prompt = loadPrompt("user_simulator");
    const factSheet = this.options.task.user_fact_sheet
      .map((f) => `- ${f.topic}: ${f.fact}`)
      .join("\n");
    const conversation = this.transcript
      .map((m) => `${m.role === "user" ? "You" : "Engineer"}: ${m.text}`)
      .join("\n\n");

    const userPrompt = [
      "## Your original request",
      this.options.task.user_prompt,
      "",
      "## What you know",
      factSheet.length > 0 ? factSheet : "(nothing beyond your original request)",
      "",
      "## Conversation so far",
      conversation,
      "",
      "## The engineer asks",
      question,
      "",
      "Answer in English, briefly.",
    ].join("\n");

    const started = Date.now();
    const response = await this.options.provider.complete({
      role: "user_simulator",
      systemPrompt: prompt.text,
      userPrompt,
      model: this.options.model,
      timeoutMs: this.options.timeoutMs,
    });
    this.options.store.recordUsage(
      this.options.candidateId,
      "user_simulator",
      response.model,
      response.usage,
      Date.now() - started,
    );

    const answer = response.text.trim() ||
      "I am not sure about that detail; use whatever is most consistent with what I already described.";
    this.transcript.push({ role: "assistant", text: question });
    this.transcript.push({ role: "user", text: answer });
    this.answers.push({ question, answer, origin: "synthetic_user" });
    return answer;
  }
}

/**
 * Replay-time user: returns the answers recorded during the original run, matched by question.
 *
 * Replay must reuse the recorded answers rather than asking the simulator again; otherwise a
 * differently-worded answer would look like a divergence caused by the agent.
 */
export class RecordedUser {
  private readonly byQuestion: Map<string, string>;
  private readonly ordered: RecordedAnswer[];
  private cursor = 0;
  private readonly misses: string[] = [];

  constructor(answers: readonly RecordedAnswer[]) {
    this.ordered = [...answers];
    this.byQuestion = new Map(answers.map((a) => [normalise(a.question), a.answer]));
  }

  get unmatchedQuestions(): string[] {
    return [...this.misses];
  }

  async ask(question: string): Promise<string> {
    const exact = this.byQuestion.get(normalise(question));
    if (exact !== undefined) return exact;
    // Fall back to positional order, and record that the wording diverged so the replay
    // comparison can flag it instead of silently accepting a different conversation.
    const next = this.ordered[this.cursor];
    this.cursor++;
    this.misses.push(question);
    return next?.answer ?? "No further information is available.";
  }
}

function normalise(question: string): string {
  return question.trim().toLowerCase().replace(/\s+/g, " ");
}
