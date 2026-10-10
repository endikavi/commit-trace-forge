import ignoreFactory from "ignore";
import type { Filters, Range } from "../config/schema.ts";
import type { CommitMetrics } from "../types/index.ts";
import type { CommitSummary, Git } from "../sources/git.ts";
import type { RejectionCause } from "../util/errors.ts";
import { classifyPath, isFormattingOnlyPatch, matchesAny } from "./classify.ts";
import { keptFiles } from "./metrics.ts";

export interface ScreenResult {
  eligible: boolean;
  cause: RejectionCause | null;
  detail: string;
}

const ok: ScreenResult = { eligible: true, cause: null, detail: "" };
const no = (cause: RejectionCause, detail: string): ScreenResult => ({ eligible: false, cause, detail });

function withinRange(value: number, range: Range | undefined): boolean {
  if (!range) return true;
  if (range.min !== undefined && value < range.min) return false;
  if (range.max !== undefined && value > range.max) return false;
  return true;
}

/**
 * Cheap, metadata-only screening. Runs before any diff is computed so that a large history can be
 * narrowed without paying for per-commit diffs.
 */
export function screenCommitMetadata(commit: CommitSummary, filters: Filters): ScreenResult {
  if (filters.exclude_merges && commit.parents.length > 1) {
    return no("merge_commit", `commit has ${commit.parents.length} parents`);
  }
  if (filters.exclude_root_commits && commit.parents.length === 0) {
    return no("root_commit", "commit has no parent");
  }
  if (commit.parents.length === 0) {
    // Even when root commits are not explicitly excluded, there is no parent state to
    // reconstruct, so they can never become a task.
    return no("root_commit", "commit has no parent to reconstruct");
  }
  if (filters.since && commit.authorDate < filters.since) {
    return no("outside_time_range", `author date ${commit.authorDate} < since ${filters.since}`);
  }
  if (filters.until && commit.authorDate > filters.until) {
    return no("outside_time_range", `author date ${commit.authorDate} > until ${filters.until}`);
  }
  return ok;
}

/**
 * Full screening against the computed diff. `patchProvider` is only invoked when the
 * formatting-only check actually needs the patch text.
 */
export async function screenCommitDiff(
  metrics: CommitMetrics,
  filters: Filters,
  patchProvider: () => Promise<string>,
): Promise<ScreenResult> {
  const kept = keptFiles(metrics, filters);

  if (metrics.files.length === 0) return no("empty_diff", "diff against parent is empty");
  if (kept.length === 0) {
    return no("excluded_path_only", "every changed path matched filters.exclude_path_globs");
  }

  if (filters.include_path_globs.length > 0) {
    const touched = kept.some((f) => matchesAny(f.path, filters.include_path_globs));
    if (!touched) return no("excluded_path_only", "no changed path matched filters.include_path_globs");
  }

  if (filters.exclude_binary_changes && kept.some((f) => f.is_binary)) {
    const paths = kept.filter((f) => f.is_binary).map((f) => f.path);
    return no("binary_change", `binary entries: ${paths.slice(0, 5).join(", ")}`);
  }
  if (filters.exclude_submodule_changes && kept.some((f) => f.is_submodule)) {
    return no("submodule_change", "commit updates a git submodule");
  }
  if (
    filters.exclude_symlink_changes &&
    kept.some((f) => f.old_mode === "120000" || f.new_mode === "120000")
  ) {
    return no("symlink_unsupported", "commit changes a symlink");
  }

  if (!withinRange(metrics.filtered.changed_lines, filters.changed_lines)) {
    return no(
      "changed_lines_out_of_range",
      `changed_lines=${metrics.filtered.changed_lines} outside [${filters.changed_lines.min ?? "-"}, ${filters.changed_lines.max ?? "-"}]`,
    );
  }
  if (!withinRange(metrics.filtered.added_lines, filters.added_lines)) {
    return no("changed_lines_out_of_range", `added_lines=${metrics.filtered.added_lines} out of range`);
  }
  if (!withinRange(metrics.filtered.deleted_lines, filters.deleted_lines)) {
    return no("changed_lines_out_of_range", `deleted_lines=${metrics.filtered.deleted_lines} out of range`);
  }
  if (!withinRange(metrics.filtered.changed_files, filters.changed_files)) {
    return no(
      "changed_files_out_of_range",
      `changed_files=${metrics.filtered.changed_files} outside [${filters.changed_files.min ?? "-"}, ${filters.changed_files.max ?? "-"}]`,
    );
  }

  const classes = kept.map((f) => classifyPath(f.path, filters));
  if (filters.exclude_generated_only && classes.every((c) => c === "generated")) {
    return no("generated_only", "every changed path is classified as generated output");
  }
  if (filters.exclude_vendored_only && classes.every((c) => c === "vendored")) {
    return no("vendored_only", "every changed path is vendored third-party code");
  }
  if (filters.exclude_lockfile_only && classes.every((c) => c === "lockfile")) {
    return no("lockfile_only", "every changed path is a dependency lockfile");
  }
  if (filters.exclude_generated_only && classes.every((c) => c === "generated" || c === "vendored" || c === "lockfile")) {
    return no("generated_only", "no source file changed (only generated/vendored/lockfile paths)");
  }

  if (filters.exclude_formatting_only) {
    const patch = await patchProvider();
    if (isFormattingOnlyPatch(patch)) {
      return no("formatting_only", "added and removed lines are identical after whitespace removal");
    }
  }

  return ok;
}

/**
 * Reject commits that add a path the parent's .gitignore would ignore.
 *
 * Exactness is established by comparing the solver's `git add -A` tree against the target tree.
 * A target path that the parent ignores could never be staged by the solver, which would look
 * like an incorrect solution. Screening for it here keeps the check truthful and leaks nothing:
 * it runs in the evaluator process against the mirror clone, never inside the sandbox.
 */
export async function screenTargetGitignore(
  git: Git,
  parentSha: string,
  metrics: CommitMetrics,
  filters: Filters,
): Promise<ScreenResult> {
  if (!filters.exclude_target_gitignored_paths) return ok;
  const addedPaths = metrics.files
    .filter((f) => f.status === "added" || f.status === "renamed" || f.status === "copied")
    .map((f) => f.path);
  if (addedPaths.length === 0) return ok;

  const parentPaths = await git.listPathsAt(parentSha);
  const ignoreFiles = parentPaths.filter((p) => p === ".gitignore" || p.endsWith("/.gitignore"));
  if (ignoreFiles.length === 0) return ok;

  for (const ignoreFile of ignoreFiles) {
    const dir = ignoreFile === ".gitignore" ? "" : ignoreFile.slice(0, -".gitignore".length);
    const content = (await git.showFile(parentSha, ignoreFile))?.toString("utf8");
    if (!content) continue;
    const matcher = ignoreFactory().add(content);
    const scoped = addedPaths
      .filter((p) => (dir === "" ? true : p.startsWith(dir)))
      .map((p) => ({ full: p, rel: dir === "" ? p : p.slice(dir.length) }));
    for (const { full, rel } of scoped) {
      if (rel.length === 0) continue;
      if (matcher.ignores(rel)) {
        return no(
          "target_path_gitignored",
          `target adds "${full}" which ${ignoreFile} at the parent would ignore`,
        );
      }
    }
  }
  return ok;
}
