import { Buffer } from "node:buffer";
import type { SandboxContainer, SandboxExecResult } from "../sandbox/types.ts";
import { parseOwner, retarWithOwner } from "../util/tar.ts";

/**
 * Workspace preparation inside a sandbox container.
 *
 * The solver receives a brand-new git repository built from a `git archive` tar of the parent
 * tree. A `git archive` contains file contents and modes and NO git objects, so the target
 * commit, its message, its SHA and any other branch are simply not present. Checking out the
 * parent inside a clone would leave future objects reachable; that is never done here.
 */

export const GIT_IDENTITY = [
  "-c",
  "user.name=forge",
  "-c",
  "user.email=forge@invalid",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.fileMode=true",
  "-c",
  "gc.auto=0",
  "-c",
  "advice.detachedHead=false",
];

function git(args: readonly string[]): string[] {
  return ["git", ...GIT_IDENTITY, ...args];
}

export interface SnapshotResult {
  /** Tree hash git computed for the placed snapshot. */
  treeSha: string;
  /** True when it matched the expected parent tree hash exactly. */
  fidelityOk: boolean;
  commands: SandboxExecResult[];
}

async function run(
  container: SandboxContainer,
  argv: readonly string[],
  workdir: string,
  timeoutMs: number,
  collected: SandboxExecResult[],
): Promise<SandboxExecResult> {
  const result = await container.exec(argv, { cwd: workdir, timeoutMs });
  collected.push(result);
  return result;
}

function fail(result: SandboxExecResult): Error {
  return new Error(
    `command failed inside sandbox (exit ${result.exitCode}): ${result.argv.join(" ")}\n` +
      `${result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim()}`.slice(0, 2000),
  );
}

/**
 * Place a `git archive` tar into the container and initialise a fresh repository over it.
 *
 * The initial `git add -A --force` runs on the pristine archive, before any install step, so
 * files the repository tracks despite matching a .gitignore rule are tracked here too and the
 * resulting tree is byte-identical to the source tree.
 */
export async function placeSnapshot(
  container: SandboxContainer,
  archive: Uint8Array,
  options: { workdir: string; expectedTreeSha: string; timeoutMs: number; owner?: string },
): Promise<SnapshotResult> {
  const commands: SandboxExecResult[] = [];
  const { workdir, timeoutMs } = options;

  await emptyWorkdir(container, workdir, timeoutMs, commands);
  await extract(container, archive, workdir, options.owner);

  const init = await run(container, git(["init", "--quiet", "--initial-branch=main", "."]), workdir, timeoutMs, commands);
  if (init.exitCode !== 0) throw fail(init);

  const add = await run(container, git(["add", "-A", "--force", "."]), workdir, timeoutMs, commands);
  if (add.exitCode !== 0) throw fail(add);

  const commit = await run(
    container,
    git(["commit", "--quiet", "--no-verify", "-m", "initial state"]),
    workdir,
    timeoutMs,
    commands,
  );
  if (commit.exitCode !== 0) throw fail(commit);

  const tree = await run(container, git(["rev-parse", "HEAD^{tree}"]), workdir, timeoutMs, commands);
  if (tree.exitCode !== 0) throw fail(tree);
  const treeSha = tree.stdout.toString("utf8").trim();

  return { treeSha, fidelityOk: treeSha === options.expectedTreeSha, commands };
}

/**
 * Stage the current worktree and report its tree hash.
 *
 * `git add -A` without `--force` is deliberate: build output the repository ignores stays out,
 * exactly as it would in the upstream repository, while modifications to tracked files (even
 * ignored ones, which were force-added at init) are always picked up.
 */
export async function currentTreeSha(
  container: SandboxContainer,
  workdir: string,
  timeoutMs: number,
): Promise<{ treeSha: string; commands: SandboxExecResult[] }> {
  const commands: SandboxExecResult[] = [];
  const add = await run(container, git(["add", "-A", "."]), workdir, timeoutMs, commands);
  if (add.exitCode !== 0) throw fail(add);
  const write = await run(container, git(["write-tree"]), workdir, timeoutMs, commands);
  if (write.exitCode !== 0) throw fail(write);
  return { treeSha: write.stdout.toString("utf8").trim(), commands };
}

