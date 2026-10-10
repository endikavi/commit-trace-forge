import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Cleanup } from "./config/schema.ts";
import type { Store } from "./storage/state.ts";
import type { SandboxBackend } from "./sandbox/types.ts";
import type { ArtifactStore } from "./storage/artifacts.ts";
import type { Logger } from "./util/logger.ts";
import type { Sample } from "./types/index.ts";

/**
 * Disk reclamation.
 *
 * A run creates one container per phase and one committed image per (repository, parent
 * revision). Nothing reclaims them automatically, so a hundred candidates leaves a hundred
 * multi-hundred-megabyte images for repositories that will never be touched again.
 *
 * What survives by default is exactly the dataset and the evidence for it: the exported JSONL,
 * the run manifest, the run database, and the command logs in the artifact store. Everything
 * that can be rebuilt from those is removed.
 *
 * Removal is scoped to what this tool created. Images are tracked in `run_images` as they are
 * built, and containers are matched by this tool's own label, so an unrelated image or container
 * on the same daemon is never touched.
 */

/** Tag prefixes this tool uses. Only images under these are ever considered for removal. */
export const IMAGE_PREFIXES = ["forge-task:", "forge-runtime:"] as const;

export interface CleanupReport {
  removedImages: string[];
  /** Images matching this tool's prefixes that no run in this workspace recorded. */
  orphansFound: string[];
  failedImages: Array<{ ref: string; error: string }>;
  removedContainers: number;
  removedMirrors: string[];
  prunedArtifacts: number;
  prunedBytes: number;
  kept: string[];
}

export function emptyReport(): CleanupReport {
  return {
    removedImages: [],
    orphansFound: [],
    failedImages: [],
    removedContainers: 0,
    removedMirrors: [],
    prunedArtifacts: 0,
    prunedBytes: 0,
    kept: [],
  };
}

export type ImageKind = "runtime" | "task";

export interface CleanupContext {
  config: Cleanup;
  store: Store;
  backend: SandboxBackend;
  artifacts: ArtifactStore;
  workspaceDir: string;
  logger: Logger;
}

const CONTAINER_LABELS = ["solve", "verify", "replay", "task"];

/**
 * Reclaim what a repository needed, once no candidate of that repository can still use it.
 *
 * Called by the runner as soon as a repository's last candidate has been decided, so peak disk
 * usage is bounded by one repository rather than by the whole run.
 */
export async function cleanupAfterRepository(
  ctx: CleanupContext,
  repositoryUrl: string,
): Promise<CleanupReport> {
  const report = emptyReport();

  if (ctx.config.task_images === "after_repository") {
    await removeImages(ctx, report, ctx.store.listRunImages("task", repositoryUrl));
  }
  if (ctx.config.repository_mirrors === "after_repository") {
    await removeMirror(ctx, report, repositoryUrl);
  }
  if (ctx.config.containers === "always") {
    report.removedContainers += await sweepContainers(ctx);
  }

  if (report.removedImages.length > 0 || report.removedMirrors.length > 0) {
    ctx.logger.info("reclaimed disk for a finished repository", {
      repository: repositoryUrl,
      images: report.removedImages.length,
      mirrors: report.removedMirrors.length,
    });
  }
  return report;
}

export interface AfterRunOptions {
  /**
   * Also remove images matching this tool's tag prefixes that no run in this workspace recorded.
   *
   * These are orphans: a run killed before it could record an image, or one whose workspace was
   * deleted, leaves images nothing else will ever reclaim. Off by default because a concurrent
   * run against the same daemon would have its images pulled out from under it.
   */
  removeOrphans?: boolean;
}

/** Reclaim everything the run no longer needs. Called after the export is on disk. */
export async function cleanupAfterRun(
  ctx: CleanupContext,
  exported: readonly Sample[],
  options: AfterRunOptions = {},
): Promise<CleanupReport> {
  const report = emptyReport();

  if (ctx.config.task_images !== "never") {
    await removeImages(ctx, report, ctx.store.listRunImages("task"));
  }
  if (ctx.config.runtime_images === "after_run") {
    await removeImages(ctx, report, ctx.store.listRunImages("runtime"));
    // The image-cache rows must go with the images, otherwise a later run would reuse a tag
    // that no longer exists instead of rebuilding.
    ctx.store.clearImageCache();
  }
  if (ctx.config.base_images === "after_run") {
    await removeImages(ctx, report, ctx.store.listRunImages("base"));
  }
  if (ctx.config.repository_mirrors !== "never") {
    for (const url of ctx.store.repositoriesWithImages()) await removeMirror(ctx, report, url);
    await removeDirectory(ctx, report, join(ctx.workspaceDir, "repos"), "<all mirror clones>");
  }
  if (ctx.config.containers === "always") {
    report.removedContainers += await sweepContainers(ctx);
  }
  if (ctx.config.solution_snapshots === "after_export") {
    await pruneSolutionSnapshots(ctx, report, exported);
  }

  // Orphans are always reported, so leftover disk is visible even when it is not removed.
  const known = new Set([
    ...ctx.store.listRunImages("task"),
    ...ctx.store.listRunImages("runtime"),
    ...report.removedImages,
  ]);
  const present = await ctx.backend.listImages(IMAGE_PREFIXES).catch(() => [] as string[]);
  report.orphansFound = present.filter((ref) => !known.has(ref));
  if (options.removeOrphans && report.orphansFound.length > 0) {
    await removeImages(ctx, report, report.orphansFound);
    report.orphansFound = [];
  }

  report.kept.push(
    "exported dataset (samples.jsonl, conversations.jsonl, evaluator-manifest.jsonl, run-manifest.json)",
    "the run database (forge.sqlite): population manifest, rejections with causes, usage ledger",
    "command logs, test reports and patches in the artifact store",
  );
  return report;
}

