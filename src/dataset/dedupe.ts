import { sha256Hex } from "../util/hash.ts";

/**
 * Deduplication keys.
 *
 * Four independent identities are computed. Two samples are duplicates when any of the first
 * three match; `repository_family` is not a duplicate signal by itself but keeps forks,
 * cherry-picks and variants of one task inside the same split.
 */

export interface DedupKeys {
  commit_identity: string;
  normalized_patch: string;
  repository_family: string;
  task_similarity: string;
}

/**
 * Normalise a unified diff so that a cherry-pick or a rebase of the same change hashes the same.
 *
 * Removed: index lines, hunk line numbers, trailing whitespace, blank context. Kept: which lines
 * were added and removed, and in which file. Two patches with the same normalised form are the
 * same change applied at different offsets.
 */
export function normalizePatch(patch: string): string {
  const out: string[] = [];
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("index ")) continue;
    if (raw.startsWith("similarity index ")) continue;
    if (raw.startsWith("@@")) {
      out.push("@@");
      continue;
    }
    if (raw.startsWith("diff --git ")) {
      out.push(raw.replace(/\s+/g, " ").trim());
      continue;
    }
    if (raw.startsWith("+++ ") || raw.startsWith("--- ")) {
      out.push(raw.replace(/\t.*$/, "").trimEnd());
      continue;
    }
    if (raw.startsWith("+") || raw.startsWith("-")) {
      const body = raw.slice(1).trimEnd();
      if (body.length === 0) continue;
      out.push(raw[0] + body);
      continue;
    }
    // Context lines carry no identity of their own once the hunk headers are gone.
  }
  return out.join("\n");
}

/**
 * Task similarity key.
 *
 * A bag of the significant words of the request, sorted and hashed. Two requests that differ only
 * in phrasing collapse to the same key, which is what catches near-duplicate tasks generated from
 * different commits that do the same thing.
 */
export function taskSimilarityKey(userPrompt: string, acceptanceCriteria: readonly string[]): string {
  const text = `${userPrompt}\n${acceptanceCriteria.join("\n")}`.toLowerCase();
  const words = text
    .replace(/[^a-z0-9_]+/g, " ")
    .split(" ")
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
    .map(stem);
  const unique = [...new Set(words)].sort();
  return `sha256:${sha256Hex(unique.join(" ")).slice(0, 32)}`;
}

/**
 * Conservative suffix stripping so "raises" and "raised" collapse to one token.
 *
 * Deliberately crude: only common inflections, and only on words long enough that the stem
 * stays meaningful. Aggressive stemming would start merging genuinely different requests, which
 * is the failure mode that matters here — a false duplicate silently discards a good sample.
 * Identifiers with underscores are left alone, because `percent_change` is a name, not a word.
 */
function stem(word: string): string {
  if (word.includes("_")) return word;
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (word.length >= suffix.length + 4 && word.endsWith(suffix)) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

const STOPWORDS = new Set([
  "that", "this", "with", "from", "should", "would", "could", "when", "then", "than", "into",
  "have", "does", "make", "need", "want", "please", "also", "there", "their", "they", "them",
  "which", "while", "about", "after", "before", "because", "being", "been", "were", "will",
  "currently", "instead", "something", "someone", "anything", "everything",
]);

export function buildDedupKeys(input: {
  repositoryUrl: string;
  targetSha: string;
  repositoryFamily: string;
  patch: string;
  userPrompt: string;
  acceptanceCriteria: readonly string[];
}): DedupKeys {
  return {
    commit_identity: `sha256:${sha256Hex(`${input.repositoryUrl}@${input.targetSha}`).slice(0, 32)}`,
    normalized_patch: `sha256:${sha256Hex(normalizePatch(input.patch)).slice(0, 32)}`,
    repository_family: input.repositoryFamily,
    task_similarity: taskSimilarityKey(input.userPrompt, input.acceptanceCriteria),
  };
}

export interface DuplicateFinding {
  sampleId: string;
  duplicateOf: string;
  reason: "commit_identity" | "normalized_patch" | "task_similarity";
}

/**
 * Find duplicates in draw order. The first occurrence wins; later ones are rejected with
 * `dataset_duplicate` and the id they duplicate.
 */
export function findDuplicates(
  samples: ReadonlyArray<{ sampleId: string; keys: DedupKeys }>,
): DuplicateFinding[] {
  const seenCommit = new Map<string, string>();
  const seenPatch = new Map<string, string>();
  const seenTask = new Map<string, string>();
  const findings: DuplicateFinding[] = [];

  for (const { sampleId, keys } of samples) {
    const priorCommit = seenCommit.get(keys.commit_identity);
    if (priorCommit) {
      findings.push({ sampleId, duplicateOf: priorCommit, reason: "commit_identity" });
      continue;
    }
    const priorPatch = seenPatch.get(keys.normalized_patch);
    if (priorPatch) {
      findings.push({ sampleId, duplicateOf: priorPatch, reason: "normalized_patch" });
      continue;
    }
    const priorTask = seenTask.get(keys.task_similarity);
    if (priorTask) {
      findings.push({ sampleId, duplicateOf: priorTask, reason: "task_similarity" });
      continue;
    }
    seenCommit.set(keys.commit_identity, sampleId);
    seenPatch.set(keys.normalized_patch, sampleId);
    seenTask.set(keys.task_similarity, sampleId);
  }
  return findings;
}
