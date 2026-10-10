import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExportConfig } from "../config/schema.ts";
import type { EvaluatorManifest, Judgment, Sample, TrajectoryEvent } from "../types/index.ts";
import { Sample as SampleSchema } from "../types/index.ts";
import {
  agentContext,
  openAITools,
  toOpenAIChat,
  toRlRewardSpec,
  toRlTask,
  type OpenAITool,
  type RlLimits,
} from "./formats.ts";

/**
 * Exporters.
 *
 * Views of the same accepted samples:
 *   - `samples.jsonl`         the canonical record, one validated Sample per line
 *   - `conversations.jsonl`   a training view with messages, tool calls and training masks
 *   - `sft-openai.jsonl`      the same trajectories in OpenAI chat format, for SFT/distillation
 *   - `rl-tasks.jsonl`        environments for RL: prompt, tools, image, limits
 *   - `rl-reward-spec.jsonl`  RESERVED: what the reward side needs to score a rollout
 *
 * The evaluator manifest — target SHA, target patch, hidden test ids, grader output — is written
 * to a SEPARATE file that the conversation builder never reads. That separation is the mechanism
 * that stops reserved information from reaching a training message.
 */

export interface ExportOptions {
  outDir: string;
  config: ExportConfig;
  runId: string;
  /** Agent limits written into RL tasks so a rollout runs under the teacher's conditions. */
  rlLimits?: RlLimits;
}

export interface ExportedFile {
  path: string;
  records: number;
  bytes: number;
}

export interface ExportSummary {
  files: ExportedFile[];
  samplesWritten: number;
  splits: Record<string, number>;
  /** Samples produced by a scripted fixture rather than a real model. */
  fixtureProvenance: number;
}

export interface ExportItem {
  sample: Sample;
  manifest: EvaluatorManifest;
  /** LLM-judge verdict on the trajectory, when `forge judge` has run. */
  judgment?: Judgment | null;
}

export async function exportDataset(items: readonly ExportItem[], options: ExportOptions): Promise<ExportSummary> {
  await mkdir(options.outDir, { recursive: true });

  const eligible: ExportItem[] = [];
  let fixtureProvenance = 0;
  for (const item of items) {
    const isFixture = item.sample.agent.execution_mode === "scripted_fixture";
    if (isFixture) fixtureProvenance++;
    if (isFixture && !options.config.allow_fixture_provenance) continue;
    eligible.push(item);
  }

  const files: ExportedFile[] = [];
  const splits: Record<string, number> = {};
  for (const item of eligible) splits[item.sample.split ?? "unassigned"] = (splits[item.sample.split ?? "unassigned"] ?? 0) + 1;

  if (options.config.formats.includes("jsonl")) {
    const lines = eligible.map((item) => JSON.stringify(SampleSchema.parse(item.sample)));
    files.push(await writeJsonl(join(options.outDir, "samples.jsonl"), lines));
  }

  if (options.config.formats.includes("conversations")) {
    const lines = eligible.map((item) => JSON.stringify(toConversation(item.sample, options.config, item.judgment ?? null)));
    files.push(await writeJsonl(join(options.outDir, "conversations.jsonl"), lines));
  }

  if (options.config.formats.includes("openai_chat")) {
    const lines = eligible.map((item) =>
      JSON.stringify(
        toOpenAIChat(item.sample, { includeDecisionSummaries: options.config.include_decision_summaries }, item.judgment ?? null),
      ),
    );
    files.push(await writeJsonl(join(options.outDir, "sft-openai.jsonl"), lines));
  }

  if (options.config.formats.includes("rl_tasks")) {
    const limits: RlLimits = options.rlLimits ?? {
      max_turns: 60,
      max_user_questions: 2,
      command_timeout_seconds: 300,
      task_timeout_seconds: 1200,
      network: false,
      run_as: "1000:1000",
    };
    files.push(
      await writeJsonl(
        join(options.outDir, "rl-tasks.jsonl"),
        eligible.map((item) => JSON.stringify(toRlTask(item.sample, limits))),
      ),
    );
    // Reserved, like the evaluator manifest: built from the manifest, never by the task builder.
    files.push(
      await writeJsonl(
        join(options.outDir, "rl-reward-spec.jsonl"),
        eligible.map((item) => JSON.stringify(toRlRewardSpec(item.sample, item.manifest))),
      ),
    );
  }

  // Always written, always separate, never consumed by the conversation builder.
  const manifestLines = eligible.map((item) =>
    JSON.stringify({ sample_id: item.sample.sample_id, ...item.manifest }),
  );
  files.push(await writeJsonl(join(options.outDir, "evaluator-manifest.jsonl"), manifestLines));

  const readme = buildReadme(options, eligible, fixtureProvenance);
  await writeFile(join(options.outDir, "README.md"), readme, "utf8");
  files.push({ path: join(options.outDir, "README.md"), records: 1, bytes: Buffer.byteLength(readme) });

  return { files, samplesWritten: eligible.length, splits, fixtureProvenance };
}

