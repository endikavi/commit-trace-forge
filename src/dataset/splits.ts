import { Prng } from "../util/prng.ts";
import type { ExportConfig } from "../config/schema.ts";

/**
 * Split assignment.
 *
 * Assignment happens at GROUP level, never at sample level. A group is the repository family by
 * default, so every sample from one project — forks, cherry-picks, several variants of the same
 * task, and repeated attempts — lands in the same split. Splitting per sample would put a task's
 * variant in train and the task itself in test.
 *
 * Group sizes are uneven, so groups are placed largest-first into whichever split is furthest
 * below its target share. That keeps the realised proportions close to the configured ones
 * without ever splitting a group.
 */

export type SplitName = "train" | "validation" | "test";

export interface SplitAssignment {
  sampleId: string;
  group: string;
  split: SplitName;
}

export interface SplitSummary {
  assignments: SplitAssignment[];
  counts: Record<SplitName, number>;
  groupsPerSplit: Record<SplitName, string[]>;
  /** Realised fractions, which differ from the targets when groups are large. */
  realised: Record<SplitName, number>;
}

export function assignSplits(
  samples: ReadonlyArray<{ sampleId: string; repositoryFamily: string; repositoryUrl: string }>,
  config: ExportConfig,
  seed: string | number,
): SplitSummary {
  const groupOf = (s: { repositoryFamily: string; repositoryUrl: string; sampleId: string }): string => {
    switch (config.split_by) {
      case "repository_family":
        return s.repositoryFamily;
      case "repository":
        return s.repositoryUrl;
      case "none":
        return s.sampleId;
    }
  };

  const groups = new Map<string, string[]>();
  for (const sample of samples) {
    const key = groupOf(sample);
    const list = groups.get(key) ?? [];
    list.push(sample.sampleId);
    groups.set(key, list);
  }

  const total = samples.length;
  const targets: Record<SplitName, number> = {
    train: config.splits.train * total,
    validation: config.splits.validation * total,
    test: config.splits.test * total,
  };
  const filled: Record<SplitName, number> = { train: 0, validation: 0, test: 0 };
  const groupsPerSplit: Record<SplitName, string[]> = { train: [], validation: [], test: [] };
  const assignments: SplitAssignment[] = [];

  // Deterministic: sort by size descending, then by name; the seed only breaks exact ties.
  const prng = new Prng(`${seed}|splits`);
  const ordered = [...groups.entries()].sort((a, b) => {
    if (b[1].length !== a[1].length) return b[1].length - a[1].length;
    return a[0].localeCompare(b[0]);
  });

  for (const [group, ids] of ordered) {
    const deficits = (["train", "validation", "test"] as SplitName[])
      .map((name) => ({ name, deficit: targets[name] - filled[name] }))
      .sort((a, b) => (b.deficit === a.deficit ? (prng.next() < 0.5 ? -1 : 1) : b.deficit - a.deficit));
    const chosen = (deficits[0]?.name ?? "train") as SplitName;
    filled[chosen] += ids.length;
    groupsPerSplit[chosen].push(group);
    for (const sampleId of ids) assignments.push({ sampleId, group, split: chosen });
  }

  return {
    assignments,
    counts: { ...filled },
    groupsPerSplit,
    realised: {
      train: total === 0 ? 0 : filled.train / total,
      validation: total === 0 ? 0 : filled.validation / total,
      test: total === 0 ? 0 : filled.test / total,
    },
  };
}

/** Groups that ended up in more than one split. Must always be empty. */
export function crossSplitLeaks(assignments: readonly SplitAssignment[]): string[] {
  const byGroup = new Map<string, Set<SplitName>>();
  for (const a of assignments) {
    const set = byGroup.get(a.group) ?? new Set<SplitName>();
    set.add(a.split);
    byGroup.set(a.group, set);
  }
  return [...byGroup.entries()].filter(([, splits]) => splits.size > 1).map(([group]) => group);
}
