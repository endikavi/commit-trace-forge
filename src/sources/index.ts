import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { exec, execOk } from "../util/exec.ts";
import { sha256Hex } from "../util/hash.ts";
import { Git } from "./git.ts";
import type { Logger } from "../util/logger.ts";
import type { RepositoryConfig } from "../config/schema.ts";

export interface AcquiredRepo {
  url: string;
  /** Local mirror clone directory. Never exposed to the solver. */
  dir: string;
  git: Git;
  /** Stable grouping key: forks of the same project share it, so variants stay in one split. */
  family: string;
  /** SHA the configured ref resolved to at acquisition time. Fixed for the whole run. */
  resolvedSha: string;
  license: { spdx: string | null; source: "declared" | "detected" | "unknown"; notice: string | null };
}

/**
 * Derive a repository family. `github.com/owner/repo` and a fork at
 * `github.com/other/repo` both map to `repo`, so forks and cherry-picks group together.
 * Configure `repositories[].family` to override.
 */
export function repositoryFamily(url: string): string {
  const cleaned = url
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/^[^@]+@/, "")
    .replace(/:/g, "/");
  const parts = cleaned.split("/").filter(Boolean);
  const name = parts[parts.length - 1] ?? cleaned;
  return name.toLowerCase();
}

function cacheDirName(url: string): string {
  return `${repositoryFamily(url)}-${sha256Hex(url).slice(0, 12)}`;
}

/** True for a filesystem path rather than a remote URL. */
function isLocalPath(url: string): boolean {
  return !/^(https?|git|ssh):\/\//i.test(url) && !/^[^@\s]+@[^:]+:/.test(url);
}

export interface AcquireOptions {
  workspaceDir: string;
  /**
   * Directory the configuration file lives in. A repository given as a filesystem path resolves
   * against it, exactly like `workspace` does, so a configuration is portable and does not depend
   * on the directory `forge` happens to be invoked from.
   */
  configDir: string;
  logger: Logger;
  /** Skip network fetches when a usable mirror already exists. */
  offline?: boolean;
  timeoutMs?: number;
}

/**
 * Clone (or update) a mirror of the repository under the workspace.
 *
 * A mirror is used because the pipeline only ever reads history; the solver receives a
 * `git archive` snapshot of the parent in a brand-new repository, never this clone.
 */
export async function acquireRepository(
  repo: RepositoryConfig,
  options: AcquireOptions,
): Promise<AcquiredRepo> {
  const reposRoot = join(options.workspaceDir, "repos");
  await mkdir(reposRoot, { recursive: true });
  const dir = join(reposRoot, cacheDirName(repo.url));
  const source = isLocalPath(repo.url)
    ? pathToFileURL(resolve(options.configDir, repo.url)).href
    : repo.url;
  const timeoutMs = options.timeoutMs ?? 1_800_000;

  const exists = await stat(join(dir, "HEAD")).then(
    () => true,
    () => false,
  );

  if (!exists) {
    options.logger.info("cloning mirror", { url: repo.url, dir });
    await execOk(["git", "clone", "--mirror", "--quiet", source, dir], { timeoutMs });
  } else if (!options.offline) {
    options.logger.debug("updating mirror", { url: repo.url });
    const result = await exec(["git", "--git-dir", dir, "fetch", "--prune", "--quiet", "origin", "+refs/*:refs/*"], {
      timeoutMs,
    });
    if (result.exitCode !== 0) {
      options.logger.warn("mirror fetch failed; continuing with the cached mirror", {
        url: repo.url,
        stderr: result.stderr.toString("utf8").trim().slice(0, 400),
      });
    }
  }

  const git = new Git(dir, timeoutMs);
  let resolvedSha: string;
  try {
    resolvedSha = await git.resolveCommit(repo.ref);
  } catch (error) {
    throw new Error(
      `cannot resolve ref "${repo.ref}" in ${repo.url}: ${(error as Error).message.split("\n")[0]}`,
    );
  }

  let license: AcquiredRepo["license"];
  if (repo.license) {
    license = { spdx: repo.license, source: "declared", notice: null };
  } else {
    const detected = await git.detectLicense(resolvedSha);
    license = detected.spdx
      ? { spdx: detected.spdx, source: "detected", notice: detected.notice }
      : { spdx: null, source: "unknown", notice: detected.notice };
  }

  return {
    url: repo.url,
    dir,
    git,
    family: repo.family ?? repositoryFamily(repo.url),
    resolvedSha,
    license,
  };
}