async function removeImages(ctx: CleanupContext, report: CleanupReport, refs: readonly string[]): Promise<void> {
  for (const ref of refs) {
    try {
      await ctx.backend.removeImage(ref);
      ctx.store.forgetRunImage(ref);
      report.removedImages.push(ref);
    } catch (error) {
      // A failed removal is reported, never swallowed: leftover disk the caller does not know
      // about is exactly the problem this module exists to avoid.
      report.failedImages.push({ ref, error: (error as Error).message });
    }
  }
}

async function sweepContainers(ctx: CleanupContext): Promise<number> {
  let removed = 0;
  for (const label of CONTAINER_LABELS) {
    try {
      removed += await ctx.backend.cleanup(label);
    } catch (error) {
      ctx.logger.warn("container sweep failed", { label, error: (error as Error).message });
    }
  }
  return removed;
}

async function removeMirror(ctx: CleanupContext, report: CleanupReport, repositoryUrl: string): Promise<void> {
  const dir = ctx.store.mirrorDirFor(repositoryUrl);
  if (!dir) return;
  await removeDirectory(ctx, report, dir, repositoryUrl);
}

async function removeDirectory(
  ctx: CleanupContext,
  report: CleanupReport,
  dir: string,
  label: string,
): Promise<void> {
  const exists = await stat(dir).then(
    () => true,
    () => false,
  );
  if (!exists) return;
  try {
    await rm(dir, { recursive: true, force: true });
    report.removedMirrors.push(label);
  } catch (error) {
    ctx.logger.warn("could not remove a directory", { dir, error: (error as Error).message });
  }
}

/**
 * Drop the stored workspace snapshots.
 *
 * One tar of the entire workspace per accepted attempt, by far the largest artifact class. The
 * solution PATCH is kept, so the change itself remains inspectable; only the full copy goes.
 */
async function pruneSolutionSnapshots(
  ctx: CleanupContext,
  report: CleanupReport,
  exported: readonly Sample[],
): Promise<void> {
  const keep = new Set<string>();
  for (const sample of exported) {
    for (const attempt of sample.attempts) {
      if (attempt.solution_patch_artifact) keep.add(attempt.solution_patch_artifact);
    }
  }

  for (const hash of ctx.store.listSolutionSnapshots()) {
    if (keep.has(hash)) continue;
    const path = ctx.artifacts.resolve(hash);
    const info = await stat(path).catch(() => null);
    if (!info) continue;
    try {
      await rm(path, { force: true });
      report.prunedArtifacts++;
      report.prunedBytes += info.size;
    } catch (error) {
      ctx.logger.warn("could not prune a snapshot artifact", { hash, error: (error as Error).message });
    }
  }
}

export function formatCleanup(report: CleanupReport): string {
  const lines: string[] = ["Cleanup"];
  lines.push(`  container images removed: ${report.removedImages.length}`);
  for (const ref of report.removedImages.slice(0, 8)) lines.push(`    - ${ref}`);
  if (report.removedImages.length > 8) lines.push(`    ... and ${report.removedImages.length - 8} more`);
  if (report.failedImages.length > 0) {
    lines.push(`  images that could NOT be removed: ${report.failedImages.length}`);
    for (const f of report.failedImages.slice(0, 5)) lines.push(`    - ${f.ref}: ${f.error.slice(0, 140)}`);
  }
  lines.push(`  containers removed: ${report.removedContainers}`);
  if (report.orphansFound.length > 0) {
    lines.push(
      `  orphaned images left on the daemon: ${report.orphansFound.length}  ` +
        `(from runs this workspace has no record of; remove them with "forge clean --orphans")`,
    );
    for (const ref of report.orphansFound.slice(0, 8)) lines.push(`    - ${ref}`);
  }
  if (report.removedMirrors.length > 0) {
    lines.push(`  mirror clones removed: ${report.removedMirrors.length}`);
  }
  if (report.prunedArtifacts > 0) {
    lines.push(
      `  workspace snapshots pruned: ${report.prunedArtifacts} (${(report.prunedBytes / 1024 / 1024).toFixed(1)} MiB)`,
    );
  }
  if (report.kept.length > 0) {
    lines.push("  kept:");
    for (const item of report.kept) lines.push(`    - ${item}`);
  }
  return lines.join("\n");
}
