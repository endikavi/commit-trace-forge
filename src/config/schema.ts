import { z } from "zod";

/**
 * Configuration schema. Every field is documented in docs/config.md with units and interactions.
 * The schema is versioned: `schema_version` must match CONFIG_SCHEMA_VERSION.
 */

export const CONFIG_SCHEMA_VERSION = 1;

const Range = z
  .object({
    min: z.number().int().min(0).optional(),
    max: z.number().int().min(0).optional(),
  })
  .refine((r) => r.min === undefined || r.max === undefined || r.min <= r.max, {
    message: "min must be <= max",
  });
export type Range = z.infer<typeof Range>;

/** Deterministic screening applied before any model call. */
const Filters = z.object({
  /** added + deleted lines, counted on text hunks of the commit diff against its first parent. */
  changed_lines: Range.default({ min: 10, max: 300 }),
  /** Lines added only. Applied in addition to changed_lines when present. */
  added_lines: Range.optional(),
  /** Lines deleted only. Applied in addition to changed_lines when present. */
  deleted_lines: Range.optional(),
  /** Number of file entries in the diff. Rename policy is controlled by `rename_counts_as`. */
  changed_files: Range.default({ min: 1, max: 8 }),
  /**
   * How a rename contributes to `changed_files`:
   *  - "one_entry": R100 counts as a single changed file (default, matches `git diff -M` entries)
   *  - "two_entries": counts as a delete + an add
   */
  rename_counts_as: z.enum(["one_entry", "two_entries"]).default("one_entry"),
  /** Rename similarity threshold (percent) passed to git as -M<n>%. */
  rename_similarity: z.number().int().min(1).max(100).default(50),

  exclude_merges: z.boolean().default(true),
  exclude_root_commits: z.boolean().default(true),
  exclude_binary_changes: z.boolean().default(true),
  exclude_submodule_changes: z.boolean().default(true),
  exclude_symlink_changes: z.boolean().default(false),
  exclude_generated_only: z.boolean().default(true),
  exclude_vendored_only: z.boolean().default(true),
  exclude_formatting_only: z.boolean().default(true),
  /**
   * Reject commits whose only changes are lockfiles. A lockfile touched *alongside* real source
   * changes is kept: lockfiles are frequently required for a valid dependency-changing task.
   */
  exclude_lockfile_only: z.boolean().default(true),

  /** Glob patterns (minimatch-style, '/'-separated) treated as generated output. */
  generated_globs: z
    .array(z.string())
    .default([
      "**/*.min.js",
      "**/*.min.css",
      "**/*_pb2.py",
      "**/*_pb2_grpc.py",
      "**/*.pb.go",
      "**/*.generated.*",
      "**/generated/**",
      "**/__generated__/**",
      "**/*.snap",
      "**/dist/**",
      "**/build/**",
      "**/*.map",
    ]),
  /** Glob patterns treated as vendored third-party code. */
  vendored_globs: z
    .array(z.string())
    .default(["**/vendor/**", "**/third_party/**", "**/node_modules/**", "**/.venv/**", "**/site-packages/**"]),
  /** Glob patterns treated as dependency lockfiles. */
  lockfile_globs: z
    .array(z.string())
    .default([
      "**/package-lock.json",
      "**/pnpm-lock.yaml",
      "**/yarn.lock",
      "**/poetry.lock",
      "**/Pipfile.lock",
      "**/uv.lock",
      "**/requirements*.txt",
      "**/Cargo.lock",
      "**/go.sum",
    ]),
  /**
   * Paths removed from the diff before the *filtered* metrics are computed. Raw metrics are
   * always stored too, so a rejection can be explained against both views.
   */
  exclude_path_globs: z.array(z.string()).default([]),
  /** Only commits touching at least one of these paths are eligible. Empty = no restriction. */
  include_path_globs: z.array(z.string()).default([]),

  /** ISO-8601 timestamps (inclusive). Compared against the commit's author date. */
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),

  /** A commit is rejected if it adds a path that the parent's .gitignore would ignore. */
  exclude_target_gitignored_paths: z.boolean().default(true),
});
export type Filters = z.infer<typeof Filters>;

