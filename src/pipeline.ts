import { Buffer } from "node:buffer";
import type { ForgeConfig } from "./config/schema.ts";
import { effectiveFilters, modelForRole } from "./config/schema.ts";
import type { Store, CandidateRow } from "./storage/state.ts";
import type { ArtifactStore } from "./storage/artifacts.ts";
import { ADAPTER_VERSION, HARNESS_TOOLS_VERSION } from "./storage/versions.ts";
import { promptFingerprints } from "./prompts.ts";
import type { Logger } from "./util/logger.ts";
import { CancelledError, ForgeError, type RejectionCause } from "./util/errors.ts";
import { shortId } from "./util/hash.ts";
import type { AcquiredRepo } from "./sources/index.ts";
import { mine, type MineResult } from "./mining/index.ts";
import { prepareEnvironment, type PrepareOutput } from "./environments/prepare.ts";
import type { Recipe } from "./environments/recipe.ts";
import { auditIsolation, currentTreeSha, workspaceDiff } from "./environments/workspace.ts";
import { gradeCommit, type GradeOutput } from "./grading/index.ts";
import { generateTask, type GenerateOutput } from "./taskgen/index.ts";
import { toolSchemas, toolsFor } from "./harness/tools.ts";
import type { AgentHarness, ModelProvider, ToolContext } from "./harness/types.ts";
import { UserSimulator, type RecordedAnswer } from "./user-simulator/index.ts";
import { compareTrees } from "./verification/exact.ts";
import { runBehavioralChecks } from "./verification/behavioral.ts";
import { replayTrajectory } from "./verification/replay.ts";
import { judgeTrajectory } from "./judging/index.ts";
import { composeReward, verifiableOutcome } from "./rewards/index.ts";
import { loadPrompt } from "./prompts.ts";
import { buildDedupKeys } from "./dataset/dedupe.ts";
import type { SandboxBackend, CreateContainerOptions } from "./sandbox/types.ts";
import {
  DATASET_SCHEMA_VERSION,
  Sample,
  type EvaluatorManifest,
  type SolveAttempt,
  type BehavioralChecks,
  type Judgment,
  type RewardBreakdown,
  type TaskSpec,
  type TokenUsage,
  type TrajectoryEvent,
  type VerifiableOutcome,
  type VerificationResults,
} from "./types/index.ts";

export interface PipelineContext {
  config: ForgeConfig;
  workspaceDir: string;
  /** Directory of the configuration file; local repository paths resolve against it. */
  configDir: string;
  store: Store;
  artifacts: ArtifactStore;
  backend: SandboxBackend;
  harness: AgentHarness;
  provider: ModelProvider;
  logger: Logger;
  runId: string;
  signal?: AbortSignal;
  offline?: boolean;
}

export interface BudgetStatus {
  exhausted: boolean;
  cause: RejectionCause | null;
  detail: string;
}

const MAX_TOOL_OUTPUT_CHARS = 24_000;

export class Pipeline {
  private readonly ctx: PipelineContext;
  private repos = new Map<string, AcquiredRepo>();
  private readonly startedAt = Date.now();

  constructor(ctx: PipelineContext) {
    this.ctx = ctx;
  }

  get repositories(): ReadonlyMap<string, AcquiredRepo> {
    return this.repos;
  }

  // -------------------------------------------------------------------------
  // Budgets
  // -------------------------------------------------------------------------

  /**
   * Budget check.
   *
   * Cost is only enforced over calls whose model has a published price. Calls with an unknown
   * price are counted and reported, but they cannot be charged against a dollar limit without
   * inventing a number, so the token and wall-clock limits carry the load for them.
   */
  checkBudget(): BudgetStatus {
    const totals = this.ctx.store.totals();
    const budgets = this.ctx.config.budgets;

    if (totals.total_tokens >= budgets.max_total_tokens) {
      return {
        exhausted: true,
        cause: "budget_tokens_exhausted",
        detail: `${totals.total_tokens} tokens used, limit ${budgets.max_total_tokens}`,
      };
    }
    if (totals.cost_usd >= budgets.max_total_cost_usd) {
      return {
        exhausted: true,
        cause: "budget_cost_exhausted",
        detail:
          `$${totals.cost_usd.toFixed(4)} of priced usage, limit $${budgets.max_total_cost_usd}` +
          (totals.calls_with_unknown_cost > 0
            ? ` (plus ${totals.calls_with_unknown_cost} call(s) with an unknown price, not charged)`
            : ""),
      };
    }
    if (budgets.max_wall_clock_seconds > 0) {
      const elapsed = (Date.now() - this.startedAt) / 1000;
      if (elapsed >= budgets.max_wall_clock_seconds) {
        return {
          exhausted: true,
          cause: "budget_cost_exhausted",
          detail: `${Math.round(elapsed)}s elapsed, limit ${budgets.max_wall_clock_seconds}s`,
        };
      }
    }
    return { exhausted: false, cause: null, detail: "" };
  }

  private throwIfCancelled(): void {
    if (this.ctx.signal?.aborted) throw new CancelledError();
  }

  // -------------------------------------------------------------------------
  // Stages
  // -------------------------------------------------------------------------

  async mine(): Promise<MineResult> {
    const result = await mine({
      config: this.ctx.config,
      workspaceDir: this.ctx.workspaceDir,
      configDir: this.ctx.configDir,
      store: this.ctx.store,
      artifacts: this.ctx.artifacts,
      logger: this.ctx.logger.child("mine"),
      offline: this.ctx.offline,
      signal: this.ctx.signal,
    });
    this.repos = new Map(result.repositories.map((r) => [r.url, r]));
    return result;
  }