async function writeJsonl(path: string, lines: readonly string[]): Promise<ExportedFile> {
  const body = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  await writeFile(path, body, "utf8");
  return { path, records: lines.length, bytes: Buffer.byteLength(body) };
}

// ---------------------------------------------------------------------------
// Conversation view
// ---------------------------------------------------------------------------

export interface ConversationMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; name: string; arguments: unknown }>;
  tool_call_id?: string;
  /** `pipeline` marks the system prompt, which the pipeline wrote rather than any model or tool. */
  origin: TrajectoryEvent["origin"] | "pipeline";
  /**
   * Training mask. `true` means the message is a target the model should learn to produce.
   * User messages and tool outputs are context, never targets.
   */
  train: boolean;
}

export interface Conversation {
  sample_id: string;
  split: string | null;
  task_type: string;
  messages: ConversationMessage[];
  /** The tools the agent could call, as it saw them. */
  tools: OpenAITool[];
  metadata: {
    repository_family: string;
    model: string;
    execution_mode: string;
    exact_tree_match: boolean;
    behavioral_checks_passed: boolean;
    replay_passed: boolean;
    includes_decision_summaries: boolean;
    judge_score: number | null;
  };
}

/**
 * Build the training view.
 *
 * Reads only `sample`, never the evaluator manifest. Post-hoc annotations are excluded from the
 * conversation flow unless explicitly enabled, and even then they are never training targets.
 */
export function toConversation(sample: Sample, config: ExportConfig, judgment: Judgment | null = null): Conversation {
  const context = agentContext(sample);
  const messages: ConversationMessage[] = [
    { role: "system", content: context.systemPrompt, origin: "pipeline", train: false },
  ];

  for (const event of sample.events) {
    if (event.origin === "posthoc_annotation" && !config.include_posthoc_annotations) continue;

    switch (event.type) {
      case "user_message":
      case "user_answer":
        messages.push({ role: "user", content: event.text ?? "", origin: event.origin, train: false });
        break;

      case "assistant_message":
        messages.push({ role: "assistant", content: event.text ?? "", origin: event.origin, train: true });
        break;

      case "decision_summary":
        if (!config.include_decision_summaries) break;
        messages.push({
          role: "assistant",
          content: JSON.stringify(event.decision_summary),
          origin: event.origin,
          train: true,
        });
        break;

      case "user_question":
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [{ id: event.tool_call_id ?? "", name: "ask_user", arguments: { question: event.text ?? "" } }],
          origin: event.origin,
          train: true,
        });
        break;

      case "tool_call":
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [
            { id: event.tool_call_id ?? "", name: event.tool_name ?? "", arguments: event.tool_input },
          ],
          origin: event.origin,
          train: true,
        });
        break;

      case "tool_result":
        messages.push({
          role: "tool",
          content: event.text ?? "",
          tool_call_id: event.tool_call_id ?? "",
          origin: event.origin,
          train: false,
        });
        break;

      case "annotation":
        messages.push({ role: "system", content: event.text ?? "", origin: event.origin, train: false });
        break;
    }
  }

  return {
    sample_id: sample.sample_id,
    split: sample.split,
    task_type: sample.task.task_type,
    messages,
    tools: openAITools(context.tools),
    metadata: {
      repository_family: sample.source.repository_family,
      model: sample.agent.model,
      execution_mode: sample.agent.execution_mode,
      exact_tree_match: sample.verification.exact_tree_match,
      behavioral_checks_passed: sample.verification.behavioral_checks_passed,
      replay_passed: sample.verification.replay_passed,
      includes_decision_summaries: config.include_decision_summaries,
      judge_score: judgment?.score ?? null,
    },
  };
}