/** Per-repository declaration. */
const Repository = z.object({
  url: z.string().min(1),
  /** Branch, tag or SHA. Resolved to a fixed SHA at the start of `forge mine`. */
  ref: z.string().default("HEAD"),
  /**
   * Upper bound on *accepted* samples contributed by this repository.
   * Interacts with sampling.target_samples: the global target is the binding constraint.
   */
  max_samples: z.number().int().min(1).optional(),
  /** Stable grouping key used for splits and dedup. Defaults to the derived repo family. */
  family: z.string().optional(),
  /** Ecosystem hint. "auto" detects from the repository contents. */
  ecosystem: z.enum(["auto", "python", "node"]).default("auto"),
  /** Per-repository overrides merged over the global `filters` block. */
  filters: Filters.partial().optional(),
  /** Per-repository environment recipe override. */
  environment: z
    .object({
      base_image: z.string().optional(),
      setup_commands: z.array(z.string()).optional(),
      test_command: z.array(z.string()).optional(),
      /** Command that runs a subset of tests; `{tests}` is substituted with space-joined node ids. */
      test_selection_command: z.array(z.string()).optional(),
      workdir: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  /** SPDX id if known. Unknown licenses are flagged pending review, not silently accepted. */
  license: z.string().optional(),
});
export type RepositoryConfig = z.infer<typeof Repository>;

const Sampling = z.object({
  /** Number of ACCEPTED samples wanted. Not the number of commits inspected. */
  target_samples: z.number().int().min(1).default(100),
  /** "global": target_samples across all repos. "per_repository": target_samples for each repo. */
  target_scope: z.enum(["global", "per_repository"]).default("global"),
  /** Hard cap on commits pulled into the candidate population. */
  max_candidates: z.number().int().min(1).default(2000),
  /**
   *  - uniform_over_eligible_commits: one flat draw over every eligible commit of every repo
   *  - uniform_by_repo_then_commit: pick a repo uniformly, then a commit uniformly inside it
   */
  strategy: z
    .enum(["uniform_over_eligible_commits", "uniform_by_repo_then_commit"])
    .default("uniform_by_repo_then_commit"),
  without_replacement: z.boolean().default(true),
});
export type Sampling = z.infer<typeof Sampling>;

const Grading = z.object({
  /** Weighted 0-100 total required to proceed. */
  min_score: z.number().min(0).max(100).default(80),
  /** Per-dimension minimums on the raw 0-5 scale. */
  min_task_clarity: z.number().min(0).max(5).default(3),
  min_testability: z.number().min(0).max(5).default(3),
  min_context_independence: z.number().min(0).max(5).default(3),
  min_change_coherence: z.number().min(0).max(5).default(3),
  min_training_value: z.number().min(0).max(5).default(2),
  min_environment_reproducibility: z.number().min(0).max(5).default(3),
  /** Dimension weights; must sum to 1. */
  weights: z
    .object({
      task_clarity: z.number().min(0).max(1).default(0.2),
      testability: z.number().min(0).max(1).default(0.25),
      context_independence: z.number().min(0).max(1).default(0.2),
      change_coherence: z.number().min(0).max(1).default(0.15),
      training_value: z.number().min(0).max(1).default(0.1),
      environment_reproducibility: z.number().min(0).max(1).default(0.1),
    })
    .prefault({})
    .refine((w) => Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 1e-9, {
      message: "grading.weights must sum to 1",
    }),
});
export type Grading = z.infer<typeof Grading>;

const Generation = z.object({
  /** Language of all synthetic text. Only "en" is supported; real tool output is never translated. */
  language: z.literal("en").default("en"),
  task_variants: z.number().int().min(1).max(5).default(1),
  max_solver_attempts: z.number().int().min(1).max(10).default(2),
  max_user_questions: z.number().int().min(0).max(10).default(2),
  /** Emit short decision summaries alongside actions (never chain-of-thought). */
  decision_summaries: z.boolean().default(true),
  /** Maximum agent turns before the solve attempt is abandoned. */
  max_agent_turns: z.number().int().min(1).default(60),
});
export type Generation = z.infer<typeof Generation>;

const Verification = z.object({
  /**
   *  - exact_tree:  only byte-identical versioned trees are accepted
   *  - behavioral:  only behavioural checks are required
   *  - either:      accept if exact_tree OR behavioural checks pass
   */
  acceptance_mode: z.enum(["exact_tree", "behavioral", "either"]).default("exact_tree"),
  replay_required: z.boolean().default(true),
  /** Number of independent clean runs of the reference test suites. */
  clean_runs: z.number().int().min(1).max(10).default(2),
  /**
   * Strict MVP mode: a parent baseline with pre-existing failures rejects the candidate.
   * When false, pre-existing failures are recorded and excluded from regression comparison.
   */
  strict_baseline: z.boolean().default(true),
  /** Require at least one check that fails at parent and passes at target (bugfix/feature only). */
  require_fail_to_pass: z.boolean().default(true),
});
export type Verification = z.infer<typeof Verification>;

const Sandbox = z.object({
  backend: z.enum(["docker", "local"]).default("docker"),
  /**
   * Argv prefix used to reach the container CLI. Default ["docker"]. On a Windows host with the
   * daemon inside WSL use e.g. ["wsl","-d","Ubuntu","-e","docker"].
   */
  docker_command: z.array(z.string()).min(1).default(["docker"]),
  /** Network policy while the solver runs. Provisioning always gets network. */
  network_during_solve: z.boolean().default(false),
  cpu_limit: z.number().min(0.1).default(2),
  memory_mb: z.number().int().min(256).default(4096),
  pids_limit: z.number().int().min(16).default(256),
  /** Wall-clock cap for one task (solve + verification) in seconds. */
  task_timeout_seconds: z.number().int().min(30).default(1200),
  /** Wall-clock cap for a single command inside the sandbox, in seconds. */
  command_timeout_seconds: z.number().int().min(5).default(300),
  /** uid:gid the workload runs as. Must not be root. */
  run_as: z.string().regex(/^\d+:\d+$/).default("1000:1000"),
  /** Seconds allowed for image build / dependency provisioning. */
  provision_timeout_seconds: z.number().int().min(60).default(1800),
  /**
   * What to do when reaching the target requires dependencies the parent does not declare.
   *  - reject_new: discard the candidate with cause `env_dependency_unresolvable_offline` (strict MVP)
   *  - offline_store: pre-download the delta into a read-only store the solver can install from.
   *    This reveals the NAMES of the newly available packages to a solver that lists the store,
   *    though never the target diff or the future manifests. Opt in knowingly.
   *  - allow_network_during_solve: let the solver reach the network for this candidate. Recorded
   *    on the sample so the relaxed isolation is visible in the dataset.
   */
  dependency_policy: z
    .enum(["reject_new", "offline_store", "allow_network_during_solve"])
    .default("reject_new"),
});
export type SandboxConfig = z.infer<typeof Sandbox>;

const Model = z.object({
  /** Pi provider id, as configured in the pi agent dir's models.json (or a built-in provider). */
  provider: z.string().default("anthropic"),
  /** Model id within the provider. */
  model: z.string().default("claude-sonnet-4-5"),
  /** Pi thinking level. "off" keeps provider reasoning blocks out of the pipeline entirely. */
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).default("off"),
  /** Override the pi agent directory (auth.json / models.json). Defaults to pi's own resolution. */
  agent_dir: z.string().optional(),
  /** Per-role overrides. Any omitted field falls back to the block above. */
  roles: z
    .partialRecord(
      z.enum(["grader", "taskgen", "taskreview", "solver", "user_simulator", "judge", "policy"]),
      z.object({
        provider: z.string().optional(),
        model: z.string().optional(),
        thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
      }),
    )
    .prefault({}),
});
export type ModelConfig = z.infer<typeof Model>;

const Budgets = z.object({
  max_total_tokens: z.number().int().min(1).default(2_000_000),
  /** USD. Applied only to calls whose model has a known price; unknown prices are reported. */
  max_total_cost_usd: z.number().min(0).default(100),
  max_parallel_tasks: z.number().int().min(1).max(32).default(2),
  /** Hard cap on candidates taken through environment preparation. */
  max_prepared_candidates: z.number().int().min(1).optional(),
  /** Wall clock for the whole run, in seconds. 0 disables. */
  max_wall_clock_seconds: z.number().int().min(0).default(0),
});
export type Budgets = z.infer<typeof Budgets>;

const Export = z.object({
  /**
   *  - jsonl:         samples.jsonl, the canonical records
   *  - conversations: conversations.jsonl, provenance-labelled messages with `train` masks
   *  - openai_chat:   sft-openai.jsonl, OpenAI chat format with tools and per-message `weight`
   *  - rl_tasks:      rl-tasks.jsonl (policy side) and rl-reward-spec.jsonl (reserved)
   */
  formats: z
    .array(z.enum(["jsonl", "conversations", "openai_chat", "rl_tasks"]))
    .min(1)
    .default(["jsonl", "conversations", "openai_chat", "rl_tasks"]),
  /** Grouping used to keep related variants together. */
  split_by: z.enum(["repository_family", "repository", "none"]).default("repository_family"),
  splits: z
    .object({
      train: z.number().min(0).max(1).default(0.8),
      validation: z.number().min(0).max(1).default(0.1),
      test: z.number().min(0).max(1).default(0.1),
    })
    .prefault({})
    .refine((s) => Math.abs(s.train + s.validation + s.test - 1) < 1e-9, {
      message: "export.splits must sum to 1",
    }),
  /** Include short decision summaries as assistant targets. */
  include_decision_summaries: z.boolean().default(true),
  /** Include post-hoc annotations in the exported event stream (never as assistant targets). */
  include_posthoc_annotations: z.boolean().default(false),
  /** Repository URLs / families known to be part of public benchmarks. */
  benchmark_exclusion_list: z.array(z.string()).default([]),
  /** SPDX ids allowed for export. Empty = allow anything that was positively detected. */
  allowed_licenses: z.array(z.string()).default([]),
  /** What to do with a repository whose license could not be detected. */
  unknown_license_policy: z.enum(["exclude", "pending_review"]).default("pending_review"),
  /** Secret/PII policy. "exclude" drops the sample; "redact" rewrites and re-verifies. */
  secret_policy: z.enum(["exclude", "redact"]).default("exclude"),
  /**
   * Allow exporting samples whose agent trajectory came from a scripted fixture harness instead of
   * a real model. Off by default; when on, every record is stamped and written to a separate dir.
   */
  allow_fixture_provenance: z.boolean().default(false),
});
export type ExportConfig = z.infer<typeof Export>;

/** The LLM judge that scores trajectories for SFT filtering and RL rewards. */
const Judge = z.object({
  /**
   * Show the judge the historical reference patch. Off by default: the hidden tests already
   * establish correctness, and a judge anchored on one solution tends to penalise valid alternatives.
   */
  show_reference_patch: z.boolean().default(false),
  /** Characters of rendered trajectory shown to the judge; the middle is elided beyond this. */
  max_trajectory_chars: z.number().int().min(2_000).default(60_000),
  max_diff_chars: z.number().int().min(1_000).default(30_000),
  /** Rubric weights; must sum to 1. */
  weights: z
    .object({
      requirement_coverage: z.number().min(0).max(1).default(0.3),
      solution_quality: z.number().min(0).max(1).default(0.25),
      verification_discipline: z.number().min(0).max(1).default(0.15),
      scope_discipline: z.number().min(0).max(1).default(0.1),
      communication_honesty: z.number().min(0).max(1).default(0.1),
      efficiency: z.number().min(0).max(1).default(0.1),
    })
    .prefault({})
    .refine((w) => Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 1e-9, {
      message: "judge.weights must sum to 1",
    }),
});
export type JudgeConfig = z.infer<typeof Judge>;

/** How a rollout's reward is composed from verifiable evidence and the judge. */
const Reward = z
  .object({
    /** Weight of the hidden-test result. The judge only contributes when the tests pass. */
    verifiable_weight: z.number().min(0).max(1).default(0.7),
    judge_weight: z.number().min(0).max(1).default(0.3),
    /** Give up to 0.5 of the verifiable component for a share of fail-to-pass checks, with no regressions. */
    partial_credit: z.boolean().default(false),
    zero_on_incomplete: z.boolean().default(true),
    /**
     * Zero the reward when the agent deleted a test file the hidden suite relies on. Modifications
     * are reported (`visible_tests_tampered`) and left to the judge: adding cases is legitimate,
     * and the hidden copy is restored before evaluation either way.
     */
    zero_on_deleted_tests: z.boolean().default(true),
    zero_on_reward_hacking: z.boolean().default(true),
    /** Upper bound on the reward when the judge finds claims no tool output supports. */
    cap_on_unsupported_claims: z.number().min(0).max(1).default(0.5),
  })
  .refine((r) => Math.abs(r.verifiable_weight + r.judge_weight - 1) < 1e-9, {
    message: "reward.verifiable_weight + reward.judge_weight must equal 1",
  });
export type RewardConfig = z.infer<typeof Reward>;

/** Rollouts of a policy against verified tasks: RL data generation and model evaluation. */
const Rl = z.object({
  /** Rollouts per task. Several per task give group-relative advantages (GRPO) and pass@k. */
  rollouts_per_task: z.number().int().min(1).max(64).default(4),
  /** Only roll out tasks in these splits. Empty = every split. */
  splits: z.array(z.enum(["train", "validation", "test"])).default([]),
  /** Judge every rollout. Off leaves the reward purely verifiable. */
  judge_rollouts: z.boolean().default(true),
  /** Minimum reward gap between the best and worst rollout of a task to emit a preference pair. */
  preference_margin: z.number().min(0).max(1).default(0.3),
});
export type RlConfig = z.infer<typeof Rl>;

/**
 * Disk reclamation.
 *
 * A run creates one container per phase and one committed image per (repository, parent
 * revision). Left alone they accumulate indefinitely: a hundred candidates means a hundred
 * multi-hundred-megabyte images for repositories that will never be touched again.
 *
 * The defaults keep only what the dataset is: the exported JSONL, the run manifest, the run
 * database and the command logs. Everything reconstructible is removed.
 *
 * Trade-off, stated plainly: with `task_images: after_repository`, `forge replay --sample` can no
 * longer start immediately, because the image it would start from is gone. Re-running
 * `forge prepare` rebuilds it — the stage cache notices the missing image and redoes the work.
 * Set the fields to `never` to keep replay instant at the cost of disk.
 */
const Cleanup = z.object({
  /** Committed per-revision task images. The bulk of the disk usage. */
  task_images: z.enum(["after_repository", "after_run", "never"]).default("after_repository"),
  /** Shared runtime images. One per ecosystem/recipe, reused across repositories. */
  runtime_images: z.enum(["after_run", "never"]).default("after_run"),
  /** Mirror clones under `<workspace>/repos`. */
  repository_mirrors: z.enum(["after_repository", "after_run", "never"]).default("after_run"),
  /** Stored solution snapshots: one tar of the whole workspace per accepted attempt. */
  solution_snapshots: z.enum(["after_export", "never"]).default("after_export"),
  /** Sweep containers this tool labelled, including ones an interrupted run left behind. */
  containers: z.enum(["always", "never"]).default("always"),
  /** Also drop the base images that were pulled (python:3.12-slim and friends). */
  base_images: z.enum(["after_run", "never"]).default("never"),
});
export type Cleanup = z.infer<typeof Cleanup>;

export const ForgeConfig = z.object({
  schema_version: z.literal(CONFIG_SCHEMA_VERSION),
  /** Seed for every sampling and tie-breaking decision in the run. */
  seed: z.union([z.number().int(), z.string()]).default(42),
  /** Directory holding the SQLite database, artifacts and manifests. Relative to the config file. */
  workspace: z.string().default(".forge"),
  repositories: z.array(Repository).min(1),
  sampling: Sampling.prefault({}),
  filters: Filters.prefault({}),
  grading: Grading.prefault({}),
  generation: Generation.prefault({}),
  verification: Verification.prefault({}),
  sandbox: Sandbox.prefault({}),
  model: Model.prefault({}),
  budgets: Budgets.prefault({}),
  export: Export.prefault({}),
  cleanup: Cleanup.prefault({}),
  judge: Judge.prefault({}),
  reward: Reward.prefault({}),
  rl: Rl.prefault({}),
});

export type ForgeConfig = z.infer<typeof ForgeConfig>;

/** Filters for one repository: global block with the repository's partial overrides merged on top. */
export function effectiveFilters(config: ForgeConfig, repo: RepositoryConfig): Filters {
  if (!repo.filters) return config.filters;
  return { ...config.filters, ...stripUndefined(repo.filters) } as Filters;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

/**
 * `solver` produces the verified teacher trajectories. `policy` is the model under training or
 * evaluation in `forge rollout`; it falls back to the solver when not set.
 */
export type ModelRole = "grader" | "taskgen" | "taskreview" | "solver" | "user_simulator" | "judge" | "policy";

export function modelForRole(config: ForgeConfig, role: ModelRole): {
  provider: string;
  model: string;
  thinking: ModelConfig["thinking"];
} {
  const override = config.model.roles?.[role] ?? (role === "policy" ? (config.model.roles?.solver ?? {}) : {});
  return {
    provider: override.provider ?? config.model.provider,
    model: override.model ?? config.model.model,
    thinking: override.thinking ?? config.model.thinking,
  };
}