  /** Re-acquire repositories without re-enumerating history (used when resuming a later stage). */
  async ensureRepositories(): Promise<void> {
    if (this.repos.size === this.ctx.config.repositories.length) return;
    const { acquireRepository } = await import("./sources/index.ts");
    for (const repoConfig of this.ctx.config.repositories) {
      if (this.repos.has(repoConfig.url)) continue;
      this.repos.set(
        repoConfig.url,
        await acquireRepository(repoConfig, {
          workspaceDir: this.ctx.workspaceDir,
          configDir: this.ctx.configDir,
          logger: this.ctx.logger.child("sources"),
          offline: true,
        }),
      );
    }
  }

  private repoFor(candidate: CandidateRow): AcquiredRepo {
    const repo = this.repos.get(candidate.repository_url);
    if (!repo) throw new ForgeError("internal_error", `repository ${candidate.repository_url} was not acquired`);
    return repo;
  }

  private containerOptions(recipe: Recipe, imageRef: string): Omit<CreateContainerOptions, "network"> {
    return {
      imageRef,
      cpuLimit: this.ctx.config.sandbox.cpu_limit,
      memoryMb: this.ctx.config.sandbox.memory_mb,
      pidsLimit: this.ctx.config.sandbox.pids_limit,
      workdir: recipe.workdir,
      user: this.ctx.config.sandbox.run_as,
      env: recipe.env,
    };
  }

  // ---- prepare ------------------------------------------------------------

  async prepare(candidate: CandidateRow): Promise<PrepareOutput> {
    const inputHash = this.ctx.store.stageInputHash("prepare", {
      candidate: candidate.candidate_id,
      parent: candidate.parent_sha,
      target: candidate.target_sha,
      sandbox: this.ctx.config.sandbox,
      verification: {
        strict_baseline: this.ctx.config.verification.strict_baseline,
      },
      backend: this.ctx.backend.name,
    });

    const cached = this.ctx.store.getCachedStageOutput<PrepareOutput>(candidate.candidate_id, "prepare", inputHash);
    if (cached) {
      // A cached image may have been pruned since. Verifying is cheap; assuming is not.
      const stillThere = this.ctx.store.getImage(cached.recipeHash);
      if (stillThere) {
        this.ctx.logger.debug("prepare: reusing cached result", { candidate: candidate.candidate_id });
        return cached;
      }
      this.ctx.logger.info("prepare: cached image is gone, rebuilding", { candidate: candidate.candidate_id });
    }

    this.ctx.store.beginStage(candidate.candidate_id, "prepare", inputHash);
    try {
      const output = await prepareEnvironment({
        config: this.ctx.config,
        repo: this.repoFor(candidate),
        identity: candidate.identity,
        backend: this.ctx.backend,
        artifacts: this.ctx.artifacts,
        store: this.ctx.store,
        logger: this.ctx.logger.child("prepare"),
        signal: this.ctx.signal,
      });
      this.ctx.store.completeStage(candidate.candidate_id, "prepare", inputHash, output);
      this.ctx.store.setCandidateStatus(candidate.candidate_id, "prepared");
      return output;
    } catch (error) {
      this.ctx.store.failStage(candidate.candidate_id, "prepare", inputHash, (error as Error).message);
      throw error;
    }
  }

  // ---- grade --------------------------------------------------------------

  async grade(candidate: CandidateRow, prepared: PrepareOutput): Promise<GradeOutput> {
    const prompts = promptFingerprints();
    const inputHash = this.ctx.store.stageInputHash("grade", {
      candidate: candidate.candidate_id,
      environment: prepared.verification,
      grading: this.ctx.config.grading,
      model: modelForRole(this.ctx.config, "grader"),
      prompt: prompts.grader,
    });
    const cached = this.ctx.store.getCachedStageOutput<GradeOutput>(candidate.candidate_id, "grade", inputHash);
    if (cached) return cached;

    this.ctx.store.beginStage(candidate.candidate_id, "grade", inputHash);
    try {
      const filters = effectiveFilters(
        this.ctx.config,
        this.ctx.config.repositories.find((r) => r.url === candidate.repository_url)!,
      );
      const output = await gradeCommit({
        identity: candidate.identity,
        metrics: candidate.metrics,
        environment: prepared.verification,
        git: this.repoFor(candidate).git,
        provider: this.ctx.provider,
        model: modelForRole(this.ctx.config, "grader"),
        grading: this.ctx.config.grading,
        store: this.ctx.store,
        timeoutMs: this.ctx.config.sandbox.task_timeout_seconds * 1000,
        renameSimilarity: filters.rename_similarity,
        signal: this.ctx.signal,
      });
      this.ctx.store.completeStage(candidate.candidate_id, "grade", inputHash, output);
      if (output.passed) this.ctx.store.setCandidateStatus(candidate.candidate_id, "graded");
      return output;
    } catch (error) {
      this.ctx.store.failStage(candidate.candidate_id, "grade", inputHash, (error as Error).message);
      throw error;
    }
  }

  // ---- generate -----------------------------------------------------------

  async generate(candidate: CandidateRow, prepared: PrepareOutput): Promise<GenerateOutput> {
    const prompts = promptFingerprints();
    const inputHash = this.ctx.store.stageInputHash("generate", {
      candidate: candidate.candidate_id,
      environment: prepared.verification.fail_to_pass,
      generation: this.ctx.config.generation,
      models: {
        taskgen: modelForRole(this.ctx.config, "taskgen"),
        taskreview: modelForRole(this.ctx.config, "taskreview"),
      },
      prompts: { taskgen: prompts.taskgen, taskreview: prompts.taskreview },
    });
    const cached = this.ctx.store.getCachedStageOutput<GenerateOutput>(candidate.candidate_id, "generate", inputHash);
    if (cached) return cached;

    this.ctx.store.beginStage(candidate.candidate_id, "generate", inputHash);
    try {
      const filters = effectiveFilters(
        this.ctx.config,
        this.ctx.config.repositories.find((r) => r.url === candidate.repository_url)!,
      );
      const output = await generateTask({
        identity: candidate.identity,
        metrics: candidate.metrics,
        environment: prepared.verification,
        git: this.repoFor(candidate).git,
        provider: this.ctx.provider,
        generatorModel: modelForRole(this.ctx.config, "taskgen"),
        reviewerModel: modelForRole(this.ctx.config, "taskreview"),
        store: this.ctx.store,
        timeoutMs: this.ctx.config.sandbox.task_timeout_seconds * 1000,
        renameSimilarity: filters.rename_similarity,
        signal: this.ctx.signal,
      });
      this.ctx.store.completeStage(candidate.candidate_id, "generate", inputHash, output);
      if (output.review.verdict === "accept") {
        this.ctx.store.setCandidateStatus(candidate.candidate_id, "generated");
      }
      return output;
    } catch (error) {
      this.ctx.store.failStage(candidate.candidate_id, "generate", inputHash, (error as Error).message);
      throw error;
    }
  }

