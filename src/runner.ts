import { Pipeline, type PipelineContext } from "./pipeline.ts";
import { reviewRejectionCause } from "./taskgen/index.ts";
import type { CandidateRow } from "./storage/state.ts";
import { CancelledError, ForgeError, type RejectionCause } from "./util/errors.ts";
import type { StageName } from "./storage/db.ts";
import type { EvaluatorManifest, Sample } from "./types/index.ts";
import { cleanupAfterRepository, type CleanupReport } from "./cleanup.ts";

/**
 * Candidate driver.
 *
 * Walks the candidate pool in the order `forge mine` drew it, stops when the requested number of
 * ACCEPTED samples is reached, and reports why it stopped when it falls short. Each candidate is
 * independent, so a bounded number run concurrently.
 */

export interface RunOptions {
  /** Stop after this stage. Used by the per-stage CLI commands. */
  until?: StageName;
  /** Skip candidates whose stages already completed with a matching input hash. */
  resume?: boolean;
}

export interface RunResult {
  accepted: Array<{ sample: Sample; manifest: EvaluatorManifest }>;
  processed: number;
  targetSamples: number;
  deficitReason: string | null;
  rejections: Array<{ candidateId: string; stage: StageName; cause: RejectionCause; detail: string }>;
  /** Disk reclaimed as each repository finished. */
  cleanup: CleanupReport[];
}

export class Runner {
  private readonly pipeline: Pipeline;
  private readonly ctx: PipelineContext;

  constructor(ctx: PipelineContext) {
    this.ctx = ctx;
    this.pipeline = new Pipeline(ctx);
  }

  get pipelineRef(): Pipeline {
    return this.pipeline;
  }

