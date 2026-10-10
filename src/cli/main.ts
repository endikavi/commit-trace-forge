#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
import { mkdir, readFile, writeFile, cp } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildContext, type CliContext } from "./context.ts";
import { formatDoctor, runDoctor } from "./doctor.ts";
import { collectReport, formatReport } from "./report.ts";
import { Runner } from "../runner.ts";
import { loadConfig } from "../config/load.ts";
import { createLogger, setLogLevel, type LogLevel } from "../util/logger.ts";
import { exportDataset, type ExportItem } from "../dataset/export.ts";
import { findDuplicates } from "../dataset/dedupe.ts";
import { assignSplits, crossSplitLeaks } from "../dataset/splits.ts";
import { scanRecord, summarise } from "../dataset/secrets.ts";
import { replayTrajectory } from "../verification/replay.ts";
import { toolsFor } from "../harness/tools.ts";
import { promptFingerprints } from "../prompts.ts";
import type { EvaluatorManifest, Sample } from "../types/index.ts";
import type { StageName } from "../storage/db.ts";
import { cleanupAfterRun, emptyReport, formatCleanup, type CleanupReport } from "../cleanup.ts";
import { importTrajectory } from "../dataset/import.ts";
import { exportRollouts, judgeSamples, runRollouts, scoreExternal, storedJudgments } from "../rl/index.ts";
import { Rollout } from "../types/index.ts";

const HELP = `commit-trace-forge — build verified synthetic coding-task datasets from git history

Usage:
  forge <command> [options]

Commands:
  doctor                      Check runtime, git, containers, model provider and limits
  clean     --config FILE [--orphans]
                              Remove the containers, images and mirror clones this tool created
  init [--dir DIR]            Write a commented starter configuration
  mine      --config FILE     Resolve refs, enumerate, filter and sample commits
  prepare   --config FILE     Build images and verify environments for the candidate pool
  grade     --config FILE     Score candidates with the structured evaluator
  generate  --config FILE     Produce and independently review user requests
  solve     --config FILE     Run the agent from the parent state
  verify    --config FILE     Exact reconstruction, behavioural checks and replay
  replay    --sample ID --config FILE
                              Re-execute one recorded trajectory in a clean environment
  export    --config FILE     Deduplicate, scan, split and write the dataset
  report    [--run RUN_ID] --config FILE
                              Candidates, rejections by cause, cost and distributions
  run       --config FILE [--resume]
                              The whole pipeline end to end

Training and RL (over the verified tasks of a run):
  judge     --config FILE [--sample ID] [--force]
                              Score accepted teacher trajectories with the LLM judge; the
                              score lands in the SFT exports for filtering
  rollout   --config FILE [--rollouts N] [--sample ID] [--split S] [--no-judge]
                              Run the policy model (model.roles.policy) N times per task,
                              verify, judge and reward each run; writes rollouts.jsonl,
                              preferences.jsonl and rollout-stats.json
  score     --config FILE --trajectory FILE [--task ID] [--policy-name NAME] [--no-judge]
                              Re-execute an external agent's trajectory and return its reward
                              (JSON with --json): the hook for an external RL trainer

Options:
  --config FILE               Path to the YAML configuration
  --run RUN_ID                Operate on a specific run
  --resume                    Continue the most recent run for this configuration
  --offline                   Never touch the network for repository updates
  --out DIR                   Export destination (default: <workspace>/export/<run id>)
  --log-level LEVEL           debug | info | warn | error   (default: info)
  --json                      Machine-readable output where supported
  --orphans                   With "clean": also remove images from runs this workspace
                              has no record of. Affects other runs sharing the daemon.
  --rollouts N                Rollouts per task (default: rl.rollouts_per_task)
  --split S                   Restrict rollouts to a split: train | validation | test
  --trajectory FILE           JSON trajectory: {"messages": [...]} or {"events": [...]}
  --task ID                   Task (sample) id the trajectory attempted
  --policy-name NAME          Label recorded for an external policy (default: external)
  --no-judge                  Skip the LLM judge; the reward is purely verifiable
  --force                     With "judge": re-judge samples that already have a verdict
  --export-only               With "rollout": rewrite the rollout files from the database
  --help, -h                  Show this help
`;

