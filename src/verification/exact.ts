import type { Git, TreeEntry } from "../sources/git.ts";
import type { SandboxContainer } from "../sandbox/types.ts";
import type { VerificationResults } from "../types/index.ts";
import { GIT_IDENTITY } from "../environments/workspace.ts";

/**
 * Exact reconstruction.
 *
 * The comparison is between the git TREE of the solver's result and the git tree of the target
 * commit. A git tree hash covers file contents byte for byte, the executable bit (100644 vs
 * 100755), symlinks (mode 120000, with the link target as the blob), and the exact set of paths,
 * so deletions and additions are covered too.
 *
 * Equality of the commit SHA is NOT required: the solver's commit has different metadata and a
 * different history, which says nothing about the files.
 *
 * Nothing here normalises whitespace or line endings. A whitespace-insensitive comparison is
 * computed separately and only ever reported as a diagnostic; it can never make a result "exact".
 */

export interface ExactComparison {
  exact: boolean;
  resultTreeSha: string;
  targetTreeSha: string;
  differences: VerificationResults["tree_diff_summary"];
  /** Diagnostic only: would the trees match if trailing whitespace and line endings were ignored? */
  normalizedMatch: boolean | null;
}

export async function compareTrees(options: {
  git: Git;
  targetSha: string;
  resultTreeSha: string;
  container: SandboxContainer;
  workdir: string;
  timeoutMs: number;
  /** Compute the whitespace-normalised diagnostic. Costs one read per differing file. */
  computeNormalizedDiagnostic?: boolean;
}): Promise<ExactComparison> {
  const targetTreeSha = await options.git.treeSha(options.targetSha);
  if (options.resultTreeSha === targetTreeSha) {
    return { exact: true, resultTreeSha: options.resultTreeSha, targetTreeSha, differences: [], normalizedMatch: true };
  }

  const targetEntries = blobsByPath(await options.git.lsTree(targetTreeSha));
  const resultEntries = blobsByPath(await listTreeInContainer(options.container, options.workdir, options.resultTreeSha, options.timeoutMs));

  const differences: VerificationResults["tree_diff_summary"] = [];
  for (const [path, target] of targetEntries) {
    const actual = resultEntries.get(path);
    if (!actual) {
      differences.push({ path, kind: "missing" });
      continue;
    }
    if (actual.type !== target.type) {
      differences.push({ path, kind: "type_differs" });
      continue;
    }
    if (actual.mode !== target.mode) {
      differences.push({ path, kind: "mode_differs" });
      // A mode difference with identical content is still a difference; keep going so a content
      // difference on the same path is also reported.
    }
    if (actual.sha !== target.sha) differences.push({ path, kind: "content_differs" });
  }
  for (const path of resultEntries.keys()) {
    if (!targetEntries.has(path)) differences.push({ path, kind: "unexpected" });
  }

  let normalizedMatch: boolean | null = null;
  if (options.computeNormalizedDiagnostic) {
    normalizedMatch = await normalizedComparison({
      differences,
      targetEntries,
      resultEntries,
      git: options.git,
      container: options.container,
      workdir: options.workdir,
      timeoutMs: options.timeoutMs,
    });
  }

  return {
    exact: false,
    resultTreeSha: options.resultTreeSha,
    targetTreeSha,
    differences: differences.sort((a, b) => a.path.localeCompare(b.path)),
    normalizedMatch,
  };
}

function blobsByPath(entries: readonly TreeEntry[]): Map<string, TreeEntry> {
  const map = new Map<string, TreeEntry>();
  for (const entry of entries) {
    if (entry.type === "tree") continue;
    map.set(entry.path, entry);
  }
  return map;
}

async function listTreeInContainer(
  container: SandboxContainer,
  workdir: string,
  treeSha: string,
  timeoutMs: number,
): Promise<TreeEntry[]> {
  const result = await container.exec(["git", ...GIT_IDENTITY, "ls-tree", "-r", "-z", "-t", treeSha], {
    cwd: workdir,
    timeoutMs,
    maxOutputBytes: 64 * 1024 * 1024,
  });
  if (result.exitCode !== 0) {
    throw new Error(`cannot list the result tree ${treeSha}: ${result.stderr.toString("utf8").slice(0, 400)}`);
  }
  const entries: TreeEntry[] = [];
  for (const record of result.stdout.toString("utf8").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, sha] = record.slice(0, tab).split(/\s+/);
    if (!mode || !type || !sha) continue;
    entries.push({ mode, type: type as TreeEntry["type"], sha, path: record.slice(tab + 1) });
  }
  return entries;
}

/**
 * Whitespace-insensitive diagnostic.
 *
 * Reported separately so a reader can tell "the solution differs only in formatting" from
 * "the solution reconstructs the target". It never feeds the acceptance decision.
 */
async function normalizedComparison(args: {
  differences: VerificationResults["tree_diff_summary"];
  targetEntries: Map<string, TreeEntry>;
  resultEntries: Map<string, TreeEntry>;
  git: Git;
  container: SandboxContainer;
  workdir: string;
  timeoutMs: number;
}): Promise<boolean> {
  const contentDiffs = args.differences.filter((d) => d.kind === "content_differs");
  if (args.differences.some((d) => d.kind !== "content_differs")) return false;
  if (contentDiffs.length === 0) return false;

  for (const diff of contentDiffs) {
    const target = args.targetEntries.get(diff.path);
    const actual = args.resultEntries.get(diff.path);
    if (!target || !actual) return false;
    const targetText = (await args.git.catFile(target.sha)).toString("utf8");
    const actualResult = await args.container.exec(
      ["git", ...GIT_IDENTITY, "cat-file", "blob", actual.sha],
      { cwd: args.workdir, timeoutMs: args.timeoutMs, maxOutputBytes: 32 * 1024 * 1024 },
    );
    if (actualResult.exitCode !== 0) return false;
    if (normalise(targetText) !== normalise(actualResult.stdout.toString("utf8"))) return false;
  }
  return true;
}

function normalise(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "\n");
}
