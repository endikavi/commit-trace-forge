import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ForgeConfig } from "../config/schema.ts";
import { effectiveFilters } from "../config/schema.ts";
import type { Store } from "../storage/state.ts";
import type { ArtifactStore } from "../storage/artifacts.ts";
import type { Logger } from "../util/logger.ts";
import type { RejectionCause } from "../util/errors.ts";
import { shortId } from "../util/hash.ts";
import { acquireRepository, type AcquiredRepo } from "../sources/index.ts";
import { buildMetrics } from "./metrics.ts";
import { screenCommitDiff, screenCommitMetadata, screenTargetGitignore } from "./filters.ts";
import { sampleCommits, type EligibleCommit } from "./sample.ts";
import type { CandidateIdentity, CommitMetrics } from "../types/index.ts";

export interface MineOptions {
  config: ForgeConfig;
  workspaceDir: string;
  /** Directory of the configuration file; local repository paths resolve against it. */
  configDir: string;
  store: Store;
  artifacts: ArtifactStore;
  logger: Logger;
  offline?: boolean;
  signal?: AbortSignal;
}

export interface MineResult {
  repositories: AcquiredRepo[];
  examined: number;
  eligible: number;
  candidates: number;
  deficitReason: string | null;
  manifestPath: string;
}

interface ScreenedCommit {
  repositoryUrl: string;
  commitSha: string;
  parentSha: string | null;
  authorDate: string;
  position: number;
  eligible: boolean;
  cause: RejectionCause | null;
  detail: string;
  metrics: CommitMetrics | null;
  identity: CandidateIdentity | null;
}

/**
 * Enumerate, screen and sample commits.
 *
 * Every examined commit is recorded in the population manifest with its eligibility verdict and,
 * when rejected, the machine-readable cause. Discards are never dropped silently.
 */