function buildReadme(options: ExportOptions, items: readonly ExportItem[], fixtureCount: number): string {
  const byLicense = new Map<string, number>();
  for (const item of items) {
    const key = `${item.sample.source.license ?? "unknown"} (${item.sample.source.license_source})`;
    byLicense.set(key, (byLicense.get(key) ?? 0) + 1);
  }
  const realCount = items.filter((i) => i.sample.agent.execution_mode === "real_model").length;

  return `# commit-trace-forge export

Run: \`${options.runId}\`
Generated: ${new Date().toISOString()}
Samples: ${items.length} (${realCount} from real model execution${
    items.length - realCount > 0 ? `, ${items.length - realCount} from a scripted fixture harness` : ""
  })

## Files

- \`samples.jsonl\` — canonical records, one per line, validated against the \`${items[0]?.sample.schema_version ?? "commit-trace-forge/1"}\` schema.
- \`conversations.jsonl\` — training view with tool calls and a per-message \`train\` mask.
  User messages and tool outputs carry \`train: false\`: they are context, not targets.
- \`sft-openai.jsonl\` — the same trajectories in OpenAI chat format, with the system prompt, the
  tool definitions and \`weight: 1\` on assistant turns only. Ready for supervised fine-tuning.
- \`rl-tasks.jsonl\` — one RL environment per task: prompt, tools, container image and limits.
- \`rl-reward-spec.jsonl\` — **reserved**. What the reward side needs (hidden tests, acceptance
  criteria, reference tree). Never show it to the policy.
- \`evaluator-manifest.jsonl\` — **reserved**. Target SHAs, target patches, hidden test ids and
  grader output. Never feed this file into training.

## Provenance

Synthetic text — the user request, clarification answers, decision summaries — was generated by a
model and is labelled with \`origin\` on every event. Tool results, file changes and test outcomes
come from real execution inside a sandbox; none of them were written by a model.

${fixtureCount > 0
  ? `${fixtureCount} sample(s) came from the scripted fixture harness, where the tool execution is real but no model was called. ` +
    (options.config.allow_fixture_provenance
      ? "They are included because `export.allow_fixture_provenance` is enabled, and are marked `execution_mode: scripted_fixture`."
      : "They were EXCLUDED from this export.")
  : "Every exported sample came from real model execution."}

## Licensing

${[...byLicense.entries()].map(([license, count]) => `- ${license}: ${count} sample(s)`).join("\n") || "- (no samples)"}

A license shown as \`unknown\` was not positively identified. A public repository does not by
itself authorise any particular use; review before redistributing.

## Contamination

${
  options.config.benchmark_exclusion_list.length > 0
    ? `A benchmark exclusion list with ${options.config.benchmark_exclusion_list.length} entries was applied.`
    : "No benchmark exclusion list was configured."
} An exclusion list is not a guarantee of absence of contamination: it only removes what it names.

Splits are assigned per repository family, so variants of the same task cannot cross splits.
`;
}