  async run(options: RunOptions = {}): Promise<RunResult> {
    await this.pipeline.ensureRepositories();

    const config = this.ctx.config;
    const store = this.ctx.store;
    const logger = this.ctx.logger.child("run");

    if (options.resume) {
      const reset = store.resetStaleRunningStages();
      if (reset > 0) logger.info("resume: reset stages interrupted by an earlier exit", { stages: reset });
    }

    const candidates = store.listCandidates(["selected", "prepared", "graded", "generated", "solved", "verified"]);
    const targetSamples =
      config.sampling.target_scope === "per_repository"
        ? config.sampling.target_samples * config.repositories.length
        : config.sampling.target_samples;

    const perRepoLimit = new Map<string, number>();
    for (const repo of config.repositories) {
      if (repo.max_samples !== undefined) perRepoLimit.set(repo.url, repo.max_samples);
    }
    const acceptedPerRepo = new Map<string, number>();

    const accepted: RunResult["accepted"] = [];
    const rejections: RunResult["rejections"] = [];
    const cleanupReports: CleanupReport[] = [];

    // How many candidates each repository still has in flight, so its images can be reclaimed as
    // soon as the last one is decided rather than at the very end of the run.
    const outstanding = new Map<string, number>();
    for (const candidate of candidates) {
      outstanding.set(candidate.repository_url, (outstanding.get(candidate.repository_url) ?? 0) + 1);
    }
    const finishWithRepository = async (url: string): Promise<void> => {
      const left = (outstanding.get(url) ?? 1) - 1;
      outstanding.set(url, left);
      if (left > 0) return;
      cleanupReports.push(
        await cleanupAfterRepository(
          {
            config: config.cleanup,
            store,
            backend: this.ctx.backend,
            artifacts: this.ctx.artifacts,
            workspaceDir: this.ctx.workspaceDir,
            logger: logger.child("cleanup"),
          },
          url,
        ),
      );
    };
    let processed = 0;
    let deficitReason: string | null = null;
    let stopped = false;

    const preparedCap = config.budgets.max_prepared_candidates ?? Number.POSITIVE_INFINITY;

    const queue = [...candidates];
    const concurrency = Math.max(1, Math.min(config.budgets.max_parallel_tasks, queue.length || 1));

    const worker = async (): Promise<void> => {
      for (;;) {
        if (stopped) return;
        const candidate = queue.shift();
        if (!candidate) return;

        if (accepted.length >= targetSamples) {
          stopped = true;
          return;
        }
        if (processed >= preparedCap) {
          stopped = true;
          deficitReason = `stopped after preparing ${processed} candidates (budgets.max_prepared_candidates)`;
          return;
        }
        const budget = this.pipeline.checkBudget();
        if (budget.exhausted) {
          stopped = true;
          deficitReason = `budget exhausted: ${budget.detail}`;
          store.reject(candidate.candidate_id, "solve", budget.cause ?? "budget_tokens_exhausted", budget.detail);
          return;
        }
        const repoCap = perRepoLimit.get(candidate.repository_url);
        if (repoCap !== undefined && (acceptedPerRepo.get(candidate.repository_url) ?? 0) >= repoCap) {
          logger.debug("skipping: repository already contributed its maximum", {
            repo: candidate.repository_url,
            cap: repoCap,
          });
          // A skipped candidate still counts as decided, so the repository can be reclaimed once
          // the rest are done rather than being held open by candidates that will never run.
          await finishWithRepository(candidate.repository_url);
          continue;
        }

        processed++;
        try {
          const outcome = await this.processCandidate(candidate, options);
          if (outcome.kind === "accepted") {
            accepted.push({ sample: outcome.sample, manifest: outcome.manifest });
            acceptedPerRepo.set(
              candidate.repository_url,
              (acceptedPerRepo.get(candidate.repository_url) ?? 0) + 1,
            );
            store.setCandidateStatus(candidate.candidate_id, "accepted");
            store.putSample(
              outcome.sample.sample_id,
              candidate.candidate_id,
              outcome.sample,
              outcome.manifest,
              true,
              null,
            );
            logger.info("candidate accepted", {
              candidate: candidate.candidate_id,
              accepted: accepted.length,
              target: targetSamples,
            });
          } else if (outcome.kind === "rejected") {
            rejections.push({
              candidateId: candidate.candidate_id,
              stage: outcome.stage,
              cause: outcome.cause,
              detail: outcome.detail,
            });
            store.reject(candidate.candidate_id, outcome.stage, outcome.cause, outcome.detail);
            logger.info("candidate rejected", {
              candidate: candidate.candidate_id,
              stage: outcome.stage,
              cause: outcome.cause,
            });
          } else {
            // Stopped early because the caller asked for a partial run.
            logger.debug("candidate halted at the requested stage", { candidate: candidate.candidate_id });
          }
        } catch (error) {
          if (error instanceof CancelledError) {
            stopped = true;
            deficitReason = "run cancelled";
            return;
          }
          const cause: RejectionCause = error instanceof ForgeError ? error.cause_code : "internal_error";
          const detail = (error as Error).message;
          rejections.push({ candidateId: candidate.candidate_id, stage: "solve", cause, detail });
          store.reject(candidate.candidate_id, "solve", cause, detail);
          logger.warn("candidate failed", { candidate: candidate.candidate_id, cause, detail: detail.slice(0, 300) });
        } finally {
          // Whatever the outcome, this candidate no longer needs the repository's images.
          await finishWithRepository(candidate.repository_url).catch((error: Error) => {
            logger.warn("cleanup after a repository failed", { repo: candidate.repository_url, error: error.message });
          });
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (accepted.length < targetSamples && !deficitReason) {
      deficitReason =
        `produced ${accepted.length} of ${targetSamples} requested samples: the candidate pool ` +
        `(${candidates.length} commits) was exhausted after ${rejections.length} rejection(s)`;
    }

    return { accepted, processed, targetSamples, deficitReason, rejections, cleanup: cleanupReports };
  }

  private async processCandidate(
    candidate: CandidateRow,
    options: RunOptions,
  ): Promise<CandidateOutcome> {
    const until = options.until;
    const reached = (stage: StageName): boolean => until !== undefined && stageIndex(stage) >= stageIndex(until);

    // ---- prepare -----------------------------------------------------------
    let prepared;
    try {
      prepared = await this.pipeline.prepare(candidate);
    } catch (error) {
      return asRejection("prepare", error);
    }
    if (reached("prepare")) return { kind: "halted" };

    // ---- grade -------------------------------------------------------------
    let graded;
    try {
      graded = await this.pipeline.grade(candidate, prepared);
    } catch (error) {
      return asRejection("grade", error);
    }
    if (!graded.passed) {
      return {
        kind: "rejected",
        stage: "grade",
        cause: graded.cause ?? "grade_below_total_threshold",
        detail: `${graded.detail} (weighted total ${graded.totalScore})`,
      };
    }
    if (reached("grade")) return { kind: "halted" };

    // ---- generate ----------------------------------------------------------
    let generated;
    try {
      generated = await this.pipeline.generate(candidate, prepared);
    } catch (error) {
      return asRejection("generate", error);
    }
    if (generated.review.verdict !== "accept") {
      return {
        kind: "rejected",
        stage: "generate",
        cause: reviewRejectionCause(generated.review),
        detail: [...generated.review.issues, ...generated.review.leak_evidence].join("; ") || "reviewer rejected the task",
      };
    }
    if (reached("generate")) return { kind: "halted" };

    // ---- solve -------------------------------------------------------------
    let solved;
    try {
      solved = await this.pipeline.solve(candidate, prepared, generated);
    } catch (error) {
      return asRejection("solve", error);
    }
    if (solved.acceptedIndex < 0) {
      return {
        kind: "rejected",
        stage: "solve",
        cause: "solve_no_attempt_succeeded",
        detail:
          `no attempt completed in ${solved.attempts.length} try/tries: ` +
          solved.attempts.map((a) => `#${a.attempt} ${a.outcome}${a.error ? ` (${a.error})` : ""}`).join("; "),
      };
    }
    if (reached("solve")) return { kind: "halted" };

    // ---- verify ------------------------------------------------------------
    let verification;
    try {
      verification = await this.pipeline.verify(candidate, prepared, generated, solved);
    } catch (error) {
      return asRejection("verify", error);
    }

    const { sample, manifest } = await this.pipeline.buildSample(
      candidate,
      prepared,
      graded,
      generated,
      solved,
      verification,
    );

    if (!verification.accepted) {
      // The sample is still persisted, unaccepted, so `forge report` can account for the work.
      this.ctx.store.putSample(sample.sample_id, candidate.candidate_id, sample, manifest, false, null);
      return {
        kind: "rejected",
        stage: "verify",
        cause: verification.rejection_cause as RejectionCause,
        detail: describeVerification(verification),
      };
    }

    return { kind: "accepted", sample, manifest };
  }
}

type CandidateOutcome =
  | { kind: "accepted"; sample: Sample; manifest: EvaluatorManifest }
  | { kind: "rejected"; stage: StageName; cause: RejectionCause; detail: string }
  | { kind: "halted" };

function asRejection(stage: StageName, error: unknown): CandidateOutcome {
  if (error instanceof CancelledError) throw error;
  if (error instanceof ForgeError) {
    return { kind: "rejected", stage, cause: error.cause_code, detail: error.message };
  }
  return { kind: "rejected", stage, cause: "internal_error", detail: (error as Error).message };
}

function describeVerification(v: Sample["verification"]): string {
  const parts = [
    `exact_tree_match=${v.exact_tree_match}`,
    `behavioral_checks_passed=${v.behavioral_checks_passed}`,
    `replay_passed=${v.replay_passed}`,
    `clean_runs=${v.clean_runs_completed}`,
  ];
  if (v.tree_diff_summary.length > 0) {
    parts.push(
      `tree differences: ${v.tree_diff_summary.slice(0, 5).map((d) => `${d.path}:${d.kind}`).join(", ")}`,
    );
  }
  if (v.behavioral?.fail_to_pass_missing.length) {
    parts.push(`fail-to-pass still failing: ${v.behavioral.fail_to_pass_missing.join(", ")}`);
  }
  if (v.behavioral?.regressions.length) parts.push(`regressions: ${v.behavioral.regressions.join(", ")}`);
  if (v.replay?.divergences.length) {
    parts.push(`replay divergences: ${v.replay.divergences.map((d) => `${d.kind}@${d.event_id}`).join(", ")}`);
  }
  return parts.join("; ");
}

const STAGE_INDEX: Record<StageName, number> = {
  mine: 0,
  prepare: 1,
  grade: 2,
  generate: 3,
  solve: 4,
  verify: 5,
  replay: 6,
  export: 7,
};

function stageIndex(stage: StageName): number {
  return STAGE_INDEX[stage];
}