  // ---- solve --------------------------------------------------------------

  /**
   * Run the solver.
   *
   * Every attempt starts from a brand-new container built from the prepared image, so a retry
   * never inherits the previous attempt's edits. No attempt ever receives the target diff, the
   * target SHA or hidden-test feedback; a guided variant would be a different dataset and would
   * have to be labelled as one.
   */
  async solve(
    candidate: CandidateRow,
    prepared: PrepareOutput,
    generated: GenerateOutput,
  ): Promise<SolveOutcome> {
    const prompts = promptFingerprints();
    const inputHash = this.ctx.store.stageInputHash("solve", {
      candidate: candidate.candidate_id,
      task: generated.task.user_prompt,
      criteria: generated.task.acceptance_criteria,
      generation: this.ctx.config.generation,
      model: modelForRole(this.ctx.config, "solver"),
      harness: `${this.ctx.harness.name}@${this.ctx.harness.version}`,
      tools: HARNESS_TOOLS_VERSION,
      prompt: prompts.solver,
      image: prepared.solveImageRef,
    });
    const cached = this.ctx.store.getCachedStageOutput<SolveOutcome>(candidate.candidate_id, "solve", inputHash);
    if (cached) return cached;

    this.ctx.store.beginStage(candidate.candidate_id, "solve", inputHash);
    const attempts: SolveAttempt[] = [];
    let accepted: SolveAttempt | null = null;

    try {
      for (let attempt = 1; attempt <= this.ctx.config.generation.max_solver_attempts; attempt++) {
        this.throwIfCancelled();
        const budget = this.checkBudget();
        if (budget.exhausted) {
          this.ctx.logger.warn("solve: budget exhausted", { detail: budget.detail });
          break;
        }

        const result = await this.runAgent(candidate, prepared, generated.task, { attempt, role: "solver" });
        attempts.push(result.attempt);
        if (result.attempt.outcome === "completed" && result.attempt.result_tree_sha) {
          accepted = result.attempt;
          const outcome: SolveOutcome = {
            attempts,
            acceptedIndex: attempts.length - 1,
            answers: result.answers,
            solutionArchiveArtifact: result.solutionArchiveArtifact,
            solutionTreeSha: result.attempt.result_tree_sha,
          };
          this.ctx.store.completeStage(candidate.candidate_id, "solve", inputHash, outcome);
          this.ctx.store.setCandidateStatus(candidate.candidate_id, "solved");
          return outcome;
        }
        this.ctx.logger.info("solve attempt did not complete", {
          candidate: candidate.candidate_id,
          attempt,
          outcome: result.attempt.outcome,
          error: result.attempt.error ?? "",
        });
      }

      const outcome: SolveOutcome = {
        attempts,
        acceptedIndex: -1,
        answers: [],
        solutionArchiveArtifact: null,
        solutionTreeSha: null,
      };
      this.ctx.store.completeStage(candidate.candidate_id, "solve", inputHash, outcome);
      return outcome;
    } catch (error) {
      this.ctx.store.failStage(candidate.candidate_id, "solve", inputHash, (error as Error).message);
      throw error;
    } finally {
      void accepted;
    }
  }

