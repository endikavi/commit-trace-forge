import { z } from "zod";

/**
 * Canonical, versioned dataset schema plus the internal records the pipeline persists.
 *
 * Provenance is explicit everywhere. The four origins that can appear in a training stream are
 * `model_generated`, `synthetic_user`, `executed_tool` and `derived_metric`; `posthoc_annotation`
 * is excluded from the original conversation flow.
 */

export const DATASET_SCHEMA_VERSION = "commit-trace-forge/1";

// ---------------------------------------------------------------------------
// Mining
// ---------------------------------------------------------------------------

export const FileChange = z.object({
  path: z.string(),
  old_path: z.string().nullable().default(null),
  status: z.enum(["added", "modified", "deleted", "renamed", "copied", "type_changed"]),
  added_lines: z.number().int().min(0),
  deleted_lines: z.number().int().min(0),
  is_binary: z.boolean(),
  is_submodule: z.boolean(),
  old_mode: z.string().nullable(),
  new_mode: z.string().nullable(),
});
export type FileChange = z.infer<typeof FileChange>;

export const CommitMetrics = z.object({
  /** Metrics over every diff entry, before any path exclusion. */
  raw: z.object({
    added_lines: z.number().int().min(0),
    deleted_lines: z.number().int().min(0),
    changed_lines: z.number().int().min(0),
    changed_files: z.number().int().min(0),
    binary_files: z.number().int().min(0),
    submodule_entries: z.number().int().min(0),
  }),
  /** Metrics after `filters.exclude_path_globs` removed entries. */
  filtered: z.object({
    added_lines: z.number().int().min(0),
    deleted_lines: z.number().int().min(0),
    changed_lines: z.number().int().min(0),
    changed_files: z.number().int().min(0),
  }),
  files: z.array(FileChange),
});
export type CommitMetrics = z.infer<typeof CommitMetrics>;

export const CandidateIdentity = z.object({
  candidate_id: z.string(),
  repository_url: z.string(),
  repository_family: z.string(),
  /** SHA the configured ref resolved to when the run started. */
  resolved_ref_sha: z.string(),
  target_sha: z.string(),
  parent_sha: z.string(),
  target_tree_sha: z.string(),
  parent_tree_sha: z.string(),
  author_date: z.string(),
  committer_date: z.string(),
  /** Never exposed to the solver. Lives only in the evaluator manifest. */
  subject: z.string(),
});
export type CandidateIdentity = z.infer<typeof CandidateIdentity>;

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export const EnvironmentRecipe = z.object({
  recipe_id: z.string(),
  ecosystem: z.enum(["python", "node"]),
  base_image: z.string(),
  /** Digest of the base image as resolved at build time. Part of the cache key. */
  base_image_digest: z.string().nullable(),
  architecture: z.string(),
  /** Shell commands run with network access during provisioning. */
  setup_commands: z.array(z.string()),
  /** Argv of the full reference test suite. */
  test_command: z.array(z.string()),
  /** Argv template for running a subset; `{tests}` is replaced by space-joined ids. */
  test_selection_command: z.array(z.string()).nullable(),
  workdir: z.string(),
  env: z.record(z.string(), z.string()),
  /** Manifest/lockfile paths whose content hashes feed the cache key. */
  manifest_paths: z.array(z.string()),
  manifest_hashes: z.record(z.string(), z.string()),
});
export type EnvironmentRecipe = z.infer<typeof EnvironmentRecipe>;

export const CommandRecord = z.object({
  label: z.string(),
  argv: z.array(z.string()),
  exit_code: z.number().int().nullable(),
  duration_ms: z.number().int().min(0),
  timed_out: z.boolean(),
  /** Artifact hash of the full stdout+stderr log. Never a fabricated summary. */
  log_artifact: z.string().nullable(),
  stdout_excerpt: z.string(),
  stderr_excerpt: z.string(),
});
export type CommandRecord = z.infer<typeof CommandRecord>;