interface Args {
  command: string;
  config?: string;
  run?: string;
  sample?: string;
  out?: string;
  dir?: string;
  resume: boolean;
  offline: boolean;
  json: boolean;
  orphans: boolean;
  help: boolean;
  logLevel?: LogLevel;
  rollouts?: number;
  split?: string;
  trajectory?: string;
  task?: string;
  policyName?: string;
  noJudge: boolean;
  force: boolean;
  exportOnly: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  // argv[0] is the command unless it is an option, so `forge --help` is help rather than a
  // command named "--help".
  const first = argv[0];
  const args: Args = {
    command: first && !first.startsWith("-") ? first : "",
    resume: false,
    offline: false,
    json: false,
    orphans: false,
    help: false,
    noJudge: false,
    force: false,
    exportOnly: false,
  };
  for (let i = args.command === "" ? 0 : 1; i < argv.length; i++) {
    const token = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${token} requires a value`);
      return value;
    };
    switch (token) {
      case "--config": args.config = next(); break;
      case "--run": args.run = next(); break;
      case "--sample": args.sample = next(); break;
      case "--out": args.out = next(); break;
      case "--dir": args.dir = next(); break;
      case "--log-level": args.logLevel = next() as LogLevel; break;
      case "--resume": args.resume = true; break;
      case "--offline": args.offline = true; break;
      case "--json": args.json = true; break;
      case "--orphans": args.orphans = true; break;
      case "--rollouts": args.rollouts = Number.parseInt(next(), 10); break;
      case "--split": args.split = next(); break;
      case "--trajectory": args.trajectory = next(); break;
      case "--task": args.task = next(); break;
      case "--policy-name": args.policyName = next(); break;
      case "--no-judge": args.noJudge = true; break;
      case "--force": args.force = true; break;
      case "--export-only": args.exportOnly = true; break;
      case "--help":
      case "-h": args.help = true; break;
      default:
        if (token?.startsWith("-")) throw new Error(`unknown option: ${token}`);
    }
  }
  return args;
}

function requireConfig(args: Args): string {
  if (!args.config) throw new Error(`${args.command} requires --config FILE`);
  return args.config;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.command === "" || args.command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.logLevel) setLogLevel(args.logLevel);

  const controller = new AbortController();
  const onSignal = () => {
    process.stderr.write("\ncancelling; finishing the current step and saving state...\n");
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    switch (args.command) {
      case "doctor": return await cmdDoctor(args);
      case "clean": return await withContext(args, controller, cmdClean);
      case "init": return await cmdInit(args);
      case "mine": return await withContext(args, controller, cmdMine);
      case "prepare": return await withContext(args, controller, (ctx) => cmdStage(ctx, "prepare"));
      case "grade": return await withContext(args, controller, (ctx) => cmdStage(ctx, "grade"));
      case "generate": return await withContext(args, controller, (ctx) => cmdStage(ctx, "generate"));
      case "solve": return await withContext(args, controller, (ctx) => cmdStage(ctx, "solve"));
      case "verify": return await withContext(args, controller, (ctx) => cmdStage(ctx, "verify"));
      case "replay": return await withContext(args, controller, (ctx) => cmdReplay(ctx, args));
      case "export": return await withContext(args, controller, (ctx) => cmdExport(ctx, args));
      case "report": return await withContext(args, controller, (ctx) => cmdReport(ctx, args));
      case "run": return await withContext(args, controller, (ctx) => cmdRun(ctx, args));
      case "judge": return await withContext(args, controller, (ctx) => cmdJudge(ctx, args));
      case "rollout": return await withContext(args, controller, (ctx) => cmdRollout(ctx, args));
      case "score": return await withContext(args, controller, (ctx) => cmdScore(ctx, args));
      default:
        process.stderr.write(`unknown command: ${args.command}\n\n${HELP}`);
        return 2;
    }
  } catch (error) {
    process.stderr.write(`\nerror: ${(error as Error).message}\n`);
    if (process.env.FORGE_LOG_LEVEL === "debug") process.stderr.write(`${(error as Error).stack}\n`);
    return 1;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

/** Commands that operate on the results of an earlier run rather than producing one. */
const POST_RUN_COMMANDS = new Set(["judge", "rollout", "score", "export", "report", "replay"]);

async function withContext(
  args: Args,
  controller: AbortController,
  fn: (ctx: CliContext, args: Args) => Promise<number>,
): Promise<number> {
  const ctx = await buildContext({
    configPath: requireConfig(args),
    runId: args.run,
    // `mine` and a plain `run` start a new run; every other command continues the latest one.
    resume: args.resume || (args.command !== "mine" && args.command !== "run"),
    postRun: POST_RUN_COMMANDS.has(args.command),
    offline: args.offline,
    logger: createLogger("forge"),
    signal: controller.signal,
  });
  try {
    return await fn(ctx, args);
  } finally {
    ctx.close();
  }
}

// ---------------------------------------------------------------------------

async function cmdDoctor(args: Args): Promise<number> {
  const config = args.config ? (await loadConfig(args.config)).config : null;
  const report = await runDoctor(config);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatDoctor(report));
  }
  return report.ok ? 0 : 1;
}

async function cmdInit(args: Args): Promise<number> {
  const dir = resolve(args.dir ?? process.cwd());
  await mkdir(dir, { recursive: true });
  const target = join(dir, "forge.yaml");
  const source = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "example.yaml");
  await cp(source, target, { force: false, errorOnExist: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ERR_FS_CP_EEXIST" || error.code === "EEXIST") {
      throw new Error(`${target} already exists; refusing to overwrite it`);
    }
    throw error;
  });
  process.stdout.write(
    `wrote ${target}\n\nNext:\n  1. edit the repositories block\n  2. forge doctor --config ${target}\n  3. forge run --config ${target}\n`,
  );
  return 0;
}

async function cmdMine(ctx: CliContext): Promise<number> {
  const runner = new Runner(ctx);
  const result = await runner.pipelineRef.mine();
  process.stdout.write(
    [
      "",
      `run ${ctx.runId}`,
      `examined ${result.examined} commits, ${result.eligible} eligible, ${result.candidates} drawn into the candidate pool`,
      `population manifest: ${result.manifestPath}`,
      result.deficitReason ? `note: ${result.deficitReason}` : "",
      "",
    ].join("\n"),
  );
  return 0;
}

async function cmdStage(ctx: CliContext, until: StageName): Promise<number> {
  const runner = new Runner(ctx);
  const result = await runner.run({ until, resume: true });
  process.stdout.write(
    [
      "",
      `stage "${until}" finished for run ${ctx.runId}`,
      `candidates processed: ${result.processed}`,
      `accepted so far: ${result.accepted.length} of ${result.targetSamples} requested`,
      result.rejections.length > 0 ? `rejections in this pass: ${result.rejections.length}` : "",
      result.deficitReason ? `note: ${result.deficitReason}` : "",
      "",
      "Run `forge report --config <file>` for the full breakdown.",
      "",
    ]
      .filter((l) => l !== "")
      .join("\n") + "\n",
  );
  return 0;
}

async function cmdRun(ctx: CliContext, args: Args): Promise<number> {
  const runner = new Runner(ctx);
  if (!args.resume) await runner.pipelineRef.mine();

  const result = await runner.run({ resume: true });
  const exportResult = await performExport(ctx, args, result.accepted);

  ctx.store.finishRun(
    result.accepted.length >= result.targetSamples ? "completed" : "partial",
    result.deficitReason ?? undefined,
  );

  // Reclaim last, once the dataset is safely on disk: nothing is removed that the export could
  // still have needed.
  const cleanup = await cleanupAfterRun(cleanupContext(ctx), result.accepted.map((a) => a.sample));
  const combined = mergeCleanup([...result.cleanup, cleanup]);

  process.stdout.write(formatReport(collectReport(ctx.store)));
  process.stdout.write(
    [
      "Export",
      `  destination: ${exportResult.dir}`,
      `  samples written: ${exportResult.summary.samplesWritten}`,
      ...exportResult.summary.files.map((f) => `    ${f.path}  (${f.records} record(s), ${f.bytes} bytes)`),
      "",
      formatCleanup(combined),
      "",
      result.deficitReason ? `Shortfall: ${result.deficitReason}` : "Requested sample count reached.",
      "",
    ].join("\n"),
  );
  return 0;
}

/**
 * Remove what this tool created, without running anything.
 *
 * Useful after an interrupted run, which leaves containers and images behind that nothing else
 * will reclaim.
 */
async function cmdClean(ctx: CliContext, args: Args): Promise<number> {
  const samples = ctx.store.listSamples(true).map((s) => s.sample as Sample);
  const report = await cleanupAfterRun(cleanupContext(ctx), samples, { removeOrphans: args.orphans });
  process.stdout.write(`\n${formatCleanup(report)}\n\n`);
  return report.failedImages.length > 0 ? 1 : 0;
}

function cleanupContext(ctx: CliContext) {
  return {
    config: ctx.config.cleanup,
    store: ctx.store,
    backend: ctx.backend,
    artifacts: ctx.artifacts,
    workspaceDir: ctx.workspaceDir,
    logger: ctx.logger.child("cleanup"),
  };
}

function mergeCleanup(reports: readonly CleanupReport[]): CleanupReport {
  const merged = emptyReport();
  for (const report of reports) {
    merged.removedImages.push(...report.removedImages);
    merged.failedImages.push(...report.failedImages);
    merged.removedContainers += report.removedContainers;
    merged.removedMirrors.push(...report.removedMirrors);
    merged.prunedArtifacts += report.prunedArtifacts;
    merged.prunedBytes += report.prunedBytes;
    for (const item of report.kept) if (!merged.kept.includes(item)) merged.kept.push(item);
  }
  return merged;
}

async function cmdReport(ctx: CliContext, args: Args): Promise<number> {
  const data = collectReport(ctx.store);
  if (args.json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else process.stdout.write(formatReport(data));
  return 0;
}

async function cmdReplay(ctx: CliContext, args: Args): Promise<number> {
  if (!args.sample) throw new Error("replay requires --sample SAMPLE_ID");
  const stored = ctx.store.listSamples(false).find((s) => s.sample_id === args.sample);
  if (!stored) throw new Error(`no sample ${args.sample} in run ${ctx.runId}`);

  const sample = stored.sample as Sample;
  const candidate = ctx.store.getCandidate(stored.candidate_id);
  if (!candidate) throw new Error(`candidate ${stored.candidate_id} is missing from the workspace database`);

  const prepared = ctx.store.getStage<{ recipe: never; solveImageRef: string }>(
    candidate.candidate_id,
    "prepare",
  )?.output;
  if (!prepared) throw new Error(`candidate ${candidate.candidate_id} has no prepared environment to replay into`);

  // Replay starts from the prepared image, which is the exact state the solver worked from.
  // Cleanup removes those images once a repository is finished, so say plainly what to do
  // instead of failing with an opaque "no such image" from the container runtime.
  const imageStillThere = ctx.store.listRunImages("task").includes(prepared.solveImageRef);
  if (!imageStillThere) {
    throw new Error(
      `the prepared image ${prepared.solveImageRef} no longer exists: cleanup removed it when the ` +
        `repository finished (cleanup.task_images = "${ctx.config.cleanup.task_images}"). ` +
        `Run \`forge prepare --config <file>\` to rebuild it, or set cleanup.task_images: never.`,
    );
  }

  const attempt = sample.attempts[sample.accepted_attempt_index];
  if (!attempt) throw new Error("the sample records no accepted attempt");

  const recipe = prepared.recipe as unknown as { workdir: string; env: Record<string, string> };
  const result = await replayTrajectory({
    events: attempt.events,
    parentTreeSha: candidate.identity.parent_tree_sha,
    expectedTreeSha: attempt.result_tree_sha,
    recipe: prepared.recipe as never,
    backend: ctx.backend,
    containerOptions: {
      imageRef: prepared.solveImageRef,
      cpuLimit: ctx.config.sandbox.cpu_limit,
      memoryMb: ctx.config.sandbox.memory_mb,
      pidsLimit: ctx.config.sandbox.pids_limit,
      workdir: recipe.workdir,
      user: ctx.config.sandbox.run_as,
      env: recipe.env,
    },
    tools: toolsFor({ allowAskUser: true }),
    artifacts: ctx.artifacts,
    timeoutMs: ctx.config.sandbox.task_timeout_seconds * 1000,
    maxOutputChars: 24_000,
    network: false,
    logger: ctx.logger,
    runAs: ctx.config.sandbox.run_as,
    expectedFinalTestsGreen: sample.verification.behavioral?.pass_to_pass_run
      ? sample.verification.behavioral.pass_to_pass_run.command.exit_code === 0
      : null,
    signal: ctx.signal,
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "",
        `replay of ${args.sample}`,
        `  passed: ${result.passed}`,
        `  replayed tree: ${result.replayed_tree_sha ?? "(not computed)"}`,
        `  expected tree: ${attempt.result_tree_sha ?? "(none recorded)"}`,
        `  ${result.note}`,
        ...result.divergences.map((d) => `    ${d.kind} @ ${d.event_id}: ${d.detail}`),
        "",
      ].join("\n"),
    );
  }
  return result.passed ? 0 : 1;
}