  /**
   * One agent run from the prepared starting state.
   *
   * `solver` produces the teacher trajectories the dataset is built from; `policy` is the model
   * under training or evaluation in `forge rollout`. Both get the same container, tools, prompt
   * and limits, so their trajectories are directly comparable.
   */
  async runAgent(
    candidate: CandidateRow,
    prepared: PrepareOutput,
    task: TaskSpec,
    options: { attempt: number; role: "solver" | "policy"; idSalt?: string },
  ): Promise<{ attempt: SolveAttempt; answers: RecordedAnswer[]; solutionArchiveArtifact: string | null }> {
    const { attempt, role } = options;
    const recipe = prepared.recipe;
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const networkDuringSolve =
      this.ctx.config.sandbox.network_during_solve ||
      this.ctx.config.sandbox.dependency_policy === "allow_network_during_solve";

    const container = await this.ctx.backend.createContainer({
      ...this.containerOptions(recipe, prepared.solveImageRef),
      network: networkDuringSolve,
      label: "solve",
    });

    const simulator = new UserSimulator({
      task,
      provider: this.ctx.provider,
      model: modelForRole(this.ctx.config, "user_simulator"),
      maxQuestions: this.ctx.config.generation.max_user_questions,
      timeoutMs: this.ctx.config.sandbox.command_timeout_seconds * 1000,
      store: this.ctx.store,
      candidateId: candidate.candidate_id,
      logger: this.ctx.logger.child("user"),
    });

    try {
      // The workspace must carry no route back to the target before the solver touches it.
      const audit = await auditIsolation(container, {
        workdir: recipe.workdir,
        targetSha: candidate.target_sha,
        timeoutMs: this.ctx.config.sandbox.command_timeout_seconds * 1000,
      });
      if (!audit.clean) {
        throw new ForgeError(
          "grade_gate_isolation",
          `the solve workspace failed its isolation audit: ${audit.findings.join("; ")}`,
        );
      }

      const toolContext: ToolContext = {
        container,
        workdir: recipe.workdir,
        timeoutMs: this.ctx.config.sandbox.command_timeout_seconds * 1000,
        artifacts: this.ctx.artifacts,
        maxOutputChars: MAX_TOOL_OUTPUT_CHARS,
        askUser:
          this.ctx.config.generation.max_user_questions > 0 ? (question) => simulator.ask(question) : null,
        logger: this.ctx.logger.child("tools"),
        signal: this.ctx.signal,
      };

      const tools = toolsFor({ allowAskUser: this.ctx.config.generation.max_user_questions > 0 });
      const solverPrompt = loadPrompt("solver");

      const agentModel = modelForRole(this.ctx.config, role);
      const response = await this.ctx.harness.solve({
        userPrompt: task.user_prompt,
        systemPrompt: solverPrompt.text,
        tools,
        toolContext,
        maxTurns: this.ctx.config.generation.max_agent_turns,
        decisionSummaries: this.ctx.config.generation.decision_summaries,
        model: agentModel,
        timeoutMs: this.ctx.config.sandbox.task_timeout_seconds * 1000,
        signal: this.ctx.signal,
      });

      this.ctx.store.recordUsage(
        candidate.candidate_id,
        role,
        `${agentModel.provider}/${agentModel.model}`,
        response.usage,
        Date.now() - started,
      );

      let resultTreeSha: string | null = null;
      let patchArtifact: string | null = null;
      let archiveArtifact: string | null = null;

      if (response.outcome === "completed" || response.outcome === "aborted") {
        const tree = await currentTreeSha(
          container,
          recipe.workdir,
          this.ctx.config.sandbox.command_timeout_seconds * 1000,
        );
        resultTreeSha = tree.treeSha;
        const patch = await workspaceDiff(
          container,
          recipe.workdir,
          this.ctx.config.sandbox.command_timeout_seconds * 1000,
        );
        patchArtifact = await this.ctx.artifacts.put(patch);
        // The solution leaves the container as a tar so verification and replay can work on a
        // copy in containers the solver never touched.
        const archive = await container.getArchive(`${recipe.workdir}/.`);
        archiveArtifact = await this.ctx.artifacts.put(archive);
      }

      const record: SolveAttempt = {
        attempt,
        attempt_id: shortId("att", {
          candidate: candidate.candidate_id,
          attempt,
          ...(options.idSalt ? { salt: options.idSalt } : {}),
        }),
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        execution_mode: response.executionMode,
        harness: response.harness,
        harness_version: response.harnessVersion,
        model: `${agentModel.provider}/${agentModel.model}`,
        events: response.events,
        usage: response.usage,
        result_tree_sha: resultTreeSha,
        solution_patch_artifact: patchArtifact,
        outcome: response.outcome,
        error: response.error,
        rejection_cause: response.outcome === "completed" ? null : "solve_no_attempt_succeeded",
      };

      return { attempt: record, answers: simulator.recorded(), solutionArchiveArtifact: archiveArtifact };
    } finally {
      await container.destroy();
    }
  }

  // ---- verify -------------------------------------------------------------