export async function mine(options: MineOptions): Promise<MineResult> {
  const { config, store, logger } = options;
  const repositories: AcquiredRepo[] = [];
  const screened: ScreenedCommit[] = [];

  for (const repoConfig of config.repositories) {
    options.signal?.throwIfAborted();
    const repo = await acquireRepository(repoConfig, {
      workspaceDir: options.workspaceDir,
      configDir: options.configDir,
      logger: logger.child("sources"),
      offline: options.offline,
    });
    repositories.push(repo);
    store.recordMirrorDir(repo.url, repo.dir);
    logger.info("resolved ref", {
      url: repo.url,
      ref: repoConfig.ref,
      sha: repo.resolvedSha.slice(0, 12),
      license: repo.license.spdx ?? "unknown",
    });

    const filters = effectiveFilters(config, repoConfig);
    const commits = await repo.git.listCommits(repo.resolvedSha, config.sampling.max_candidates);
    logger.info("enumerated history", { url: repo.url, commits: commits.length });

    let position = 0;
    for (const commit of commits) {
      options.signal?.throwIfAborted();
      const parentSha = commit.parents[0] ?? null;
      const base: Omit<ScreenedCommit, "eligible" | "cause" | "detail" | "metrics" | "identity"> = {
        repositoryUrl: repo.url,
        commitSha: commit.sha,
        parentSha,
        authorDate: commit.authorDate,
        position: position++,
      };

      const metaVerdict = screenCommitMetadata(commit, filters);
      if (!metaVerdict.eligible || parentSha === null) {
        screened.push({
          ...base,
          eligible: false,
          cause: metaVerdict.cause ?? "root_commit",
          detail: metaVerdict.detail,
          metrics: null,
          identity: null,
        });
        continue;
      }

      const entries = await repo.git.diffEntries(parentSha, commit.sha, filters.rename_similarity);
      const metrics = buildMetrics(entries, filters);
      const diffVerdict = await screenCommitDiff(metrics, filters, () =>
        repo.git.patch(parentSha, commit.sha, filters.rename_similarity),
      );
      if (!diffVerdict.eligible) {
        screened.push({
          ...base,
          eligible: false,
          cause: diffVerdict.cause,
          detail: diffVerdict.detail,
          metrics,
          identity: null,
        });
        continue;
      }

      const ignoreVerdict = await screenTargetGitignore(repo.git, parentSha, metrics, filters);
      if (!ignoreVerdict.eligible) {
        screened.push({
          ...base,
          eligible: false,
          cause: ignoreVerdict.cause,
          detail: ignoreVerdict.detail,
          metrics,
          identity: null,
        });
        continue;
      }

      const identity: CandidateIdentity = {
        candidate_id: shortId("cand", { url: repo.url, sha: commit.sha }),
        repository_url: repo.url,
        repository_family: repo.family,
        resolved_ref_sha: repo.resolvedSha,
        target_sha: commit.sha,
        parent_sha: parentSha,
        target_tree_sha: await repo.git.treeSha(commit.sha),
        parent_tree_sha: await repo.git.treeSha(parentSha),
        author_date: commit.authorDate,
        committer_date: commit.committerDate,
        subject: commit.subject,
      };

      screened.push({ ...base, eligible: true, cause: null, detail: "", metrics, identity });
    }
  }

  store.recordPopulation(
    screened.map((s) => ({
      repository_url: s.repositoryUrl,
      resolved_sha: repositories.find((r) => r.url === s.repositoryUrl)?.resolvedSha ?? "",
      commit_sha: s.commitSha,
      parent_sha: s.parentSha,
      author_date: s.authorDate,
      position: s.position,
      eligible: s.eligible,
      reject_cause: s.cause,
    })),
  );
  for (const rejected of screened.filter((s) => !s.eligible)) {
    store.reject(null, "mine", rejected.cause ?? "internal_error", `${rejected.commitSha}: ${rejected.detail}`);
  }

  const eligible = screened.filter((s) => s.eligible);
  const population: EligibleCommit[] = eligible.map((s) => ({
    repositoryUrl: s.repositoryUrl,
    commitSha: s.commitSha,
  }));

  const outcome = sampleCommits(population, config.sampling, config.seed, {
    wanted: Math.min(config.sampling.max_candidates, population.length),
  });

  const byKey = new Map(eligible.map((s) => [`${s.repositoryUrl}@${s.commitSha}`, s]));
  let order = 0;
  for (const draw of outcome.selected) {
    const record = byKey.get(`${draw.repositoryUrl}@${draw.commitSha}`);
    if (!record?.identity || !record.metrics) continue;
    store.upsertCandidate({
      candidate_id: record.identity.candidate_id,
      repository_url: record.repositoryUrl,
      repository_family: record.identity.repository_family,
      target_sha: record.identity.target_sha,
      parent_sha: record.identity.parent_sha,
      identity: record.identity,
      metrics: record.metrics,
      selection_order: order++,
      status: "selected",
    });
  }

  const manifest = {
    run_id: store.runId,
    generated_at: new Date().toISOString(),
    seed: String(config.seed),
    strategy: config.sampling.strategy,
    repositories: repositories.map((r) => ({
      url: r.url,
      family: r.family,
      resolved_ref_sha: r.resolvedSha,
      license: r.license,
    })),
    examined: screened.length,
    eligible: eligible.length,
    /** The exact draw order. Replaying this manifest reproduces the candidate pool. */
    selection_order: outcome.selected.map((c, index) => ({
      index,
      repository_url: c.repositoryUrl,
      commit_sha: c.commitSha,
    })),
    population: screened.map((s) => ({
      repository_url: s.repositoryUrl,
      commit_sha: s.commitSha,
      parent_sha: s.parentSha,
      author_date: s.authorDate,
      eligible: s.eligible,
      reject_cause: s.cause,
      reject_detail: s.detail,
      metrics: s.metrics?.filtered ?? null,
    })),
  };

  const manifestDir = join(options.workspaceDir, "manifests");
  await mkdir(manifestDir, { recursive: true });
  const manifestPath = join(manifestDir, `population-${store.runId}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  await options.artifacts.putJson(manifest);

  logger.info("mining complete", {
    examined: screened.length,
    eligible: eligible.length,
    candidates: outcome.selected.length,
  });

  return {
    repositories,
    examined: screened.length,
    eligible: eligible.length,
    candidates: outcome.selected.length,
    deficitReason: outcome.deficitReason,
    manifestPath,
  };
}