export const TestOutcome = z.object({
  test_id: z.string(),
  status: z.enum(["passed", "failed", "error", "skipped", "missing"]),
  /** Short failure reason taken verbatim from the runner output; never synthesised. */
  failure_excerpt: z.string().nullable(),
});
export type TestOutcome = z.infer<typeof TestOutcome>;

export const TestRun = z.object({
  label: z.string(),
  command: CommandRecord,
  /** Parsed from the runner's machine-readable report. Empty when parsing failed. */
  outcomes: z.array(TestOutcome),
  parsed: z.boolean(),
  /** Modules the runner could not collect, as dotted module names. Never per-test ids. */
  collection_errors: z.array(z.string()).default([]),
  totals: z.object({
    passed: z.number().int().min(0),
    failed: z.number().int().min(0),
    errored: z.number().int().min(0),
    skipped: z.number().int().min(0),
  }),
});
export type TestRun = z.infer<typeof TestRun>;

export const EnvironmentVerification = z.object({
  recipe_id: z.string(),
  image_ref: z.string(),
  image_digest: z.string().nullable(),
  /** Parent snapshot tree hash recomputed inside the container; must equal parent_tree_sha. */
  snapshot_fidelity_ok: z.boolean(),
  parent_install: CommandRecord.nullable(),
  parent_tests: TestRun.nullable(),
  target_install: CommandRecord.nullable(),
  target_tests: TestRun.nullable(),
  /** Dependency deltas required to reach the target, resolved into an offline store. */
  dependency_changes: z.array(z.string()),
  offline_store_ready: z.boolean(),
  /** Tests failing at parent AND at target: pre-existing breakage. */
  preexisting_failures: z.array(z.string()),
  /**
   * Fail-to-pass requirements, as prefixed strings:
   *   test::<id>    an individual test that must pass
   *   file::<path>  a module that could not even be collected at the parent; every test in it
   *                 must pass and at least one must run
   *   suite::       only a suite-level verdict was available
   */
  fail_to_pass: z.array(z.string()),
  /** Tests passing at parent and at target: the regression guard set. */
  pass_to_pass: z.array(z.string()),
  ok: z.boolean(),
  rejection_cause: z.string().nullable(),
});
export type EnvironmentVerification = z.infer<typeof EnvironmentVerification>;

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

export const GradeDimension = z.object({
  score: z.number().int().min(0).max(5),
  evidence: z.string().min(1),
});

export const CommitGrade = z.object({
  dimensions: z.object({
    task_clarity: GradeDimension,
    testability: GradeDimension,
    context_independence: GradeDimension,
    change_coherence: GradeDimension,
    training_value: GradeDimension,
    environment_reproducibility: GradeDimension,
  }),
  /** Weighted 0-100. Computed by the pipeline, not by the model. */
  total_score: z.number().min(0).max(100).optional(),
  uncertainties: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  /** Hard gates the model observed. Any true value rejects regardless of score. */
  gates: z.object({
    depends_on_external_context: z.boolean(),
    no_relevant_tests: z.boolean(),
    environment_irreproducible: z.boolean(),
    multiple_unrelated_intents: z.boolean(),
  }),
  rejection_reasons: z.array(z.string()).default([]),
});
export type CommitGrade = z.infer<typeof CommitGrade>;

// ---------------------------------------------------------------------------
// Task generation
// ---------------------------------------------------------------------------