  async verify(
    candidate: CandidateRow,
    prepared: PrepareOutput,
    generated: GenerateOutput,
    solved: SolveOutcome,
  ): Promise<VerificationResults> {
    const inputHash = this.ctx.store.stageInputHash("verify", {
      candidate: candidate.candidate_id,
      solutionTree: solved.solutionTreeSha,
      verification: this.ctx.config.verification,
      image: prepared.solveImageRef,
    });
    const cached = this.ctx.store.getCachedStageOutput<VerificationResults>(candidate.candidate_id, "verify", inputHash);
    if (cached) return cached;

    this.ctx.store.beginStage(candidate.candidate_id, "verify", inputHash);
    const results: VerificationResults = {
      exact_tree_match: false,
      normalized_tree_match: null,
      tree_diff_summary: [],
      behavioral_checks_passed: false,
      behavioral: null,
      replay_passed: false,
      replay: null,
      clean_runs_completed: 0,
      acceptance_mode: this.ctx.config.verification.acceptance_mode,
      accepted: false,
      rejection_cause: null,
    };

    try {
      if (!solved.solutionTreeSha || !solved.solutionArchiveArtifact) {
        results.rejection_cause = "solve_no_attempt_succeeded";
        this.ctx.store.completeStage(candidate.candidate_id, "verify", inputHash, results);
        return results;
      }

      const repo = this.repoFor(candidate);
      const recipe = prepared.recipe;
      const archive = await this.ctx.artifacts.get(solved.solutionArchiveArtifact);
      const timeoutMs = this.ctx.config.sandbox.task_timeout_seconds * 1000;

      // ---- A. exact reconstruction ----------------------------------------
      const comparisonContainer = await this.ctx.backend.createContainer({
        ...this.containerOptions(recipe, prepared.solveImageRef),
        network: false,
        label: "verify",
      });
      try {
        const { restoreWorkspace } = await import("./environments/workspace.ts");
        const restored = await restoreWorkspace(comparisonContainer, archive, {
          workdir: recipe.workdir,
          expectedTreeSha: solved.solutionTreeSha,
          timeoutMs,
          owner: this.ctx.config.sandbox.run_as,
        });
        if (!restored.fidelityOk) {
          throw new ForgeError(
            "internal_error",
            `the solution restored for comparison hashes to ${restored.treeSha}, but the solve ` +
              `container reported ${solved.solutionTreeSha}; the comparison would not be measuring ` +
              `the solver's actual result`,
          );
        }
        const comparison = await compareTrees({
          git: repo.git,
          targetSha: candidate.target_sha,
          resultTreeSha: solved.solutionTreeSha,
          container: comparisonContainer,
          workdir: recipe.workdir,
          timeoutMs,
          computeNormalizedDiagnostic: true,
        });
        results.exact_tree_match = comparison.exact;
        results.normalized_tree_match = comparison.normalizedMatch;
        results.tree_diff_summary = comparison.differences.slice(0, 200);
      } finally {
        await comparisonContainer.destroy();
      }

      // ---- B. functional equivalence --------------------------------------
      if (this.ctx.config.verification.acceptance_mode !== "exact_tree" || !results.exact_tree_match) {
        const behavioral = await runBehavioralChecks({
          identity: candidate.identity,
          task: generated.task,
          environment: prepared.verification,
          recipe,
          backend: this.ctx.backend,
          containerOptions: this.containerOptions(recipe, prepared.solveImageRef),
          solutionArchive: archive,
          solutionTreeSha: solved.solutionTreeSha,
          hiddenTestPaths: prepared.changedTestPaths,
          git: repo.git,
          artifacts: this.ctx.artifacts,
          timeoutMs,
          requireFailToPass: this.ctx.config.verification.require_fail_to_pass,
          networkDuringVerify: false,
          runAs: this.ctx.config.sandbox.run_as,
          signal: this.ctx.signal,
        });
        results.behavioral = behavioral;
        results.behavioral_checks_passed = behavioral.passed;
      } else {
        // An exactly reconstructed tree is the target tree, whose suite already ran green during
        // preparation. Re-running it would measure the same thing twice.
        results.behavioral_checks_passed = true;
      }

      // ---- clean runs ------------------------------------------------------
      results.clean_runs_completed = await this.runCleanRuns(prepared, archive, solved.solutionTreeSha);

      // ---- C. replay -------------------------------------------------------
      if (this.ctx.config.verification.replay_required) {
        const acceptedAttempt = solved.attempts[solved.acceptedIndex];
        if (!acceptedAttempt) {
          results.rejection_cause = "verify_replay_not_run";
        } else {
          const replay = await replayTrajectory({
            events: acceptedAttempt.events,
            // No archive: the prepared image already holds exactly the state the solver started
            // from, and the replay verifies its tree hash before re-executing anything.
            parentTreeSha: candidate.identity.parent_tree_sha,
            expectedTreeSha: solved.solutionTreeSha,
            recipe,
            backend: this.ctx.backend,
            containerOptions: this.containerOptions(recipe, prepared.solveImageRef),
            tools: toolsFor({ allowAskUser: true }),
            artifacts: this.ctx.artifacts,
            timeoutMs,
            maxOutputChars: MAX_TOOL_OUTPUT_CHARS,
            network: false,
            logger: this.ctx.logger,
            runAs: this.ctx.config.sandbox.run_as,
            expectedFinalTestsGreen: results.behavioral?.pass_to_pass_run
              ? results.behavioral.pass_to_pass_run.command.exit_code === 0
              : null,
            signal: this.ctx.signal,
          });
          results.replay = replay;
          results.replay_passed = replay.passed;
        }
      }

      // ---- acceptance ------------------------------------------------------
      this.decideAcceptance(results);
      this.ctx.store.completeStage(candidate.candidate_id, "verify", inputHash, results);
      if (results.accepted) this.ctx.store.setCandidateStatus(candidate.candidate_id, "verified");
      return results;
    } catch (error) {
      this.ctx.store.failStage(candidate.candidate_id, "verify", inputHash, (error as Error).message);
      throw error;
    }
  }

  /**
   * Independent clean runs of the reference suite over the solution.
   *
   * Each run starts a fresh container. A suite that only passes sometimes is not evidence, and
   * counting the runs makes flakiness visible instead of hiding behind one lucky execution.
   */
  private async runCleanRuns(
    prepared: PrepareOutput,
    archive: Buffer,
    solutionTreeSha: string,
  ): Promise<number> {
    const { restoreWorkspace } = await import("./environments/workspace.ts");
    const { runTests } = await import("./environments/run.ts");
    let completed = 0;

    for (let run = 0; run < this.ctx.config.verification.clean_runs; run++) {
      this.throwIfCancelled();
      const container = await this.ctx.backend.createContainer({
        ...this.containerOptions(prepared.recipe, prepared.solveImageRef),
        network: false,
        label: "verify",
      });
      try {
        const restored = await restoreWorkspace(container, archive, {
          workdir: prepared.recipe.workdir,
          expectedTreeSha: solutionTreeSha,
          timeoutMs: this.ctx.config.sandbox.task_timeout_seconds * 1000,
          owner: this.ctx.config.sandbox.run_as,
        });
        if (!restored.fidelityOk) {
          throw new ForgeError(
            "internal_error",
            `clean run ${run + 1} restored a workspace hashing to ${restored.treeSha}, expected ` +
              `${solutionTreeSha}`,
          );
        }
        const result = await runTests({
          container,
          recipe: prepared.recipe,
          workdir: prepared.recipe.workdir,
          timeoutMs: this.ctx.config.sandbox.task_timeout_seconds * 1000,
          artifacts: this.ctx.artifacts,
          label: `clean_run_${run + 1}`,
          signal: this.ctx.signal,
        });
        if (result.command.exit_code === 0) completed++;
      } finally {
        await container.destroy();
      }
    }
    return completed;
  }

  private decideAcceptance(results: VerificationResults): void {
    const mode = this.ctx.config.verification.acceptance_mode;
    const modalitySatisfied =
      mode === "exact_tree"
        ? results.exact_tree_match
        : mode === "behavioral"
          ? results.behavioral_checks_passed
          : results.exact_tree_match || results.behavioral_checks_passed;

    if (!modalitySatisfied) {
      results.accepted = false;
      results.rejection_cause = "verify_acceptance_not_met";
      return;
    }
    if (results.behavioral && results.behavioral.regressions.length > 0) {
      results.accepted = false;
      results.rejection_cause = "verify_regression";
      return;
    }
    if (
      this.ctx.config.verification.require_fail_to_pass &&
      results.behavioral &&
      results.behavioral.fail_to_pass_run === null &&
      results.behavioral.structural_checks.length === 0
    ) {
      results.accepted = false;
      results.rejection_cause = "verify_no_fail_to_pass_evidence";
      return;
    }
    if (results.clean_runs_completed < this.ctx.config.verification.clean_runs) {
      results.accepted = false;
      results.rejection_cause = "verify_acceptance_not_met";
      return;
    }
    if (this.ctx.config.verification.replay_required && !results.replay_passed) {
      results.accepted = false;
      results.rejection_cause = results.replay ? "verify_replay_divergence" : "verify_replay_not_run";
      return;
    }
    results.accepted = true;
    results.rejection_cause = null;
  }