export interface PollutionReport {
  /** Untracked paths created by install steps; added to .git/info/exclude. */
  untracked: string[];
  /** Tracked files an install step modified. These cannot be excluded without hiding real edits. */
  modifiedTracked: string[];
  treeShaAfter: string;
  restored: boolean;
  commands: SandboxExecResult[];
}

/**
 * Neutralise install-time pollution of the versioned tree.
 *
 * Installing dependencies can drop artefacts (`*.egg-info`, `node_modules`, caches) into the
 * worktree. Untracked artefacts are added to `.git/info/exclude`, which lives inside `.git` and
 * so is invisible to a solver listing the workspace and is not part of the repository content.
 * Tracked files that an install step rewrote are reported instead of hidden: silently excluding
 * them would let a real solver edit disappear from the exactness check.
 */
export async function neutraliseInstallPollution(
  container: SandboxContainer,
  options: { workdir: string; expectedTreeSha: string; timeoutMs: number },
): Promise<PollutionReport> {
  const commands: SandboxExecResult[] = [];
  const { workdir, timeoutMs } = options;

  const status = await run(container, git(["status", "--porcelain=v1", "-z", "-uall"]), workdir, timeoutMs, commands);
  if (status.exitCode !== 0) throw fail(status);

  const untracked: string[] = [];
  const modifiedTracked: string[] = [];
  for (const record of status.stdout.toString("utf8").split("\0")) {
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    if (code === "??") untracked.push(path);
    else modifiedTracked.push(path);
  }

  if (untracked.length > 0) {
    // Anchored patterns so an artefact named like a source file elsewhere is not excluded too.
    const excludeBody = `${untracked.map((p) => `/${p}`).join("\n")}\n`;
    const append = await container.exec(["sh", "-c", "cat >> .git/info/exclude"], {
      cwd: workdir,
      timeoutMs,
      stdin: Buffer.from(excludeBody, "utf8"),
    });
    commands.push(append);
    if (append.exitCode !== 0) throw fail(append);
  }

  const after = await currentTreeSha(container, workdir, timeoutMs);
  commands.push(...after.commands);

  return {
    untracked,
    modifiedTracked,
    treeShaAfter: after.treeSha,
    restored: after.treeSha === options.expectedTreeSha,
    commands,
  };
}

export interface IsolationAudit {
  /** Number of commits reachable in the workspace repository. Must be exactly 1. */
  commitCount: number;
  remotes: string[];
  refs: string[];
  /** Paths whose content mentions the target SHA, if any. */
  targetShaMentions: string[];
  /** True when the workspace carries no route back to the historical solution. */
  clean: boolean;
  findings: string[];
}

/**
 * Audit the solver workspace for any route back to the target commit.
 *
 * Run before handing the container to the solver, and asserted by the integration tests.
 */
export async function auditIsolation(
  container: SandboxContainer,
  options: { workdir: string; targetSha: string; timeoutMs: number },
): Promise<IsolationAudit> {
  const { workdir, timeoutMs, targetSha } = options;
  const findings: string[] = [];

  const count = await container.exec(git(["rev-list", "--all", "--count"]), { cwd: workdir, timeoutMs });
  const commitCount = Number.parseInt(count.stdout.toString("utf8").trim(), 10) || 0;
  if (commitCount !== 1) findings.push(`workspace repository holds ${commitCount} commits, expected exactly 1`);

  const remoteOut = await container.exec(git(["remote"]), { cwd: workdir, timeoutMs });
  const remotes = remoteOut.stdout.toString("utf8").split("\n").map((s) => s.trim()).filter(Boolean);
  if (remotes.length > 0) findings.push(`workspace repository has remotes: ${remotes.join(", ")}`);

  const refOut = await container.exec(git(["for-each-ref", "--format=%(refname)"]), { cwd: workdir, timeoutMs });
  const refs = refOut.stdout.toString("utf8").split("\n").map((s) => s.trim()).filter(Boolean);
  const unexpectedRefs = refs.filter((r) => r !== "refs/heads/main");
  if (unexpectedRefs.length > 0) findings.push(`unexpected refs: ${unexpectedRefs.join(", ")}`);

  // Does the target object exist at all in this repository?
  const hasTarget = await container.exec(git(["cat-file", "-e", `${targetSha}^{commit}`]), {
    cwd: workdir,
    timeoutMs,
  });
  if (hasTarget.exitCode === 0) findings.push(`target commit ${targetSha.slice(0, 12)} is reachable in the workspace`);

  // Is the SHA mentioned anywhere in the working tree (including untracked files)?
  const grep = await container.exec(
    ["grep", "-rIl", "--exclude-dir=.git", targetSha, "."],
    { cwd: workdir, timeoutMs },
  );
  const mentions = grep.stdout.toString("utf8").split("\n").map((s) => s.trim()).filter(Boolean);
  if (mentions.length > 0) findings.push(`target sha appears in: ${mentions.slice(0, 5).join(", ")}`);

  return {
    commitCount,
    remotes,
    refs,
    targetShaMentions: mentions,
    clean: findings.length === 0,
    findings,
  };
}