async function cmdJudge(ctx: CliContext, args: Args): Promise<number> {
  const runner = new Runner(ctx);
  const summary = await judgeSamples(ctx, runner.pipelineRef, {
    sampleIds: args.sample ? [args.sample] : undefined,
    force: args.force,
  });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "",
        `judged ${summary.judged.length} trajectory(ies), ${summary.skipped} already judged, ${summary.failed.length} failed`,
        ...summary.judged.map(
          (j) => `  ${j.sampleId}  score ${j.score.toFixed(3)}${j.flags.length ? `  flags: ${j.flags.join(", ")}` : ""}`,
        ),
        ...summary.failed.map((f) => `  ${f.sampleId}  FAILED: ${f.error}`),
        "",
        "Scores are written into conversations.jsonl and sft-openai.jsonl on the next `forge export`.",
        "",
      ].join("\n"),
    );
  }
  return summary.failed.length > 0 ? 1 : 0;
}

async function cmdRollout(ctx: CliContext, args: Args): Promise<number> {
  if (args.exportOnly) {
    const exported = await writeRolloutExport(ctx, args);
    process.stdout.write([JSON.stringify(exported.stats, null, 2), ...exported.files.map((f) => `  ${f}`), ""].join("\n"));
    return 0;
  }
  const runner = new Runner(ctx);
  const rollouts = args.rollouts ?? ctx.config.rl.rollouts_per_task;
  if (!Number.isInteger(rollouts) || rollouts < 1) throw new Error("--rollouts must be a positive integer");
  const splits = args.split ? [args.split] : ctx.config.rl.splits;
  const result = await runRollouts(ctx, runner.pipelineRef, {
    rollouts,
    sampleIds: args.sample ? [args.sample] : undefined,
    splits,
    judge: ctx.config.rl.judge_rollouts && !args.noJudge,
  });
  if (result.tasks === 0) {
    process.stderr.write(
      `no verified tasks matched` +
        (splits.length ? ` (splits: ${splits.join(", ")}; splits are assigned by \`forge export\`)` : "") +
        "\n",
    );
    return 1;
  }
  const exported = await writeRolloutExport(ctx, args);
  const stats = exported.stats;
  process.stdout.write(
    [
      "",
      `rollouts this pass: ${result.rollouts.length} over ${result.tasks} task(s)`,
      ...(result.stoppedReason ? [`stopped early: ${result.stoppedReason}`] : []),
      "",
      `all rollouts in run ${ctx.runId}: ${stats.rollouts} over ${stats.tasks} task(s)`,
      `  pass rate:        ${(stats.pass_rate * 100).toFixed(1)}%`,
      `  pass@${stats.k}:           ${(stats.pass_at_k * 100).toFixed(1)}%`,
      `  mean reward:      ${stats.mean_reward.toFixed(3)}`,
      `  preference pairs: ${stats.preference_pairs}`,
      "",
      ...exported.files.map((f) => `  ${f}`),
      "",
    ].join("\n"),
  );
  return 0;
}