  // ---- scoring (judge, rollouts, external trajectories) -------------------

  /**
   * Judge a trajectory. The measured outcome is passed in as ground truth; the judge cannot
   * change it, only describe what the tests cannot see.
   */
  async judge(
    candidate: CandidateRow,
    input: {
      task: TaskSpec;
      events: readonly TrajectoryEvent[];
      solutionPatch: string;
      verifiable: VerifiableOutcome;
      failingChecks: readonly string[];
    },
  ): Promise<Judgment> {
    const config = this.ctx.config;
    let referencePatch: string | null = null;
    if (config.judge.show_reference_patch) {
      await this.ensureRepositories();
      const filters = effectiveFilters(config, config.repositories.find((r) => r.url === candidate.repository_url)!);
      referencePatch = await this.repoFor(candidate).git.patch(
        candidate.parent_sha,
        candidate.target_sha,
        filters.rename_similarity,
      );
    }
    return judgeTrajectory({
      ...input,
      referencePatch,
      provider: this.ctx.provider,
      model: modelForRole(config, "judge"),
      config: config.judge,
      store: this.ctx.store,
      candidateId: candidate.candidate_id,
      timeoutMs: config.sandbox.task_timeout_seconds * 1000,
      signal: this.ctx.signal,
    });
  }

  /**
   * Score one finished solution: hidden tests in a clean container, then (optionally) the judge,
   * then the reward. Used for policy rollouts and for externally produced trajectories alike.
   */
  async scoreSolution(
    candidate: CandidateRow,
    prepared: PrepareOutput,
    input: {
      task: TaskSpec;
      events: readonly TrajectoryEvent[];
      archive: Buffer | null;
      treeSha: string | null;
      solutionPatch: string;
      agentCompleted: boolean;
      judge: boolean;
    },
  ): Promise<{
    behavioral: BehavioralChecks | null;
    verifiable: VerifiableOutcome;
    judgment: Judgment | null;
    reward: RewardBreakdown;
  }> {
    await this.ensureRepositories();
    const config = this.ctx.config;
    let behavioral: BehavioralChecks | null = null;
    if (input.archive && input.treeSha) {
      behavioral = await runBehavioralChecks({
        identity: candidate.identity,
        task: input.task,
        environment: prepared.verification,
        recipe: prepared.recipe,
        backend: this.ctx.backend,
        containerOptions: this.containerOptions(prepared.recipe, prepared.solveImageRef),
        solutionArchive: input.archive,
        solutionTreeSha: input.treeSha,
        hiddenTestPaths: prepared.changedTestPaths,
        git: this.repoFor(candidate).git,
        artifacts: this.ctx.artifacts,
        timeoutMs: config.sandbox.task_timeout_seconds * 1000,
        requireFailToPass: config.verification.require_fail_to_pass,
        networkDuringVerify: false,
        runAs: config.sandbox.run_as,
        signal: this.ctx.signal,
      });
    }

    const verifiable = verifiableOutcome(behavioral, {
      agentCompleted: input.agentCompleted && input.treeSha !== null,
      // Equal tree hashes are byte-identical trees, by construction of git's object model.
      exactTreeMatch: input.treeSha ? input.treeSha === candidate.identity.target_tree_sha : null,
      failToPassTotal: prepared.verification.fail_to_pass.length,
    });

    let judgment: Judgment | null = null;
    if (input.judge && input.treeSha) {
      try {
        judgment = await this.judge(candidate, {
          task: input.task,
          events: input.events,
          solutionPatch: input.solutionPatch,
          verifiable,
          failingChecks: [...(behavioral?.fail_to_pass_missing ?? []), ...(behavioral?.regressions ?? [])],
        });
      } catch (error) {
        // A judge failure leaves the reward purely verifiable and says so; it never invents a score.
        this.ctx.logger.warn("judge failed; reward falls back to verifiable evidence", {
          candidate: candidate.candidate_id,
          error: (error as Error).message.slice(0, 300),
        });
      }
    }

    return { behavioral, verifiable, judgment, reward: composeReward(verifiable, judgment, config.reward) };
  }