/** Unified diff of the solver's work against the initial state, for the sample artifacts. */
export async function workspaceDiff(
  container: SandboxContainer,
  workdir: string,
  timeoutMs: number,
): Promise<string> {
  const result = await container.exec(git(["diff", "--patch", "--no-color", "HEAD"]), {
    cwd: workdir,
    timeoutMs,
    maxOutputBytes: 32 * 1024 * 1024,
  });
  return result.stdout.toString("utf8");
}

/**
 * Remove everything under the workdir, including dotfiles.
 *
 * A task image carries the provisioned dependencies AND the parent workspace from preparation.
 * Extracting a new snapshot on top of it would leave the previous `.git`, its `info/exclude` and
 * any install artefacts behind, so `git add -A` would produce a tree that reflects neither state.
 * Every phase therefore starts from an empty workdir; only the installed dependencies, which live
 * outside it, survive.
 */
async function emptyWorkdir(
  container: SandboxContainer,
  workdir: string,
  timeoutMs: number,
  collected: SandboxExecResult[],
): Promise<void> {
  const result = await container.exec(
    ["find", workdir, "-mindepth", "1", "-maxdepth", "1", "-exec", "rm", "-rf", "{}", "+"],
    { cwd: "/", timeoutMs },
  );
  collected.push(result);
  if (result.exitCode !== 0) throw fail(result);
}

/**
 * Unpack an archive into the workdir with the task user as owner.
 *
 * `git archive` records owner 0 and the container runtime preserves the tar's uid/gid, so the
 * files would land root-owned while every task command runs unprivileged. Rewriting the owner
 * inside the archive avoids that without any privileged step: the container keeps `--cap-drop
 * ALL`, and no process ever runs as root inside it.
 */
async function extract(
  container: SandboxContainer,
  archive: Uint8Array,
  workdir: string,
  owner: string | undefined,
): Promise<void> {
  const parsed = owner ? parseOwner(owner) : null;
  await container.putArchive(parsed ? retarWithOwner(archive, parsed.uid, parsed.gid) : archive, workdir);
}

/**
 * Restore a workspace from an archive that already contains its own `.git`.
 *
 * Used for a solver's result: the archive carries the repository the solver worked in, including
 * the `info/exclude` list that defines which paths are tracked. Re-initialising over it would
 * change what `git add -A` picks up, so the existing repository is kept and its tree is simply
 * recomputed and checked against the hash the solve container reported.
 */
export async function restoreWorkspace(
  container: SandboxContainer,
  archive: Uint8Array,
  options: { workdir: string; expectedTreeSha: string; timeoutMs: number; owner?: string },
): Promise<SnapshotResult> {
  const commands: SandboxExecResult[] = [];
  await emptyWorkdir(container, options.workdir, options.timeoutMs, commands);
  await extract(container, archive, options.workdir, options.owner);

  // Report the actual problem rather than an opaque "not a git repository" from the plumbing
  // below. This function restores an archive taken OUT of a workspace, which carries its own
  // .git; a pristine `git archive` tar has none and belongs in placeSnapshot().
  const hasGit = await container.exec(["test", "-d", ".git"], {
    cwd: options.workdir,
    timeoutMs: options.timeoutMs,
  });
  commands.push(hasGit);
  if (hasGit.exitCode !== 0) {
    throw new Error(
      "restoreWorkspace() was given an archive with no .git directory. It restores a workspace " +
        "captured from a container; use placeSnapshot() for a pristine git archive tar.",
    );
  }

  const tree = await currentTreeSha(container, options.workdir, options.timeoutMs);
  commands.push(...tree.commands);
  return { treeSha: tree.treeSha, fidelityOk: tree.treeSha === options.expectedTreeSha, commands };
}