async function cmdScore(ctx: CliContext, args: Args): Promise<number> {
  if (!args.trajectory) throw new Error("score requires --trajectory FILE");
  const imported = importTrajectory(JSON.parse(await readFile(args.trajectory, "utf8")) as unknown);
  const taskId = args.task ?? imported.taskId;
  if (!taskId) throw new Error("score needs --task ID (or a task_id / sample_id field in the trajectory)");
  const runner = new Runner(ctx);
  const rollout = await scoreExternal(ctx, runner.pipelineRef, {
    taskId,
    events: imported.events,
    policyModel: args.policyName ?? "external",
    judge: !args.noJudge,
  });
  if (args.json) {
    const { events: _events, ...rest } = rollout;
    void _events;
    process.stdout.write(`${JSON.stringify(rest, null, 2)}\n`);
    return 0;
  }
  const v = rollout.verifiable;
  process.stdout.write(
    [
      "",
      `score for ${taskId} (${imported.format})`,
      `  reward:            ${rollout.reward.reward.toFixed(4)}   (${rollout.reward.formula})`,
      `  hidden tests:      ${v.tests_passed ? "passed" : "failed"} ` +
        `(${v.fail_to_pass_satisfied}/${v.fail_to_pass_total} fail-to-pass, ${v.regressions} regression(s))`,
      `  judge:             ${rollout.judgment ? rollout.judgment.score.toFixed(3) : "not run"}`,
      `  gates:             ${rollout.reward.gates.join(", ") || "none"}`,
      `  output mismatches: ${rollout.output_mismatches.length}` +
        (rollout.output_mismatches.length ? " (supplied tool results differ from re-execution)" : ""),
      "",
    ].join("\n"),
  );
  return 0;
}