  /**
   * Re-execute the tool calls of an externally produced trajectory from the prepared starting
   * state and return what really happened.
   *
   * The supplied tool results are never trusted: each call runs again, the real result replaces
   * the supplied one, and any difference is reported as a mismatch. `ask_user` calls do not touch
   * the workspace and are kept as supplied.
   */
  async executeTrajectory(
    candidate: CandidateRow,
    prepared: PrepareOutput,
    events: readonly TrajectoryEvent[],
  ): Promise<{
    events: TrajectoryEvent[];
    mismatches: Array<{ tool_call_id: string; detail: string }>;
    treeSha: string | null;
    patch: string;
    archive: Buffer | null;
    error: string | null;
  }> {
    const recipe = prepared.recipe;
    const timeoutMs = this.ctx.config.sandbox.command_timeout_seconds * 1000;
    const container = await this.ctx.backend.createContainer({
      ...this.containerOptions(recipe, prepared.solveImageRef),
      network: false,
      label: "score",
    });
    const tools = toolsFor({ allowAskUser: false });
    const out: TrajectoryEvent[] = [];
    const mismatches: Array<{ tool_call_id: string; detail: string }> = [];
    try {
      const start = await currentTreeSha(container, recipe.workdir, timeoutMs);
      if (start.treeSha !== candidate.identity.parent_tree_sha) {
        return {
          events: [...events],
          mismatches,
          treeSha: null,
          patch: "",
          archive: null,
          error: `the starting state hashes to ${start.treeSha}, expected ${candidate.identity.parent_tree_sha}`,
        };
      }
      const toolContext: ToolContext = {
        container,
        workdir: recipe.workdir,
        timeoutMs,
        artifacts: this.ctx.artifacts,
        maxOutputChars: MAX_TOOL_OUTPUT_CHARS,
        askUser: null,
        logger: this.ctx.logger.child("score"),
        signal: this.ctx.signal,
      };
      const supplied = new Map(
        events.filter((e) => e.type === "tool_result" && e.tool_call_id).map((e) => [e.tool_call_id as string, e]),
      );
      for (const event of events) {
        this.throwIfCancelled();
        // Supplied results are replaced by the real ones, emitted right after their call.
        if (event.type === "tool_result") continue;
        out.push(event);
        if (event.type !== "tool_call") continue;

        const id = event.tool_call_id ?? event.event_id;
        const original = supplied.get(id);
        if (original?.origin === "harness") {
          // Refused by the producing harness without running; replaying it would change the outcome.
          out.push(original);
          continue;
        }
        const tool = tools.find((t) => t.name === event.tool_name);
        let outcome: { output: unknown; text: string; isError: boolean; truncated: boolean; fullOutputArtifact: string | null };
        if (!tool) {
          const message = `unknown tool "${event.tool_name}"`;
          outcome = { output: { error: message }, text: message, isError: true, truncated: false, fullOutputArtifact: null };
        } else {
          try {
            outcome = await tool.execute(tool.parse(event.tool_input), toolContext);
          } catch (error) {
            const message = `${tool.name} failed: ${(error as Error).message}`;
            outcome = { output: { error: message }, text: message, isError: true, truncated: false, fullOutputArtifact: null };
          }
        }
        const mismatch = original ? compareSuppliedResult(original, outcome) : null;
        if (mismatch) mismatches.push({ tool_call_id: id, detail: mismatch });
        out.push(toolResultEvent(event, id, outcome, original?.event_id));
      }
      const tree = await currentTreeSha(container, recipe.workdir, timeoutMs);
      const patch = await workspaceDiff(container, recipe.workdir, timeoutMs);
      const archive = await container.getArchive(`${recipe.workdir}/.`);
      return { events: out, mismatches, treeSha: tree.treeSha, patch, archive: Buffer.from(archive), error: null };
    } finally {
      await container.destroy();
    }
  }

  /** The prepared environment for a candidate, rebuilding the image if cleanup removed it. */
  async preparedFor(candidate: CandidateRow): Promise<PrepareOutput> {
    await this.ensureRepositories();
    return this.prepare(candidate);
  }


  // ---- sample assembly ----------------------------------------------------

  async buildSample(
    candidate: CandidateRow,
    prepared: PrepareOutput,
    graded: GradeOutput,
    generated: GenerateOutput,
    solved: SolveOutcome,
    verification: VerificationResults,
  ): Promise<{ sample: Sample; manifest: EvaluatorManifest }> {
    const repo = this.repoFor(candidate);
    const filters = effectiveFilters(
      this.ctx.config,
      this.ctx.config.repositories.find((r) => r.url === candidate.repository_url)!,
    );
    const patch = await repo.git.patch(candidate.parent_sha, candidate.target_sha, filters.rename_similarity);
    const patchArtifact = await this.ctx.artifacts.put(patch);
    const acceptedAttempt = solved.attempts[solved.acceptedIndex];
    const solverModel = modelForRole(this.ctx.config, "solver");

    const totalUsage: TokenUsage = solved.attempts.reduce<TokenUsage>(
      (acc, a) => ({
        input_tokens: acc.input_tokens + a.usage.input_tokens,
        output_tokens: acc.output_tokens + a.usage.output_tokens,
        cache_read_tokens: acc.cache_read_tokens + a.usage.cache_read_tokens,
        cache_write_tokens: acc.cache_write_tokens + a.usage.cache_write_tokens,
        cost_usd:
          acc.cost_known && a.usage.cost_known ? (acc.cost_usd ?? 0) + (a.usage.cost_usd ?? 0) : null,
        cost_known: acc.cost_known && a.usage.cost_known,
      }),
      { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0, cost_known: true },
    );

    const executionMode = acceptedAttempt?.execution_mode ?? "scripted_fixture";
    const wallClock = solved.attempts.reduce(
      (ms, a) => ms + (Date.parse(a.finished_at) - Date.parse(a.started_at)),
      0,
    );

    const sample: Sample = {
      schema_version: DATASET_SCHEMA_VERSION,
      sample_id: shortId("sample", { candidate: candidate.candidate_id, run: this.ctx.runId }),
      run_id: this.ctx.runId,
      created_at: new Date().toISOString(),
      source: {
        repository_url: candidate.repository_url,
        repository_family: candidate.repository_family,
        resolved_ref_sha: candidate.identity.resolved_ref_sha,
        license: repo.license.spdx,
        license_source: repo.license.source,
        attribution_notice: repo.license.notice ? repo.license.notice.slice(0, 2000) : null,
      },
      metrics: candidate.metrics,
      task: generated.task,
      task_review: generated.review,
      environment: {
        recipe_id: prepared.verification.recipe_id,
        image_ref: prepared.verification.image_ref,
        image_digest: prepared.verification.image_digest,
        recipe_hash: prepared.recipeHash,
        ecosystem: prepared.recipe.ecosystem,
        workdir: prepared.recipe.workdir,
      },
      agent: {
        harness: this.ctx.harness.name,
        harness_version: this.ctx.harness.version,
        adapter_version: ADAPTER_VERSION,
        model: `${solverModel.provider}/${solverModel.model}`,
        thinking_level: solverModel.thinking,
        tool_names: toolsFor({ allowAskUser: this.ctx.config.generation.max_user_questions > 0 }).map((t) => t.name),
        execution_mode: executionMode,
        system_prompt: loadPrompt("solver").text,
        system_prompt_version: loadPrompt("solver").version,
        tool_schemas: toolSchemas(toolsFor({ allowAskUser: this.ctx.config.generation.max_user_questions > 0 })),
      },
      attempts: solved.attempts,
      accepted_attempt_index: Math.max(0, solved.acceptedIndex),
      events: acceptedAttempt?.events ?? [],
      verification,
      budget: {
        usage: totalUsage,
        wall_clock_ms: Math.max(0, wallClock),
        solved_on_first_attempt: solved.acceptedIndex === 0,
        solved_within_budget: solved.acceptedIndex >= 0 && !this.checkBudget().exhausted,
      },
      split: null,
      quality: {
        environment_verified: prepared.verification.ok,
        task_sufficiently_specified: generated.review.sufficient,
        no_leak_detected: !generated.review.leaks_solution && generated.deterministicLeaks.length === 0,
        tools_executed: (acceptedAttempt?.events ?? []).some((e) => e.type === "tool_result" && e.origin === "executed_tool"),
        relevant_tests_present: prepared.verification.fail_to_pass.length > 0 || generated.task.task_type === "refactor",
        replay_ok: verification.replay_passed || !this.ctx.config.verification.replay_required,
        acceptance_satisfied: verification.accepted,
        // Filled by the export stage, which is where the scans run.
        secrets_scan_clean: true,
        license_ok: true,
        real_execution: executionMode === "real_model",
      },
      dedup_keys: buildDedupKeys({
        repositoryUrl: candidate.repository_url,
        targetSha: candidate.target_sha,
        repositoryFamily: candidate.repository_family,
        patch,
        userPrompt: generated.task.user_prompt,
        acceptanceCriteria: generated.task.acceptance_criteria,
      }),
    };

    const manifest: EvaluatorManifest = {
      target_sha: candidate.target_sha,
      parent_sha: candidate.parent_sha,
      target_tree_sha: candidate.identity.target_tree_sha,
      parent_tree_sha: candidate.identity.parent_tree_sha,
      commit_subject: candidate.identity.subject,
      commit_message: await repo.git.commitMessage(candidate.target_sha),
      target_patch_artifact: patchArtifact,
      grade: graded.grade,
      environment: prepared.verification,
      hidden_test_ids: prepared.changedTestPaths,
    };

    return { sample, manifest };
  }
}

