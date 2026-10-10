/**
 * Error taxonomy.
 *
 * Every abandoned candidate must carry a machine-readable cause. The pipeline never
 * silently drops work: a `RejectionCause` is persisted for each discard, and `forge report`
 * aggregates by cause.
 */

export const REJECTION_CAUSES = [
  // ---- mining / deterministic filters -------------------------------------
  "merge_commit",
  "root_commit",
  "binary_change",
  "submodule_change",
  "symlink_unsupported",
  "changed_lines_out_of_range",
  "changed_files_out_of_range",
  "generated_only",
  "vendored_only",
  "formatting_only",
  "lockfile_only",
  "excluded_path_only",
  "outside_time_range",
  "target_path_gitignored",
  "empty_diff",

  // ---- environment --------------------------------------------------------
  "env_recipe_undetected",
  "env_image_build_failed",
  "env_parent_install_failed",
  "env_parent_baseline_broken",
  "env_target_install_failed",
  "env_target_tests_failed",
  "env_dependency_unresolvable_offline",
  "env_snapshot_fidelity_mismatch",
  "env_timeout",

  // ---- grading ------------------------------------------------------------
  "grade_below_total_threshold",
  "grade_below_dimension_minimum",
  "grade_gate_isolation",
  "grade_gate_no_relevant_tests",
  "grade_gate_environment",
  "grade_invalid_response",

  // ---- task generation ----------------------------------------------------
  "taskgen_invalid_response",
  "taskgen_multiple_intents",
  "taskgen_review_insufficient",
  "taskgen_review_leak",
  "taskgen_review_incoherent",

  // ---- solving ------------------------------------------------------------
  "solve_no_attempt_succeeded",
  "solve_harness_error",
  "solve_timeout",
  "solve_budget_exhausted",

  // ---- verification -------------------------------------------------------
  "verify_acceptance_not_met",
  "verify_no_fail_to_pass_evidence",
  "verify_hidden_tests_tampered",
  "verify_regression",
  "verify_replay_divergence",
  "verify_replay_not_run",

  // ---- dataset ------------------------------------------------------------
  "dataset_duplicate",
  "dataset_secret_detected",
  "dataset_pii_detected",
  "dataset_license_disallowed",
  "dataset_license_unknown_pending_review",
  "dataset_benchmark_excluded",
  "dataset_non_real_provenance",

  // ---- budget / infrastructure -------------------------------------------
  "budget_tokens_exhausted",
  "budget_cost_exhausted",
  "budget_candidates_exhausted",
  "population_exhausted",
  "cancelled",
  "internal_error",
] as const;

export type RejectionCause = (typeof REJECTION_CAUSES)[number];

export class ForgeError extends Error {
  readonly cause_code: RejectionCause;
  readonly details: Record<string, unknown>;

  constructor(cause: RejectionCause, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ForgeError";
    this.cause_code = cause;
    this.details = details;
  }
}

/** Thrown when a stage requires something the environment cannot provide (no model, no docker...). */
export class UnavailableError extends Error {
  readonly what: string;
  constructor(what: string, message: string) {
    super(message);
    this.name = "UnavailableError";
    this.what = what;
  }
}

export class CancelledError extends Error {
  constructor(message = "cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

export function isRejectionCause(value: string): value is RejectionCause {
  return (REJECTION_CAUSES as readonly string[]).includes(value);
}
