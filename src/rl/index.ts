import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pipeline, PipelineContext } from "../pipeline.ts";
import { modelForRole } from "../config/schema.ts";
import type { CandidateRow } from "../storage/state.ts";
import { shortId } from "../util/hash.ts";
import { CancelledError } from "../util/errors.ts";
import { agentContext, eventsToOpenAI, openAITools, type OpenAIMessage } from "../dataset/formats.ts";
import { groupAdvantages } from "../rewards/index.ts";
import {
  DATASET_SCHEMA_VERSION,
  Judgment,
  Rollout,
  type EvaluatorManifest,
  type Sample,
  type TrajectoryEvent,
} from "../types/index.ts";

/**
 * Reinforcement-learning and evaluation layer over verified tasks.
 *
 *   - judgeSamples:  score the accepted teacher trajectories with the LLM judge, so an SFT set can
 *                    be filtered or weighted by process quality, not only by passing tests
 *   - runRollouts:   run a policy model N times per task from the same starting state, verify each
 *                    result against the hidden tests, judge it, and compute its reward
 *   - scoreExternal: the same scoring for a trajectory produced by any other agent loop, after
 *                    re-executing its tool calls; this is what an external RL trainer calls
 */

export interface TaskRef {
  sample: Sample;
  manifest: EvaluatorManifest;
  candidate: CandidateRow;
  split: Sample["split"];
}