export interface SolveOutcome {
  attempts: SolveAttempt[];
  /** Index of the attempt that completed, or -1 when none did. */
  acceptedIndex: number;
  answers: RecordedAnswer[];
  solutionArchiveArtifact: string | null;
  solutionTreeSha: string | null;
}

/**
 * Compare a supplied tool result with its re-execution.
 *
 * Two tiers. A different exit code or error status is a hard mismatch: the supplied run did not
 * end the way the command ends. Otherwise the text is compared after masking what legitimately
 * varies between runs — durations, clock times, dates, memory addresses — so a reworded or
 * fabricated output ("999 passed") is caught while "127 passed in 0.58s" vs "in 0.63s" is not.
 */
export function compareSuppliedResult(
  supplied: TrajectoryEvent,
  real: { output: unknown; text: string; isError: boolean },
): string | null {
  const suppliedExit = exitCodeOf(supplied.tool_output, supplied.text ?? "");
  const realExit = exitCodeOf(real.output, real.text);
  if (suppliedExit !== null && realExit !== null && suppliedExit !== realExit) {
    return `exit_code: supplied ${suppliedExit}, re-execution ${realExit}`;
  }
  if (supplied.tool_is_error !== null && supplied.tool_is_error !== real.isError) {
    return `error_status: supplied ${supplied.tool_is_error}, re-execution ${real.isError}`;
  }
  const a = maskVolatile(supplied.text ?? "");
  if (a === "") return null;
  if (a !== maskVolatile(real.text)) {
    return `content: supplied output differs from re-execution beyond timing noise; supplied began ${JSON.stringify((supplied.text ?? "").slice(0, 100))}`;
  }
  return null;
}

function exitCodeOf(output: unknown, text: string): number | null {
  const structured = (output as { exit_code?: unknown } | null)?.exit_code;
  if (typeof structured === "number") return structured;
  const match = /^exit: (-?\d+)/m.exec(text);
  return match ? Number(match[1]) : null;
}

export function maskVolatile(text: string): string {
  return text
    .replace(/duration: \d+ms/g, "duration: <t>")
    .replace(/\b\d+(\.\d+)?\s?(ms|s|sec|seconds)\b/g, "<t>")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
    .replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(\d{2}:\d{2}|\d{4})\b/g, "<date>")
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, "<time>")
    .replace(/0x[0-9a-fA-F]{6,}/g, "<addr>")
    // `ls -l` block totals depend on the filesystem, not on what the command saw.
    .replace(/^total \d+$/gm, "total <n>")
    .replace(/[ \t]+$/gm, "")
    .trimEnd();
}

function toolResultEvent(
  call: TrajectoryEvent,
  toolCallId: string,
  outcome: { output: unknown; text: string; isError: boolean; truncated: boolean; fullOutputArtifact: string | null },
  eventId?: string,
): TrajectoryEvent {
  return {
    event_id: eventId ?? `${call.event_id}_result`,
    seq: call.seq,
    role: "tool",
    type: "tool_result",
    origin: "executed_tool",
    timestamp: new Date().toISOString(),
    text: outcome.text,
    tool_call_id: toolCallId,
    tool_name: call.tool_name,
    tool_input: null,
    tool_output: outcome.output,
    tool_is_error: outcome.isError,
    truncated: outcome.truncated,
    full_output_artifact: outcome.fullOutputArtifact,
    decision_summary: null,
  };
}