async function writeRolloutExport(ctx: CliContext, args: Args) {
  // Policy rollouts only: externally scored trajectories (`forge score`) come from other agents and
  // would distort the policy's pass rate, pass@k and preference pairs.
  const all = ctx.store
    .listRollouts()
    .map((r) => Rollout.parse(r))
    .filter((r) => r.source === "policy");
  const samples = new Map(ctx.store.listSamples(true).map((s) => [s.sample_id, s.sample as Sample]));
  const dir = args.out ? resolve(args.out) : join(ctx.workspaceDir, "rollouts", ctx.runId);
  return exportRollouts(all, samples, {
    outDir: dir,
    includeDecisionSummaries: ctx.config.export.include_decision_summaries,
    preferenceMargin: ctx.config.rl.preference_margin,
  });
}

async function cmdExport(ctx: CliContext, args: Args): Promise<number> {
  const stored = ctx.store.listSamples(true);
  const items: ExportItem[] = stored.map((s) => ({
    sample: s.sample as Sample,
    manifest: s.manifest as EvaluatorManifest,
  }));
  const result = await performExport(ctx, args, items);
  process.stdout.write(
    [
      "",
      `exported ${result.summary.samplesWritten} sample(s) to ${result.dir}`,
      ...result.summary.files.map((f) => `  ${f.path}  (${f.records} record(s), ${f.bytes} bytes)`),
      "",
      ...result.notes.map((n) => `note: ${n}`),
      "",
    ].join("\n"),
  );
  return 0;
}

