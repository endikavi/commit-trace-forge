import { Prng } from "../util/prng.ts";
import type { Sampling } from "../config/schema.ts";

export interface EligibleCommit {
  repositoryUrl: string;
  commitSha: string;
}

export interface SamplingOutcome {
  /** Commits in the exact order they were drawn. Downstream stages consume this order. */
  selected: EligibleCommit[];
  /** Why fewer than requested were drawn, when that happened. */
  deficitReason: string | null;
}

export interface SampleOptions {
  /** How many commits to draw into the candidate pool. */
  wanted: number;
  /** Optional hard cap on how many commits a single repository may contribute to the pool. */
  perRepositoryCap?: ReadonlyMap<string, number>;
}

/**
 * Draw an ordered candidate pool from the eligible population.
 *
 * This draws CANDIDATES, not accepted samples. `sampling.target_samples` counts accepted samples
 * and is enforced by the pipeline as it consumes this pool in draw order; most candidates are
 * expected to die in environment preparation, grading or verification.
 *
 * Reproducibility contract:
 *  - the population is re-sorted into a stable order (repository URL, then commit SHA)
 *  - the same seed plus the same population yields the same draw
 *  - a changed population does NOT reproduce an earlier draw; the population manifest written by
 *    `forge mine` is what makes the earlier draw repeatable
 */
export function sampleCommits(
  population: readonly EligibleCommit[],
  sampling: Sampling,
  seed: string | number,
  options: SampleOptions,
): SamplingOutcome {
  const stable = [...population].sort((a, b) =>
    a.repositoryUrl === b.repositoryUrl
      ? a.commitSha.localeCompare(b.commitSha)
      : a.repositoryUrl.localeCompare(b.repositoryUrl),
  );

  if (stable.length === 0) {
    return { selected: [], deficitReason: "no eligible commits in the examined population" };
  }

  const prng = new Prng(`${seed}|sampling|${sampling.strategy}`);
  const wanted = Math.max(0, options.wanted);
  const takenPerRepo = new Map<string, number>();
  const selected: EligibleCommit[] = [];
  const seen = new Set<string>();

  const repoCapReached = (url: string): boolean => {
    const cap = options.perRepositoryCap?.get(url);
    return cap !== undefined && (takenPerRepo.get(url) ?? 0) >= cap;
  };

  const take = (commit: EligibleCommit): void => {
    selected.push(commit);
    seen.add(`${commit.repositoryUrl}@${commit.commitSha}`);
    takenPerRepo.set(commit.repositoryUrl, (takenPerRepo.get(commit.repositoryUrl) ?? 0) + 1);
  };

  if (sampling.strategy === "uniform_over_eligible_commits") {
    // One flat uniform draw over every eligible commit: repositories with more eligible
    // history contribute proportionally more candidates.
    for (const commit of prng.shuffled(stable)) {
      if (selected.length >= wanted) break;
      if (sampling.without_replacement && seen.has(`${commit.repositoryUrl}@${commit.commitSha}`)) continue;
      if (repoCapReached(commit.repositoryUrl)) continue;
      take(commit);
    }
  } else {
    // Balanced: pick a repository uniformly, then a commit uniformly inside it, so a small
    // repository is not drowned out by a large one.
    const byRepo = new Map<string, EligibleCommit[]>();
    for (const commit of stable) {
      const list = byRepo.get(commit.repositoryUrl) ?? [];
      list.push(commit);
      byRepo.set(commit.repositoryUrl, list);
    }
    const pools = new Map<string, EligibleCommit[]>();
    for (const [url, commits] of byRepo) pools.set(url, prng.shuffled(commits));

    while (selected.length < wanted) {
      const available = [...pools.entries()]
        .filter(([url, pool]) => pool.length > 0 && !repoCapReached(url))
        .map(([url]) => url)
        .sort();
      if (available.length === 0) break;
      const url = available[prng.nextInt(available.length)] as string;
      const pool = pools.get(url) as EligibleCommit[];
      take(pool.shift() as EligibleCommit);
    }
  }

  let deficitReason: string | null = null;
  if (selected.length < wanted) {
    deficitReason =
      `drew ${selected.length} of ${wanted} requested candidates: the eligible population ` +
      `(${stable.length} commits) or the per-repository caps were exhausted`;
  }
  return { selected, deficitReason };
}
