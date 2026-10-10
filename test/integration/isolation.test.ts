import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { buildFixtureRepo, type FixtureCommit } from "../fixtures/build-fixture.ts";
import { Git } from "../../src/sources/git.ts";
import { DockerBackend } from "../../src/sandbox/docker.ts";
import type { SandboxBackend, SandboxContainer } from "../../src/sandbox/types.ts";
import { auditIsolation, currentTreeSha, placeSnapshot } from "../../src/environments/workspace.ts";
import { toolsFor } from "../../src/harness/tools.ts";
import { ArtifactStore } from "../../src/storage/artifacts.ts";
import { createLogger } from "../../src/util/logger.ts";
import type { ToolContext } from "../../src/harness/types.ts";

/**
 * The property the whole tool rests on: a solver working in the prepared workspace has no route
 * back to the historical solution.
 *
 * These run against a real container. They are skipped, loudly, when no usable docker daemon is
 * reachable — never silently passed.
 */

const REPO_DIR = resolve(join(import.meta.dirname, "..", "fixtures", "repo"));
const DOCKER_COMMAND = (process.env.FORGE_DOCKER_COMMAND ?? "docker").split(/\s+/);
const WORKDIR = "/workspace";
const RUN_AS = "1000:1000";

let backend: SandboxBackend;
let dockerAvailable = false;
let imageRef = "";
let git: Git;
let commits: FixtureCommit[];
let workspace = "";
let artifacts: ArtifactStore;
let container: SandboxContainer | undefined;
let parentSha = "";
let targetSha = "";

beforeAll(async () => {
  commits = await buildFixtureRepo(REPO_DIR);
  git = new Git(REPO_DIR);
  workspace = await mkdtemp(join(tmpdir(), "forge-isolation-"));
  artifacts = new ArtifactStore(workspace);

  backend = new DockerBackend({ command: DOCKER_COMMAND, logger: createLogger("test") });
  const availability = await backend.available();
  dockerAvailable = availability.ok;
  if (!dockerAvailable) {
    console.warn(`\n[isolation] SKIPPED: ${availability.detail}\n`);
    return;
  }

  const bugfix = commits.find((c) => c.role === "bugfix")!;
  targetSha = bugfix.sha!;
  parentSha = (await git.listCommits("main", 100)).find((c) => c.sha === targetSha)!.parents[0]!;

  const built = await backend.buildImage({
    baseImage: "python:3.12-slim",
    setupCommands: [
      "apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*",
    ],
    workdir: WORKDIR,
    env: {},
    runAs: RUN_AS,
    tag: "forge-test-isolation:latest",
    timeoutMs: 1_800_000,
  });
  imageRef = built.imageRef;

  container = await backend.createContainer({
    imageRef,
    network: false,
    cpuLimit: 2,
    memoryMb: 1024,
    pidsLimit: 128,
    workdir: WORKDIR,
    user: RUN_AS,
    label: "task",
  });
  await placeSnapshot(container, await git.archiveTar(parentSha), {
    workdir: WORKDIR,
    expectedTreeSha: await git.treeSha(parentSha),
    timeoutMs: 120_000,
    owner: RUN_AS,
  });
}, 1_800_000);

afterAll(async () => {
  await container?.destroy();
  if (dockerAvailable && imageRef) await backend.removeImage(imageRef).catch(() => undefined);
  if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
});

const itDocker = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!dockerAvailable) {
      expect.soft(dockerAvailable, "docker is required for this test and was not available").toBe(true);
      return;
    }
    await fn();
  });

function toolContext(): ToolContext {
  return {
    container: container!,
    workdir: WORKDIR,
    timeoutMs: 120_000,
    artifacts,
    maxOutputChars: 20_000,
    askUser: null,
    logger: createLogger("test"),
  };
}