/**
 * Export pipeline: dedup, benchmark and license policy, secret scan, splits, write.
 *
 * Every exclusion is recorded as a rejection with its cause, so `forge report` accounts for
 * samples that were produced but not shipped.
 */
async function performExport(
  ctx: CliContext,
  args: Args,
  items: readonly ExportItem[],
): Promise<{ dir: string; summary: Awaited<ReturnType<typeof exportDataset>>; notes: string[] }> {
  const notes: string[] = [];
  let surviving = [...items];

  // ---- duplicates ---------------------------------------------------------
  const duplicates = findDuplicates(
    surviving.map((i) => ({ sampleId: i.sample.sample_id, keys: i.sample.dedup_keys })),
  );
  for (const finding of duplicates) {
    ctx.store.reject(
      null,
      "export",
      "dataset_duplicate",
      `${finding.sampleId} duplicates ${finding.duplicateOf} by ${finding.reason}`,
    );
  }
  const duplicateIds = new Set(duplicates.map((d) => d.sampleId));
  surviving = surviving.filter((i) => !duplicateIds.has(i.sample.sample_id));
  if (duplicates.length > 0) notes.push(`${duplicates.length} duplicate sample(s) excluded`);

  // ---- benchmark exclusion list -------------------------------------------
  const excluded = new Set(ctx.config.export.benchmark_exclusion_list.map((e) => e.toLowerCase()));
  if (excluded.size > 0) {
    const before = surviving.length;
    surviving = surviving.filter((i) => {
      const hit =
        excluded.has(i.sample.source.repository_url.toLowerCase()) ||
        excluded.has(i.sample.source.repository_family.toLowerCase());
      if (hit) {
        ctx.store.reject(null, "export", "dataset_benchmark_excluded", i.sample.source.repository_url);
      }
      return !hit;
    });
    if (before !== surviving.length) notes.push(`${before - surviving.length} sample(s) hit the benchmark exclusion list`);
    notes.push(
      "The benchmark exclusion list only removes what it names. It is not a guarantee that the " +
        "dataset is free of evaluation contamination.",
    );
  }

  // ---- licenses -----------------------------------------------------------
  const allowed = new Set(ctx.config.export.allowed_licenses);
  surviving = surviving.filter((item) => {
    const license = item.sample.source.license;
    if (license === null) {
      if (ctx.config.export.unknown_license_policy === "exclude") {
        ctx.store.reject(null, "export", "dataset_license_disallowed", `${item.sample.sample_id}: license unknown`);
        return false;
      }
      item.sample.quality.license_ok = false;
      notes.push(
        `${item.sample.sample_id}: license could not be identified for ${item.sample.source.repository_url}; ` +
          `exported as PENDING REVIEW. A public repository does not by itself authorise any particular use.`,
      );
      ctx.store.reject(null, "export", "dataset_license_unknown_pending_review", item.sample.source.repository_url);
      return true;
    }
    if (allowed.size > 0 && !allowed.has(license)) {
      ctx.store.reject(null, "export", "dataset_license_disallowed", `${item.sample.sample_id}: ${license}`);
      return false;
    }
    item.sample.quality.license_ok = true;
    return true;
  });

  // ---- secrets and personal data ------------------------------------------
  const kept: ExportItem[] = [];
  for (const item of surviving) {
    const findings = [
      ...scanRecord(item.sample.task, "$.task"),
      ...scanRecord(item.sample.events, "$.events"),
    ];
    if (findings.length === 0) {
      item.sample.quality.secrets_scan_clean = true;
      kept.push(item);
      continue;
    }
    if (ctx.config.export.secret_policy === "exclude") {
      ctx.store.reject(
        null,
        "export",
        findings.some((f) => f.kind === "secret") ? "dataset_secret_detected" : "dataset_pii_detected",
        `${item.sample.sample_id}: ${summarise(findings)}`,
      );
      notes.push(`${item.sample.sample_id} excluded: ${summarise(findings)}`);
      continue;
    }
    // Redaction rewrites real tool output. That breaks the guarantee that the recorded results
    // are exactly what the commands produced, so the sample is dropped rather than shipped as if
    // it were still a faithful record.
    ctx.store.reject(
      null,
      "export",
      findings.some((f) => f.kind === "secret") ? "dataset_secret_detected" : "dataset_pii_detected",
      `${item.sample.sample_id}: redaction would break verifiability (${summarise(findings)})`,
    );
    notes.push(
      `${item.sample.sample_id} excluded: redacting ${summarise(findings)} would rewrite real tool output ` +
        `and the sample could no longer be verified against what actually ran`,
    );
  }
  surviving = kept;

  // ---- splits -------------------------------------------------------------
  const splitSummary = assignSplits(
    surviving.map((i) => ({
      sampleId: i.sample.sample_id,
      repositoryFamily: i.sample.source.repository_family,
      repositoryUrl: i.sample.source.repository_url,
    })),
    ctx.config.export,
    ctx.config.seed,
  );
  const splitById = new Map(splitSummary.assignments.map((a) => [a.sampleId, a.split]));
  for (const item of surviving) {
    const split = splitById.get(item.sample.sample_id) ?? null;
    item.sample.split = split;
    if (split) ctx.store.setSampleSplit(item.sample.sample_id, split);
  }
  const leaks = crossSplitLeaks(splitSummary.assignments);
  if (leaks.length > 0) {
    throw new Error(`split assignment put these groups in more than one split: ${leaks.join(", ")}`);
  }

  // ---- write --------------------------------------------------------------
  const dir = args.out ? resolve(args.out) : join(ctx.workspaceDir, "export", ctx.runId);
  const judgments = storedJudgments(ctx);
  for (const item of surviving) item.judgment = judgments.get(item.sample.sample_id) ?? null;
  const summary = await exportDataset(surviving, {
    outDir: dir,
    config: ctx.config.export,
    runId: ctx.runId,
    rlLimits: {
      max_turns: ctx.config.generation.max_agent_turns,
      max_user_questions: ctx.config.generation.max_user_questions,
      command_timeout_seconds: ctx.config.sandbox.command_timeout_seconds,
      task_timeout_seconds: ctx.config.sandbox.task_timeout_seconds,
      network: ctx.config.sandbox.network_during_solve,
      run_as: ctx.config.sandbox.run_as,
    },
  });

  if (summary.fixtureProvenance > 0 && !ctx.config.export.allow_fixture_provenance) {
    notes.push(
      `${summary.fixtureProvenance} sample(s) came from the scripted fixture harness and were NOT exported. ` +
        `A scripted trajectory is never shipped as a verified model run.`,
    );
  }

  // A provenance record next to the data, so the export can be audited later.
  await writeFile(
    join(dir, "run-manifest.json"),
    JSON.stringify(
      {
        run_id: ctx.runId,
        config_hash: ctx.loaded.configHash,
        // Relative, so a published export does not carry the producer's directory layout.
        config_path: relative(process.cwd(), ctx.loaded.path).split("\\").join("/"),
        prompts: promptFingerprints(),
        sandbox_backend: ctx.backend.name,
        sandbox_isolation_notes: ctx.backend.isolationNotes(),
        harness: `${ctx.harness.name}@${ctx.harness.version}`,
        splits: splitSummary.counts,
        realised_split_fractions: splitSummary.realised,
        groups_per_split: splitSummary.groupsPerSplit,
        exported_at: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );

  // The dataset is written to disk and nothing else. Publishing is a separate, human decision.
  notes.push("The dataset was written locally. Nothing was published or uploaded.");

  return { dir, summary, notes };
}

process.exitCode = await main();
