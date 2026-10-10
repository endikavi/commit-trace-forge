import { minimatch } from "minimatch";
import type { Filters } from "../config/schema.ts";

export type PathClass = "generated" | "vendored" | "lockfile" | "excluded" | "source";

const MATCH_OPTIONS = { dot: true, nocomment: true, nonegate: false } as const;

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => minimatch(path, pattern, MATCH_OPTIONS));
}

/**
 * Classify a path against the configurable rule sets.
 *
 * Order matters: an explicit exclusion wins, then vendored, then generated, then lockfile.
 * A lockfile is classified as such but is NOT by itself a rejection reason: `exclude_lockfile_only`
 * only rejects commits where *every* entry is a lockfile, so a lockfile bump that accompanies a
 * genuine dependency change survives.
 */
export function classifyPath(path: string, filters: Filters): PathClass {
  if (matchesAny(path, filters.exclude_path_globs)) return "excluded";
  if (matchesAny(path, filters.vendored_globs)) return "vendored";
  if (matchesAny(path, filters.generated_globs)) return "generated";
  if (matchesAny(path, filters.lockfile_globs)) return "lockfile";
  return "source";
}

/** Heuristic: does this hunk pair look like pure reformatting? */
export function isFormattingOnlyPatch(patch: string): boolean {
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-")) removed.push(line.slice(1));
  }
  if (added.length === 0 && removed.length === 0) return false;
  const normalize = (lines: string[]) =>
    lines
      .map((l) => l.replace(/\s+/g, ""))
      .filter((l) => l.length > 0)
      .sort()
      .join("\n");
  return normalize(added) === normalize(removed);
}

/** Well-known test path heuristics per ecosystem. Used to check that tests exist at all. */
export function looksLikeTestPath(path: string): boolean {
  const p = path.toLowerCase();
  return (
    /(^|\/)tests?(\/|$)/.test(p) ||
    /(^|\/)test_[^/]+\.py$/.test(p) ||
    /[^/]+_test\.py$/.test(p) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) ||
    /(^|\/)__tests__(\/|$)/.test(p) ||
    /(^|\/)spec(\/|$)/.test(p)
  );
}