describe("solver workspace isolation", () => {
  itDocker("places a snapshot that hashes exactly to the parent tree", async () => {
    const { treeSha } = await currentTreeSha(container!, WORKDIR, 120_000);
    expect(treeSha).toBe(await git.treeSha(parentSha));
  });

  itDocker("passes the isolation audit", async () => {
    const audit = await auditIsolation(container!, { workdir: WORKDIR, targetSha, timeoutMs: 120_000 });
    expect(audit.findings).toEqual([]);
    expect(audit.clean).toBe(true);
    expect(audit.commitCount).toBe(1);
    expect(audit.remotes).toEqual([]);
  });

  itDocker("does not contain the target commit object", async () => {
    const result = await container!.exec(["git", "cat-file", "-e", `${targetSha}^{commit}`], {
      cwd: WORKDIR,
      timeoutMs: 60_000,
    });
    expect(result.exitCode).not.toBe(0);
  });

  itDocker("cannot reach the target through any git plumbing the agent could run", async () => {
    for (const argv of [
      ["git", "log", "--all", "--oneline"],
      ["git", "reflog"],
      ["git", "fsck", "--lost-found"],
      ["git", "rev-list", "--all"],
    ]) {
      const result = await container!.exec(argv, { cwd: WORKDIR, timeoutMs: 120_000 });
      const output = result.stdout.toString("utf8") + result.stderr.toString("utf8");
      expect(output, `${argv.join(" ")} leaked the target sha`).not.toContain(targetSha.slice(0, 12));
    }
  });

  itDocker("does not mention the target sha anywhere in the filesystem the agent can read", async () => {
    const result = await container!.exec(["grep", "-rIl", targetSha, "/workspace", "/tmp"], {
      cwd: WORKDIR,
      timeoutMs: 300_000,
    });
    expect(result.stdout.toString("utf8").trim()).toBe("");
  });

  itDocker("does not expose the commit message of the target", async () => {
    const subject = commits.find((c) => c.role === "bugfix")!.message.split("\n")[0]!;
    const result = await container!.exec(["grep", "-rIl", subject, "/workspace"], {
      cwd: WORKDIR,
      timeoutMs: 300_000,
    });
    expect(result.stdout.toString("utf8").trim()).toBe("");
  });

  itDocker("runs commands as a non-root user", async () => {
    const result = await container!.exec(["id", "-u"], { cwd: WORKDIR, timeoutMs: 60_000 });
    expect(result.stdout.toString("utf8").trim()).toBe("1000");
  });

  itDocker("has no network during the solve phase", async () => {
    // The container was created with --network none, so there is not even an interface to use.
    const result = await container!.exec(
      ["python", "-c", "import socket; socket.create_connection(('1.1.1.1', 80), timeout=4)"],
      { cwd: WORKDIR, timeoutMs: 60_000 },
    );
    expect(result.exitCode).not.toBe(0);
  });

  itDocker("does not mount any host path", async () => {
    const result = await container!.exec(["sh", "-c", "cat /proc/mounts"], { cwd: WORKDIR, timeoutMs: 60_000 });
    const mounts = result.stdout.toString("utf8");
    expect(mounts).not.toContain("docker.sock");
    expect(mounts).not.toContain(".pi");
  });
});

describe("tools operate only inside the workspace", () => {
  itDocker("refuses an absolute path", async () => {
    const read = toolsFor({ allowAskUser: false }).find((t) => t.name === "read_file")!;
    await expect(read.execute(read.parse({ path: "/etc/passwd" }), toolContext())).rejects.toThrow(/relative/);
  });

  itDocker("refuses to traverse above the workspace root", async () => {
    const read = toolsFor({ allowAskUser: false }).find((t) => t.name === "read_file")!;
    await expect(read.execute(read.parse({ path: "../../etc/passwd" }), toolContext())).rejects.toThrow(/traverse/);
  });

  itDocker("reports a real failure instead of a plausible-looking success", async () => {
    const run = toolsFor({ allowAskUser: false }).find((t) => t.name === "run_command")!;
    const result = await run.execute(run.parse({ command: "exit 42" }), toolContext());
    expect(result.isError).toBe(true);
    expect((result.output as { exit_code: number }).exit_code).toBe(42);
    expect(result.text).toContain("exit: 42");
  });

  itDocker("applies a patch for real, and says so only when it did", async () => {
    const apply = toolsFor({ allowAskUser: false }).find((t) => t.name === "apply_patch")!;
    const read = toolsFor({ allowAskUser: false }).find((t) => t.name === "read_file")!;

    const before = await read.execute(read.parse({ path: "src/calcstats/stats.py" }), toolContext());
    expect(before.text).not.toContain("MARKER_FROM_TEST");

    const patch = [
      "--- a/src/calcstats/stats.py",
      "+++ b/src/calcstats/stats.py",
      "@@ -1,2 +1,3 @@",
      ' """Small statistics helpers."""',
      "+# MARKER_FROM_TEST",
      "",
      "",
    ].join("\n");

    const applied = await apply.execute(apply.parse({ patch }), toolContext());
    expect(applied.isError).toBe(false);
    expect((applied.output as { applied: boolean }).applied).toBe(true);

    // The claim must be true on disk. A tool that reports success without changing anything is
    // exactly the failure this asserts against.
    const after = await read.execute(read.parse({ path: "src/calcstats/stats.py" }), toolContext());
    expect(after.text).toContain("MARKER_FROM_TEST");

    // Undo, so later assertions still see the pristine parent state.
    const revert = await apply.execute(
      apply.parse({
        patch: patch
          .replace("--- a/src/calcstats/stats.py", "--- a/src/calcstats/stats.py")
          .replace("+# MARKER_FROM_TEST", "-# MARKER_FROM_TEST")
          .replace("@@ -1,2 +1,3 @@", "@@ -1,3 +1,2 @@"),
      }),
      toolContext(),
    );
    expect(revert.isError).toBe(false);
  });

  itDocker("leaves the workspace unchanged when a patch does not apply", async () => {
    const apply = toolsFor({ allowAskUser: false }).find((t) => t.name === "apply_patch")!;
    const treeBefore = (await currentTreeSha(container!, WORKDIR, 120_000)).treeSha;

    const result = await apply.execute(
      apply.parse({
        patch: [
          "--- a/src/calcstats/stats.py",
          "+++ b/src/calcstats/stats.py",
          "@@ -1,3 +1,3 @@",
          " this context does not exist",
          "-neither does this",
          "+nor this",
          "",
        ].join("\n"),
      }),
      toolContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.text).toContain("workspace is unchanged");
    expect((await currentTreeSha(container!, WORKDIR, 120_000)).treeSha).toBe(treeBefore);
  });
});