export const TaskSpec = z.object({
  task_type: z.enum(["bugfix", "feature", "refactor", "performance", "docs", "test", "chore", "other"]),
  /** Natural English request. Describes desired behaviour, never the patch. */
  user_prompt: z.string().min(20),
  /** Observable requirements a correct solution must satisfy. */
  acceptance_criteria: z.array(z.string().min(3)).min(1),
  /**
   * Facts and preferences the simulated user is allowed to reveal when asked. Must be consistent
   * with the acceptance criteria and must not encode the patch.
   */
  user_fact_sheet: z.array(
    z.object({
      topic: z.string().min(1),
      fact: z.string().min(1),
    }),
  ).default([]),
  ambiguity_assessment: z.object({
    is_ambiguous: z.boolean(),
    /** Questions a reasonable engineer might ask. May be empty. */
    likely_questions: z.array(z.string()).default([]),
    notes: z.string().default(""),
  }),
  provenance: z.object({
    generator_prompt_version: z.string(),
    generator_model: z.string(),
    generated_at: z.string(),
    /** True when generated by a scripted fixture rather than a model. */
    synthetic_fixture: z.boolean().default(false),
  }),
});
export type TaskSpec = z.infer<typeof TaskSpec>;

export const TaskReview = z.object({
  sufficient: z.boolean(),
  coherent: z.boolean(),
  /** True when the prompt, criteria or fact sheet reveal the historical solution. */
  leaks_solution: z.boolean(),
  leak_evidence: z.array(z.string()).default([]),
  issues: z.array(z.string()).default([]),
  verdict: z.enum(["accept", "reject"]),
});
export type TaskReview = z.infer<typeof TaskReview>;

// ---------------------------------------------------------------------------
// Trajectory
// ---------------------------------------------------------------------------

export const EventOrigin = z.enum([
  "model_generated",
  "synthetic_user",
  "executed_tool",
  /**
   * The agent harness answered a tool call WITHOUT executing it: arguments that failed validation,
   * an unknown tool, or a call cut off by the model's output-token limit. The model saw this
   * answer, so it is part of the trajectory; nothing ran in the sandbox, so replay skips it.
   */
  "harness",
  "derived_metric",
  "posthoc_annotation",
]);
export type EventOrigin = z.infer<typeof EventOrigin>;

export const DecisionSummary = z.object({
  kind: z.literal("decision_summary"),
  language: z.literal("en"),
  observation: z.string(),
  action: z.string(),
  verification: z.string(),
  evidence_event_ids: z.array(z.string()).default([]),
});
export type DecisionSummary = z.infer<typeof DecisionSummary>;

export const TrajectoryEvent = z.object({
  event_id: z.string(),
  seq: z.number().int().min(0),
  role: z.enum(["user", "assistant", "tool", "system"]),
  type: z.enum([
    "user_message",
    "assistant_message",
    "decision_summary",
    "tool_call",
    "tool_result",
    "user_question",
    "user_answer",
    "annotation",
  ]),
  origin: EventOrigin,
  timestamp: z.string(),
  /** Text content for message events. */
  text: z.string().nullable().default(null),
  /** Tool correlation. `tool_call` and its `tool_result` share `tool_call_id`. */
  tool_call_id: z.string().nullable().default(null),
  tool_name: z.string().nullable().default(null),
  tool_input: z.unknown().nullable().default(null),
  tool_output: z.unknown().nullable().default(null),
  tool_is_error: z.boolean().nullable().default(null),
  /** True when `tool_output` was shortened for the context window. */
  truncated: z.boolean().default(false),
  /** Artifact hash of the untruncated payload when `truncated` is true. */
  full_output_artifact: z.string().nullable().default(null),
  decision_summary: DecisionSummary.nullable().default(null),
});
export type TrajectoryEvent = z.infer<typeof TrajectoryEvent>;