export function loadTasks(ctx: PipelineContext, filter: { sampleIds?: readonly string[]; splits?: readonly string[] } = {}): TaskRef[] {
  const tasks: TaskRef[] = [];
  for (const row of ctx.store.listSamples(true)) {
    if (filter.sampleIds && filter.sampleIds.length > 0 && !filter.sampleIds.includes(row.sample_id)) continue;
    const split = (row.split ?? (row.sample as Sample).split ?? null) as Sample["split"];
    if (filter.splits && filter.splits.length > 0 && (!split || !filter.splits.includes(split))) continue;
    const candidate = ctx.store.getCandidate(row.candidate_id);
    if (!candidate) continue;
    tasks.push({ sample: row.sample as Sample, manifest: row.manifest as EvaluatorManifest, candidate, split });
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// Judging teacher trajectories
// ---------------------------------------------------------------------------

export interface JudgeSummary {
  judged: Array<{ sampleId: string; score: number; flags: string[] }>;
  failed: Array<{ sampleId: string; error: string }>;
  skipped: number;
}

export async function judgeSamples(
  ctx: PipelineContext,
  pipeline: Pipeline,
  options: { sampleIds?: readonly string[]; force: boolean },
): Promise<JudgeSummary> {
  const existing = ctx.store.listJudgments();
  const summary: JudgeSummary = { judged: [], failed: [], skipped: 0 };

  for (const task of loadTasks(ctx, { sampleIds: options.sampleIds })) {
    if (ctx.signal?.aborted) throw new CancelledError();
    if (!options.force && existing.has(task.sample.sample_id)) {
      summary.skipped++;
      continue;
    }
    const attempt = task.sample.attempts[task.sample.accepted_attempt_index];
    const patch = attempt?.solution_patch_artifact
      ? (await ctx.artifacts.get(attempt.solution_patch_artifact)).toString("utf8")
      : "";
    const behavioral = task.sample.verification.behavioral;
    try {
      const judgment = await pipeline.judge(task.candidate, {
        task: task.sample.task,
        events: task.sample.events,
        solutionPatch: patch,
        verifiable: {
          tests_passed: task.sample.verification.behavioral_checks_passed,
          fail_to_pass_satisfied: behavioral?.fail_to_pass_satisfied.length ?? 0,
          fail_to_pass_total: task.manifest.environment?.fail_to_pass.length ?? 0,
          regressions: behavioral?.regressions.length ?? 0,
          visible_tests_tampered: behavioral?.visible_tests_tampered ?? false,
          visible_tests_deleted: behavioral?.tampered_paths.some((p) => p.endsWith("(deleted)")) ?? false,
          exact_tree_match: task.sample.verification.exact_tree_match,
          agent_completed: attempt?.outcome === "completed",
        },
        failingChecks: [...(behavioral?.fail_to_pass_missing ?? []), ...(behavioral?.regressions ?? [])],
      });
      ctx.store.putJudgment(task.sample.sample_id, judgment);
      summary.judged.push({
        sampleId: task.sample.sample_id,
        score: judgment.score,
        flags: Object.entries(judgment.verdict.flags).filter(([, v]) => v).map(([k]) => k),
      });
    } catch (error) {
      if (error instanceof CancelledError) throw error;
      summary.failed.push({ sampleId: task.sample.sample_id, error: (error as Error).message.slice(0, 300) });
      ctx.logger.warn("judging failed", { sample: task.sample.sample_id, error: (error as Error).message.slice(0, 300) });
    }
  }
  return summary;
}

export function storedJudgments(ctx: PipelineContext): Map<string, Judgment> {
  const out = new Map<string, Judgment>();
  for (const [id, value] of ctx.store.listJudgments()) {
    const parsed = Judgment.safeParse(value);
    if (parsed.success) out.set(id, parsed.data);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Policy rollouts
// ---------------------------------------------------------------------------

export interface RolloutOptions {
  rollouts: number;
  sampleIds?: readonly string[];
  splits: readonly string[];
  judge: boolean;
}

export interface RolloutRunSummary {
  tasks: number;
  rollouts: Rollout[];
  stoppedReason: string | null;
}

export async function runRollouts(ctx: PipelineContext, pipeline: Pipeline, options: RolloutOptions): Promise<RolloutRunSummary> {
  const tasks = loadTasks(ctx, { sampleIds: options.sampleIds, splits: options.splits });
  const policy = modelForRole(ctx.config, "policy");
  const policyName = `${policy.provider}/${policy.model}`;
  const rollouts: Rollout[] = [];
  let stoppedReason: string | null = null;

  outer: for (const task of tasks) {
    let prepared;
    try {
      prepared = await pipeline.preparedFor(task.candidate);
    } catch (error) {
      if (error instanceof CancelledError) throw error;
      // One task whose environment cannot be rebuilt must not cost the other tasks their rollouts.
      ctx.logger.warn("rollout: cannot prepare the task environment; skipping the task", {
        task: task.sample.sample_id,
        error: (error as Error).message.slice(0, 300),
      });
      continue;
    }
    const groupId = shortId("group", { task: task.sample.sample_id, policy: policyName, run: ctx.runId });

    for (let index = 0; index < options.rollouts; index++) {
      if (ctx.signal?.aborted) {
        stoppedReason = "cancelled";
        break outer;
      }
      const budget = pipeline.checkBudget();
      if (budget.exhausted) {
        stoppedReason = `budget exhausted: ${budget.detail}`;
        break outer;
      }

      const started = Date.now();
      const salt = `${groupId}:${index}:${started}`;
      const run = await pipeline.runAgent(task.candidate, prepared, task.sample.task, {
        attempt: index + 1,
        role: "policy",
        idSalt: salt,
      });
      const attempt = run.attempt;
      const archive = run.solutionArchiveArtifact ? await ctx.artifacts.get(run.solutionArchiveArtifact) : null;
      const patch = attempt.solution_patch_artifact
        ? (await ctx.artifacts.get(attempt.solution_patch_artifact)).toString("utf8")
        : "";

      const scored = await pipeline.scoreSolution(task.candidate, prepared, {
        task: task.sample.task,
        events: attempt.events,
        archive,
        treeSha: attempt.result_tree_sha,
        solutionPatch: patch,
        agentCompleted: attempt.outcome === "completed",
        judge: options.judge,
      });

      const rollout = Rollout.parse({
        schema_version: DATASET_SCHEMA_VERSION,
        rollout_id: shortId("rollout", { salt }),
        task_id: task.sample.sample_id,
        group_id: groupId,
        index,
        run_id: ctx.runId,
        split: task.split,
        source: "policy",
        policy_model: policyName,
        outcome: attempt.outcome,
        events: attempt.events,
        result_tree_sha: attempt.result_tree_sha,
        solution_patch_artifact: attempt.solution_patch_artifact,
        verifiable: scored.verifiable,
        behavioral: scored.behavioral,
        judgment: scored.judgment,
        reward: scored.reward,
        output_mismatches: [],
        usage: attempt.usage,
        wall_clock_ms: Date.now() - started,
        created_at: new Date().toISOString(),
      });
      ctx.store.putRollout(rollout.rollout_id, rollout.task_id, rollout.group_id, rollout, rollout.reward.reward);
      rollouts.push(rollout);
      ctx.logger.info("rollout scored", {
        task: task.sample.sample_id,
        index,
        tests_passed: rollout.verifiable.tests_passed,
        judge: rollout.judgment?.score ?? "n/a",
        reward: rollout.reward.reward,
      });
    }
  }
  return { tasks: tasks.length, rollouts, stoppedReason };
}

// ---------------------------------------------------------------------------
// Scoring an external trajectory
// ---------------------------------------------------------------------------

export async function scoreExternal(
  ctx: PipelineContext,
  pipeline: Pipeline,
  input: { taskId: string; events: TrajectoryEvent[]; policyModel: string; judge: boolean },
): Promise<Rollout> {
  const task = loadTasks(ctx, { sampleIds: [input.taskId] })[0];
  if (!task) throw new Error(`no verified task ${input.taskId} in run ${ctx.runId}`);
  const prepared = await pipeline.preparedFor(task.candidate);
  const started = Date.now();

  const executed = await pipeline.executeTrajectory(task.candidate, prepared, input.events);
  if (executed.error) throw new Error(`cannot score: ${executed.error}`);

  const scored = await pipeline.scoreSolution(task.candidate, prepared, {
    task: task.sample.task,
    events: executed.events,
    archive: executed.archive,
    treeSha: executed.treeSha,
    solutionPatch: executed.patch,
    agentCompleted: true,
    judge: input.judge,
  });

  const salt = `${input.taskId}:external:${started}`;
  const rollout = Rollout.parse({
    schema_version: DATASET_SCHEMA_VERSION,
    rollout_id: shortId("rollout", { salt }),
    task_id: task.sample.sample_id,
    group_id: shortId("group", { task: task.sample.sample_id, policy: input.policyModel, run: ctx.runId }),
    index: 0,
    run_id: ctx.runId,
    split: task.split,
    source: "external",
    policy_model: input.policyModel,
    outcome: "completed",
    events: executed.events,
    result_tree_sha: executed.treeSha,
    solution_patch_artifact: executed.patch ? await ctx.artifacts.put(executed.patch) : null,
    verifiable: scored.verifiable,
    behavioral: scored.behavioral,
    judgment: scored.judgment,
    reward: scored.reward,
    output_mismatches: executed.mismatches,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null, cost_known: false },
    wall_clock_ms: Date.now() - started,
    created_at: new Date().toISOString(),
  });
  ctx.store.putRollout(rollout.rollout_id, rollout.task_id, rollout.group_id, rollout, rollout.reward.reward);
  return rollout;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface RolloutStats {
  tasks: number;
  rollouts: number;
  mean_reward: number;
  /** Share of rollouts whose solution passed the hidden tests. */
  pass_rate: number;
  /** Share of tasks with at least one passing rollout. */
  pass_at_k: number;
  k: number;
  preference_pairs: number;
}

/**
 * Write rollouts for a trainer.
 *
 *   rollouts.jsonl     one record per rollout: OpenAI messages, tools, reward breakdown, the
 *                      verifiable outcome, the judgment and a group-relative advantage
 *   preferences.jsonl  best-vs-worst pairs per task (TRL conversational DPO format), only when the
 *                      best rollout passed the hidden tests and the gap clears `preference_margin`
 */
export async function exportRollouts(
  rollouts: readonly Rollout[],
  samples: ReadonlyMap<string, Sample>,
  options: { outDir: string; includeDecisionSummaries: boolean; preferenceMargin: number },
): Promise<{ files: string[]; stats: RolloutStats }> {
  await mkdir(options.outDir, { recursive: true });
  const groups = new Map<string, Rollout[]>();
  for (const r of rollouts) groups.set(r.group_id, [...(groups.get(r.group_id) ?? []), r]);

  const lines: string[] = [];
  const pairs: string[] = [];
  let k = 0;
  for (const group of groups.values()) {
    k = Math.max(k, group.length);
    const { mean, std, advantages } = groupAdvantages(group.map((r) => r.reward.reward));
    const sample = samples.get(group[0]!.task_id);
    const context = sample ? agentContext(sample) : null;
    const views = group.map((r) =>
      eventsToOpenAI(r.events, { systemPrompt: context?.systemPrompt ?? "" }, { includeDecisionSummaries: options.includeDecisionSummaries }),
    );

    group.forEach((r, i) => {
      const { events: _events, ...rest } = r;
      void _events;
      lines.push(
        JSON.stringify({
          ...rest,
          messages: views[i]!.messages,
          tools: context ? openAITools(context.tools) : [],
          group_reward_mean: mean,
          group_reward_std: std,
          advantage: advantages[i],
        }),
      );
    });

    const ranked = group.map((r, i) => ({ r, view: views[i]! })).sort((a, b) => b.r.reward.reward - a.r.reward.reward);
    const best = ranked[0];
    const worst = ranked[ranked.length - 1];
    if (
      best &&
      worst &&
      best !== worst &&
      best.r.verifiable.tests_passed &&
      best.r.reward.reward - worst.r.reward.reward >= options.preferenceMargin
    ) {
      const prompt = best.view.messages.slice(0, 2);
      pairs.push(
        JSON.stringify({
          task_id: best.r.task_id,
          prompt,
          chosen: completion(best.view.messages),
          rejected: completion(worst.view.messages),
          tools: context ? openAITools(context.tools) : [],
          chosen_reward: best.r.reward.reward,
          rejected_reward: worst.r.reward.reward,
          chosen_rollout_id: best.r.rollout_id,
          rejected_rollout_id: worst.r.rollout_id,
        }),
      );
    }
  }

  const files = [join(options.outDir, "rollouts.jsonl"), join(options.outDir, "preferences.jsonl")];
  await writeFile(files[0]!, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
  await writeFile(files[1]!, pairs.length > 0 ? `${pairs.join("\n")}\n` : "", "utf8");

  const passingTasks = [...groups.values()].filter((g) => g.some((r) => r.verifiable.tests_passed)).length;
  const stats: RolloutStats = {
    tasks: groups.size,
    rollouts: rollouts.length,
    mean_reward: rollouts.length > 0 ? round(rollouts.reduce((a, r) => a + r.reward.reward, 0) / rollouts.length) : 0,
    pass_rate: rollouts.length > 0 ? round(rollouts.filter((r) => r.verifiable.tests_passed).length / rollouts.length) : 0,
    pass_at_k: groups.size > 0 ? round(passingTasks / groups.size) : 0,
    k,
    preference_pairs: pairs.length,
  };
  await writeFile(join(options.outDir, "rollout-stats.json"), JSON.stringify(stats, null, 2), "utf8");
  files.push(join(options.outDir, "rollout-stats.json"));
  return { files, stats };
}

/** Everything after the system prompt and the user request: what the policy produced. */
function completion(messages: readonly OpenAIMessage[]): OpenAIMessage[] {
  return messages.slice(2);
}

function round(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}
