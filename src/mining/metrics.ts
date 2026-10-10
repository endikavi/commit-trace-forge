import type { Filters } from "../config/schema.ts";
import type { CommitMetrics, FileChange } from "../types/index.ts";
import type { RawDiffEntry } from "../sources/git.ts";
import { classifyPath } from "./classify.ts";

/**
 * Build commit metrics from raw git diff entries.
 *
 * Two views are always stored:
 *  - `raw`: every diff entry, so a rejection can be explained against what git actually reported
 *  - `filtered`: after `exclude_path_globs` removed entries
 *
 * Binary entries contribute 0 added/deleted lines because git reports "-", but they are counted
 * separately in `binary_files`; they are never silently read as an unchanged file.
 */
export function buildMetrics(entries: readonly RawDiffEntry[], filters: Filters): CommitMetrics {
  const files: FileChange[] = entries.map((entry) => ({
    path: entry.path,
    old_path: entry.oldPath,
    status: entry.status,
    added_lines: entry.addedLines,
    deleted_lines: entry.deletedLines,
    is_binary: entry.isBinary,
    is_submodule: entry.isSubmodule,
    old_mode: entry.oldMode,
    new_mode: entry.newMode,
  }));

  const countFileEntry = (file: FileChange): number =>
    file.status === "renamed" && filters.rename_counts_as === "two_entries" ? 2 : 1;

  const rawAdded = files.reduce((n, f) => n + f.added_lines, 0);
  const rawDeleted = files.reduce((n, f) => n + f.deleted_lines, 0);
  const rawFiles = files.reduce((n, f) => n + countFileEntry(f), 0);

  const kept = files.filter((f) => classifyPath(f.path, filters) !== "excluded");
  const filteredAdded = kept.reduce((n, f) => n + f.added_lines, 0);
  const filteredDeleted = kept.reduce((n, f) => n + f.deleted_lines, 0);
  const filteredFiles = kept.reduce((n, f) => n + countFileEntry(f), 0);

  return {
    raw: {
      added_lines: rawAdded,
      deleted_lines: rawDeleted,
      changed_lines: rawAdded + rawDeleted,
      changed_files: rawFiles,
      binary_files: files.filter((f) => f.is_binary).length,
      submodule_entries: files.filter((f) => f.is_submodule).length,
    },
    filtered: {
      added_lines: filteredAdded,
      deleted_lines: filteredDeleted,
      changed_lines: filteredAdded + filteredDeleted,
      changed_files: filteredFiles,
    },
    files,
  };
}

/** Entries that survive `exclude_path_globs`; these drive every filter decision. */
export function keptFiles(metrics: CommitMetrics, filters: Filters): FileChange[] {
  return metrics.files.filter((f) => classifyPath(f.path, filters) !== "excluded");
}