export const TokenUsage = z.object({
  input_tokens: z.number().int().min(0),
  output_tokens: z.number().int().min(0),
  cache_read_tokens: z.number().int().min(0).default(0),
  cache_write_tokens: z.number().int().min(0).default(0),
  /** null when the model has no published price. Never guessed. */
  cost_usd: z.number().min(0).nullable(),
  cost_known: z.boolean(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

export const SolveAttempt = z.object({
  attempt: z.number().int().min(1),
  attempt_id: z.string(),
  started_at: z.string(),
  finished_at: z.string(),
  /** "real_model" trajectories are eligible for export; "scripted_fixture" never is by default. */
  execution_mode: z.enum(["real_model", "scripted_fixture"]),
  harness: z.string(),
  harness_version: z.string(),
  model: z.string(),
  events: z.array(TrajectoryEvent),
  usage: TokenUsage,
  /** Tree hash of the solver workspace after the attempt, computed inside the sandbox. */
  result_tree_sha: z.string().nullable(),
  /** Unified diff of the solver's work, stored as an artifact. */
  solution_patch_artifact: z.string().nullable(),
  outcome: z.enum(["completed", "error", "timeout", "aborted"]),
  error: z.string().nullable().default(null),
  rejection_cause: z.string().nullable().default(null),
});
export type SolveAttempt = z.infer<typeof SolveAttempt>;

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export const BehavioralChecks = z.object({
  /** Ran the hidden copy of the fail-to-pass tests against the solution. */
  fail_to_pass_run: TestRun.nullable(),
  pass_to_pass_run: TestRun.nullable(),
  fail_to_pass_satisfied: z.array(z.string()).default([]),
  fail_to_pass_missing: z.array(z.string()).default([]),
  regressions: z.array(z.string()).default([]),
  /** For refactors: behaviour-preservation suite plus a structural objective check. */
  structural_checks: z.array(
    z.object({ name: z.string(), passed: z.boolean(), detail: z.string() }),
  ).default([]),
  /** True when visible tests were modified or deleted by the solver. */
  visible_tests_tampered: z.boolean().default(false),
  tampered_paths: z.array(z.string()).default([]),
  passed: z.boolean(),
});
export type BehavioralChecks = z.infer<typeof BehavioralChecks>;

export const ReplayResult = z.object({
  attempted: z.boolean(),
  passed: z.boolean(),
  /** Divergences that invalidated the replay. Timestamp/duration drift is allowed by policy. */
  divergences: z.array(
    z.object({
      event_id: z.string(),
      kind: z.enum([
        "precondition_mismatch",
        "tool_result_mismatch",
        "exit_code_mismatch",
        "missing_event",
        "final_tree_mismatch",
        "test_result_mismatch",
      ]),
      detail: z.string(),
    }),
  ).default([]),
  replayed_tree_sha: z.string().nullable(),
  final_tests: TestRun.nullable(),
  note: z.string().default(""),
});
export type ReplayResult = z.infer<typeof ReplayResult>;

export const VerificationResults = z.object({
  /** Byte-identical versioned tree, including exec bits, deletions and symlinks. */
  exact_tree_match: z.boolean(),
  /** Diagnostic only. Whitespace-normalised similarity never establishes exactness. */
  normalized_tree_match: z.boolean().nullable().default(null),
  tree_diff_summary: z.array(
    z.object({
      path: z.string(),
      kind: z.enum(["missing", "unexpected", "content_differs", "mode_differs", "type_differs"]),
    }),
  ).default([]),
  behavioral_checks_passed: z.boolean(),
  behavioral: BehavioralChecks.nullable(),
  replay_passed: z.boolean(),
  replay: ReplayResult.nullable(),
  clean_runs_completed: z.number().int().min(0).default(0),
  acceptance_mode: z.enum(["exact_tree", "behavioral", "either"]),
  accepted: z.boolean(),
  rejection_cause: z.string().nullable().default(null),
});
export type VerificationResults = z.infer<typeof VerificationResults>;

// ---------------------------------------------------------------------------
// Canonical sample
// ---------------------------------------------------------------------------

export const QualityFlags = z.object({
  environment_verified: z.boolean(),
  task_sufficiently_specified: z.boolean(),
  no_leak_detected: z.boolean(),
  tools_executed: z.boolean(),
  relevant_tests_present: z.boolean(),
  replay_ok: z.boolean(),
  acceptance_satisfied: z.boolean(),
  secrets_scan_clean: z.boolean(),
  license_ok: z.boolean(),
  /** True only when every trajectory came from a real model against a real sandbox. */
  real_execution: z.boolean(),
});
export type QualityFlags = z.infer<typeof QualityFlags>;

/**
 * Fields reserved to the evaluator manifest. They identify the historical solution and MUST NOT
 * reach the solver or the training messages. The exporter writes them to a separate file.
 */
export const EvaluatorManifest = z.object({
  target_sha: z.string(),
  parent_sha: z.string(),
  target_tree_sha: z.string(),
  parent_tree_sha: z.string(),
  commit_subject: z.string(),
  commit_message: z.string(),
  target_patch_artifact: z.string().nullable(),
  grade: CommitGrade.nullable(),
  environment: EnvironmentVerification.nullable(),
  hidden_test_ids: z.array(z.string()).default([]),
});
export type EvaluatorManifest = z.infer<typeof EvaluatorManifest>;

/** A tool as the agent saw it: name, description and JSON Schema of its input. */
export const ToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
});
export type ToolSchema = z.infer<typeof ToolSchema>;

export const Sample = z.object({
  schema_version: z.literal(DATASET_SCHEMA_VERSION),
  sample_id: z.string(),
  run_id: z.string(),
  created_at: z.string(),

  source: z.object({
    repository_url: z.string(),
    repository_family: z.string(),
    resolved_ref_sha: z.string(),
    license: z.string().nullable(),
    license_source: z.enum(["declared", "detected", "unknown"]),
    attribution_notice: z.string().nullable(),
  }),

  metrics: CommitMetrics,

  task: TaskSpec,
  task_review: TaskReview.nullable(),

  environment: z.object({
    recipe_id: z.string(),
    image_ref: z.string(),
    image_digest: z.string().nullable(),
    recipe_hash: z.string(),
    ecosystem: z.enum(["python", "node"]),
    /** Repository root inside the image. */
    workdir: z.string().default("/workspace"),
  }),

  agent: z.object({
    harness: z.string(),
    harness_version: z.string(),
    adapter_version: z.string(),
    model: z.string(),
    thinking_level: z.string(),
    tool_names: z.array(z.string()),
    execution_mode: z.enum(["real_model", "scripted_fixture"]),
    /**
     * The exact system prompt and tool definitions the agent was given. A student model trained on
     * this trajectory needs the same context the teacher acted in. Absent on records written
     * before these fields existed; exporters then fall back to the prompt version in use.
     */
    system_prompt: z.string().nullable().default(null),
    system_prompt_version: z.string().nullable().default(null),
    tool_schemas: z.array(ToolSchema).default([]),
  }),

  /** Every attempt, including the failed ones. */
  attempts: z.array(SolveAttempt),
  /** Index into `attempts` of the accepted trajectory. */
  accepted_attempt_index: z.number().int().min(0),
  /** Ordered event stream of the accepted attempt. */
  events: z.array(TrajectoryEvent),

  verification: VerificationResults,

  budget: z.object({
    usage: TokenUsage,
    wall_clock_ms: z.number().int().min(0),
    solved_on_first_attempt: z.boolean(),
    solved_within_budget: z.boolean(),
  }),

  split: z.enum(["train", "validation", "test"]).nullable(),
  quality: QualityFlags,
  /** Dedup key over the normalized patch; identical values across repos indicate a fork/cherry-pick. */
  dedup_keys: z.object({
    commit_identity: z.string(),
    normalized_patch: z.string(),
    repository_family: z.string(),
    task_similarity: z.string(),
  }),
});
export type Sample = z.infer<typeof Sample>;

// ---------------------------------------------------------------------------
// LLM judge and reward
// ---------------------------------------------------------------------------

export const JudgeDimension = z.object({
  score: z.number().int().min(0).max(5),
  /** Specific, checkable justification. Cites event ids or diff paths. */
  evidence: z.string().min(1),
});

/** The judge's structured verdict on one trajectory. Validated, never trusted as free text. */
export const JudgeVerdict = z.object({
  dimensions: z.object({
    requirement_coverage: JudgeDimension,
    solution_quality: JudgeDimension,
    verification_discipline: JudgeDimension,
    scope_discipline: JudgeDimension,
    communication_honesty: JudgeDimension,
    efficiency: JudgeDimension,
  }),
  flags: z.object({
    /** Special-casing tests, hard-coding expected values, weakening or skipping checks. */
    reward_hacking_suspected: z.boolean(),
    /** The agent claimed success, or a result, that the recorded tool output does not support. */
    unsupported_claims: z.boolean(),
  }),
  flag_evidence: z.array(z.string()).default([]),
  summary: z.string().default(""),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdict>;

export const Judgment = z.object({
  verdict: JudgeVerdict,
  /** Weighted 0-1, computed by the pipeline from the dimension scores, not by the model. */
  score: z.number().min(0).max(1),
  judge_model: z.string(),
  prompt_version: z.string(),
  prompt_hash: z.string(),
  /** Whether the judge was shown the historical reference patch. */
  saw_reference: z.boolean(),
  usage: TokenUsage,
  judged_at: z.string(),
});
export type Judgment = z.infer<typeof Judgment>;

/** Deterministic facts about one solution, measured in containers. The judge never overrides them. */
export const VerifiableOutcome = z.object({
  /** Hidden fail-to-pass and pass-to-pass checks passed. */
  tests_passed: z.boolean(),
  fail_to_pass_satisfied: z.number().int().min(0),
  fail_to_pass_total: z.number().int().min(0),
  regressions: z.number().int().min(0),
  /** A test file the hidden suite relies on was modified (often legitimately: added cases). */
  visible_tests_tampered: z.boolean(),
  /** A test file the hidden suite relies on was deleted. */
  visible_tests_deleted: z.boolean().default(false),
  exact_tree_match: z.boolean().nullable(),
  /** The agent loop ended cleanly rather than erroring, timing out or being cut off. */
  agent_completed: z.boolean(),
});
export type VerifiableOutcome = z.infer<typeof VerifiableOutcome>;

export const RewardBreakdown = z.object({
  /** Final scalar in [0, 1]. */
  reward: z.number().min(0).max(1),
  verifiable_component: z.number().min(0).max(1),
  judge_component: z.number().min(0).max(1).nullable(),
  /** Every rule that capped or zeroed the reward, in the order applied. */
  gates: z.array(z.string()),
  formula: z.string(),
});
export type RewardBreakdown = z.infer<typeof RewardBreakdown>;

export const Rollout = z.object({
  schema_version: z.literal(DATASET_SCHEMA_VERSION),
  rollout_id: z.string(),
  /** The task this rollout attempted; equals the `sample_id` of the verified task. */
  task_id: z.string(),
  /** Rollouts of the same task share a group, for group-relative advantages (GRPO-style). */
  group_id: z.string(),
  index: z.number().int().min(0),
  run_id: z.string(),
  split: z.enum(["train", "validation", "test"]).nullable(),
  /** "policy" for rollouts run by forge, "external" for trajectories scored with `forge score`. */
  source: z.enum(["policy", "external"]),
  policy_model: z.string(),
  outcome: z.enum(["completed", "error", "timeout", "aborted"]),
  events: z.array(TrajectoryEvent),
  result_tree_sha: z.string().nullable(),
  solution_patch_artifact: z.string().nullable(),
  verifiable: VerifiableOutcome,
  behavioral: BehavioralChecks.nullable(),
  judgment: Judgment.nullable(),
  reward: RewardBreakdown,
  /** For external trajectories: recorded tool results that differed from re-execution. */
  output_mismatches: z.array(z.object({ tool_call_id: z.string(), detail: z.string() })).default([]),
  usage: TokenUsage,
  wall_clock_ms: z.number().int().min(0),
  created_at: z.string(),
});
export type Rollout = z.infer<typeof Rollout>;
