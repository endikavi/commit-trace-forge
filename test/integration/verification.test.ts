import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Buffer } from "node:buffer";
import { buildFixtureRepo, type FixtureCommit } from "../fixtures/build-fixture.ts";
import { Git } from "../../src/sources/git.ts";
import { DockerBackend } from "../../src/sandbox/docker.ts";
import type { CreateContainerOptions, SandboxBackend } from "../../src/sandbox/types.ts";
import {
  currentTreeSha,
  neutraliseInstallPollution,
  placeSnapshot,
  restoreWorkspace,
} from "../../src/environments/workspace.ts";
import { compareTrees } from "../../src/verification/exact.ts";
import { replayTrajectory } from "../../src/verification/replay.ts";
import { runTests, writeFiles } from "../../src/environments/run.ts";
import { ArtifactStore } from "../../src/storage/artifacts.ts";
import { createLogger } from "../../src/util/logger.ts";
import { toolsFor } from "../../src/harness/tools.ts";
import { ScriptedHarness } from "../../src/harness/scripted.ts";
import type { Recipe } from "../../src/environments/recipe.ts";
import type { ToolContext } from "../../src/harness/types.ts";

/**
 * The three verification results, against a real container.
 *
 * The important assertions are the negative ones: a functionally correct but textually different
 * solution must NOT pass as exact, a fabricated test result must NOT satisfy the verifier, and a
 * divergent replay must be rejected.
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
let artifacts: ArtifactStore;
let workspace = "";
let parentSha = "";
let targetSha = "";
let recipe: Recipe;

const containerOptions = (): Omit<CreateContainerOptions, "network"> => ({
  imageRef,
  cpuLimit: 2,
  memoryMb: 1024,
  pidsLimit: 128,
  workdir: WORKDIR,
  user: RUN_AS,
  label: "verify",
});

beforeAll(async () => {
  commits = await buildFixtureRepo(REPO_DIR);
  git = new Git(REPO_DIR);
  workspace = await mkdtemp(join(tmpdir(), "forge-verify-"));
  artifacts = new ArtifactStore(workspace);

  backend = new DockerBackend({ command: DOCKER_COMMAND, logger: createLogger("test") });
  const availability = await backend.available();
  dockerAvailable = availability.ok;
  if (!dockerAvailable) {
    console.warn(`\n[verification] SKIPPED: ${availability.detail}\n`);
    return;
  }

  const bugfix = commits.find((c) => c.role === "bugfix")!;
  targetSha = bugfix.sha!;
  parentSha = (await git.listCommits("main", 100)).find((c) => c.sha === targetSha)!.parents[0]!;

  recipe = {
    ecosystem: "python",
    baseImage: "python:3.12-slim",
    architecture: "amd64",
    imageSetupCommands: [],
    installCommands: ["python -m pip install --no-cache-dir -e ."],
    testCommand: ["python", "-m", "pytest", "-p", "no:cacheprovider", "-q", "--junit-xml=/tmp/forge-report/junit.xml"],
    testSelectionCommand: [
      "python", "-m", "pytest", "-p", "no:cacheprovider", "-q", "--junit-xml=/tmp/forge-report/junit.xml", "{tests}",
    ],
    junitPath: "/tmp/forge-report/junit.xml",
    workdir: WORKDIR,
    env: { PYTHONDONTWRITEBYTECODE: "1" },
    manifestPaths: [],
    manifestHashes: {},
    detection: [],
  };

  const built = await backend.buildImage({
    baseImage: "python:3.12-slim",
    setupCommands: [
      "apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*",
      "python -m pip install --no-cache-dir pytest==8.3.4",
      "mkdir -p /tmp/forge-report && chmod 777 /tmp/forge-report",
    ],
    workdir: WORKDIR,
    env: recipe.env,
    runAs: RUN_AS,
    tag: "forge-test-verify:latest",
    timeoutMs: 1_800_000,
  });
  imageRef = built.imageRef;
}, 1_800_000);

afterAll(async () => {
  if (dockerAvailable && imageRef) await backend.removeImage(imageRef).catch(() => undefined);
  if (dockerAvailable) await backend.cleanup("verify").catch(() => undefined);
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

/**
 * Start a container holding the parent state, provisioned.
 *
 * The install matters: without it the package is not importable and every suite fails at
 * collection, which would make a test look like it proved something about behaviour when it only
 * proved the environment was never provisioned.
 */
async function parentContainer(options: { install?: boolean } = {}) {
  const install = options.install ?? true;
  const container = await backend.createContainer({ ...containerOptions(), network: install });
  await placeSnapshot(container, await git.archiveTar(parentSha), {
    workdir: WORKDIR,
    expectedTreeSha: await git.treeSha(parentSha),
    timeoutMs: 180_000,
    owner: RUN_AS,
  });
  if (install) {
    const result = await container.exec(["sh", "-c", recipe.installCommands.join(" && ")], {
      cwd: WORKDIR,
      timeoutMs: 900_000,
      env: recipe.env,
    });
    expect(result.exitCode, result.stderr.toString("utf8").slice(0, 1500)).toBe(0);
    // Installing drops an egg-info directory into the worktree; exclude it so tree hashes keep
    // describing repository content rather than build output.
    await neutraliseInstallPollution(container, {
      workdir: WORKDIR,
      expectedTreeSha: await git.treeSha(parentSha),
      timeoutMs: 180_000,
    });
  }
  return container;
}

describe("A. exact reconstruction", () => {
  itDocker("recognises a byte-identical reconstruction", async () => {
    const container = await backend.createContainer({ ...containerOptions(), network: false });
    try {
      // Placing the TARGET snapshot is, by definition, a perfect reconstruction of it.
      await placeSnapshot(container, await git.archiveTar(targetSha), {
        workdir: WORKDIR,
        expectedTreeSha: await git.treeSha(targetSha),
        timeoutMs: 180_000,
        owner: RUN_AS,
      });
      const { treeSha } = await currentTreeSha(container, WORKDIR, 180_000);

      const comparison = await compareTrees({
        git,
        targetSha,
        resultTreeSha: treeSha,
        container,
        workdir: WORKDIR,
        timeoutMs: 180_000,
      });
      expect(comparison.exact).toBe(true);
      expect(comparison.differences).toEqual([]);
    } finally {
      await container.destroy();
    }
  });

  itDocker("does NOT accept a whitespace-only difference as exact", async () => {
    const container = await parentContainer({ install: false });
    try {
      // Apply the target's content, then perturb whitespace only. The behaviour is identical and
      // a normalised comparison would call it equal; exactness must still say no.
      const targetStats = (await git.showFile(targetSha, "src/calcstats/stats.py"))!.toString("utf8");
      const targetTests = (await git.showFile(targetSha, "tests/test_stats.py"))!.toString("utf8");
      await writeFiles(
        container,
        WORKDIR,
        new Map([
          ["src/calcstats/stats.py", Buffer.from(targetStats.replace("if old == 0:", "if old  ==  0:"), "utf8")],
          ["tests/test_stats.py", Buffer.from(targetTests, "utf8")],
        ]),
        180_000,
      );
      const { treeSha } = await currentTreeSha(container, WORKDIR, 180_000);

      const comparison = await compareTrees({
        git,
        targetSha,
        resultTreeSha: treeSha,
        container,
        workdir: WORKDIR,
        timeoutMs: 180_000,
        computeNormalizedDiagnostic: true,
      });

      expect(comparison.exact).toBe(false);
      expect(comparison.differences.map((d) => d.path)).toContain("src/calcstats/stats.py");
      // The diagnostic may notice the similarity, but it never changes the verdict.
      expect(comparison.exact).toBe(false);
    } finally {
      await container.destroy();
    }
  });

  itDocker("does NOT accept a functionally equivalent but differently written solution as exact", async () => {
    const container = await parentContainer();
    try {
      const targetTests = (await git.showFile(targetSha, "tests/test_stats.py"))!.toString("utf8");
      const parentStats = (await git.showFile(parentSha, "src/calcstats/stats.py"))!.toString("utf8");
      // A different implementation of the same requirement: guard written another way.
      const alternative = parentStats.replace(
        "    return (new - old) / old * 100.0",
        [
          "    if not old:",
          '        raise ValueError("percent_change() requires a non-zero baseline")',
          "    return (new - old) / old * 100.0",
        ].join("\n"),
      );
      await writeFiles(
        container,
        WORKDIR,
        new Map([
          ["src/calcstats/stats.py", Buffer.from(alternative, "utf8")],
          ["tests/test_stats.py", Buffer.from(targetTests, "utf8")],
        ]),
        180_000,
      );

      // It behaves correctly...
      const run = await runTests({
        container,
        recipe,
        workdir: WORKDIR,
        timeoutMs: 600_000,
        artifacts,
        label: "alternative_solution",
      });
      expect(run.command.exit_code, run.command.stdout_excerpt).toBe(0);

      // ...and it is still not an exact reconstruction.
      const { treeSha } = await currentTreeSha(container, WORKDIR, 180_000);
      const comparison = await compareTrees({
        git,
        targetSha,
        resultTreeSha: treeSha,
        container,
        workdir: WORKDIR,
        timeoutMs: 180_000,
      });
      expect(comparison.exact).toBe(false);
    } finally {
      await container.destroy();
    }
  });
});

describe("B. a fabricated test result cannot satisfy the verifier", () => {
  itDocker("ignores a test report the workspace merely contains", async () => {
    const container = await parentContainer();
    try {
      // A solver could write a perfect-looking JUnit report into the workspace. The verifier
      // reads the report the RUNNER wrote, at a path outside the workspace, after deleting any
      // stale copy, so a planted file changes nothing.
      await writeFiles(
        container,
        WORKDIR,
        new Map([
          [
            "junit.xml",
            Buffer.from(
              '<testsuites><testsuite name="pytest" tests="99" failures="0"><testcase classname="tests.test_stats" name="everything" file="tests/test_stats.py"/></testsuite></testsuites>',
              "utf8",
            ),
          ],
        ]),
        180_000,
      );

      const targetTests = (await git.showFile(targetSha, "tests/test_stats.py"))!;
      await writeFiles(container, WORKDIR, new Map([["tests/test_stats.py", targetTests]]), 180_000);

      const run = await runTests({
        container,
        recipe,
        workdir: WORKDIR,
        timeoutMs: 600_000,
        artifacts,
        label: "planted_report",
      });

      // The parent source cannot satisfy the target's tests, and the planted file did not help.
      expect(run.command.exit_code).not.toBe(0);
      expect(run.outcomes.some((o) => o.test_id.includes("everything"))).toBe(false);
    } finally {
      await container.destroy();
    }
  });

  itDocker("a solver that deletes the tests does not thereby pass", async () => {
    const container = await parentContainer({ install: false });
    try {
      // Delete every visible test, the crudest way to make a suite "green".
      const removed = await container.exec(["sh", "-c", "rm -rf tests && mkdir -p tests"], {
        cwd: WORKDIR,
        timeoutMs: 120_000,
      });
      expect(removed.exitCode).toBe(0);

      const empty = await runTests({
        container,
        recipe,
        workdir: WORKDIR,
        timeoutMs: 600_000,
        artifacts,
        label: "tests_deleted",
      });
      // With no tests, pytest reports nothing to run; it is not evidence of anything.
      expect(empty.totals.passed).toBe(0);

      // Verification restores the hidden tests over the solver's copy, which is what actually
      // decides the outcome.
      const targetTests = (await git.showFile(targetSha, "tests/test_stats.py"))!;
      await writeFiles(container, WORKDIR, new Map([["tests/test_stats.py", targetTests]]), 180_000);
      const restored = await runTests({
        container,
        recipe,
        workdir: WORKDIR,
        timeoutMs: 600_000,
        artifacts,
        label: "tests_restored",
      });
      expect(restored.command.exit_code).not.toBe(0);
    } finally {
      await container.destroy();
    }
  });
});

describe("C. replay", () => {
  itDocker("passes when the recorded actions reproduce the result", async () => {
    const container = await parentContainer({ install: false });
    const parentTree = await git.treeSha(parentSha);
    let events;
    let resultTree = "";
    try {
      const harness = new ScriptedHarness(() => [
        { call: { tool: "list_files", input: { path: ".", max_depth: 2 } } },
        { call: { tool: "run_command", input: { command: "echo replay-probe > probe.txt" } } },
        { call: { tool: "read_file", input: { path: "probe.txt" } } },
      ]);
      const context: ToolContext = {
        container,
        workdir: WORKDIR,
        timeoutMs: 120_000,
        artifacts,
        maxOutputChars: 20_000,
        askUser: null,
        logger: createLogger("test"),
      };
      const response = await harness.solve({
        userPrompt: "leave a probe file",
        systemPrompt: "",
        tools: toolsFor({ allowAskUser: false }),
        toolContext: context,
        maxTurns: 10,
        decisionSummaries: false,
        model: { provider: "none", model: "none", thinking: "off" },
        timeoutMs: 120_000,
      });
      expect(response.outcome).toBe("completed");
      expect(response.executionMode).toBe("scripted_fixture");
      events = response.events;
      resultTree = (await currentTreeSha(container, WORKDIR, 120_000)).treeSha;
    } finally {
      await container.destroy();
    }

    const replay = await replayTrajectory({
      events,
      parentArchive: await git.archiveTar(parentSha),
      parentTreeSha: parentTree,
      expectedTreeSha: resultTree,
      recipe,
      backend,
      containerOptions: containerOptions(),
      tools: toolsFor({ allowAskUser: true }),
      artifacts,
      timeoutMs: 600_000,
      maxOutputChars: 20_000,
      network: false,
      logger: createLogger("test"),
      runAs: RUN_AS,
      expectedFinalTestsGreen: null,
    });

    expect(replay.divergences, JSON.stringify(replay.divergences)).toEqual([]);
    expect(replay.passed).toBe(true);
    expect(replay.replayed_tree_sha).toBe(resultTree);
  });

  itDocker("REJECTS a replay whose final tree diverges", async () => {
    const container = await parentContainer({ install: false });
    const parentTree = await git.treeSha(parentSha);
    let events;
    try {
      const harness = new ScriptedHarness(() => [
        { call: { tool: "run_command", input: { command: "echo one > note.txt" } } },
      ]);
      const response = await harness.solve({
        userPrompt: "write a note",
        systemPrompt: "",
        tools: toolsFor({ allowAskUser: false }),
        toolContext: {
          container,
          workdir: WORKDIR,
          timeoutMs: 120_000,
          artifacts,
          maxOutputChars: 20_000,
          askUser: null,
          logger: createLogger("test"),
        },
        maxTurns: 10,
        decisionSummaries: false,
        model: { provider: "none", model: "none", thinking: "off" },
        timeoutMs: 120_000,
      });
      events = response.events;
    } finally {
      await container.destroy();
    }

    const replay = await replayTrajectory({
      events,
      parentArchive: await git.archiveTar(parentSha),
      parentTreeSha: parentTree,
      // Claim a result the replayed actions cannot possibly produce.
      expectedTreeSha: "0000000000000000000000000000000000000000",
      recipe,
      backend,
      containerOptions: containerOptions(),
      tools: toolsFor({ allowAskUser: true }),
      artifacts,
      timeoutMs: 600_000,
      maxOutputChars: 20_000,
      network: false,
      logger: createLogger("test"),
      runAs: RUN_AS,
      expectedFinalTestsGreen: null,
    });

    expect(replay.passed).toBe(false);
    expect(replay.divergences.map((d) => d.kind)).toContain("final_tree_mismatch");
  });

  itDocker("REJECTS a replay that starts from the wrong state", async () => {
    const replay = await replayTrajectory({
      events: [],
      parentArchive: await git.archiveTar(parentSha),
      parentTreeSha: "1111111111111111111111111111111111111111",
      expectedTreeSha: null,
      recipe,
      backend,
      containerOptions: containerOptions(),
      tools: toolsFor({ allowAskUser: true }),
      artifacts,
      timeoutMs: 600_000,
      maxOutputChars: 20_000,
      network: false,
      logger: createLogger("test"),
      runAs: RUN_AS,
      expectedFinalTestsGreen: null,
    });
    expect(replay.passed).toBe(false);
    expect(replay.divergences[0]?.kind).toBe("precondition_mismatch");
  });

  itDocker("REJECTS a replay whose commands exit differently", async () => {
    const container = await parentContainer({ install: false });
    const parentTree = await git.treeSha(parentSha);
    let events;
    try {
      const harness = new ScriptedHarness(() => [
        // Succeeds here because the file exists in the parent state.
        { call: { tool: "run_command", input: { command: "test -f pyproject.toml && rm pyproject.toml" } } },
      ]);
      const response = await harness.solve({
        userPrompt: "remove the manifest",
        systemPrompt: "",
        tools: toolsFor({ allowAskUser: false }),
        toolContext: {
          container,
          workdir: WORKDIR,
          timeoutMs: 120_000,
          artifacts,
          maxOutputChars: 20_000,
          askUser: null,
          logger: createLogger("test"),
        },
        maxTurns: 10,
        decisionSummaries: false,
        model: { provider: "none", model: "none", thinking: "off" },
        timeoutMs: 120_000,
      });
      events = response.events;
    } finally {
      await container.destroy();
    }

    // Replay the same call twice: the second run cannot succeed, because the file is gone.
    const doubled = [...events, ...events.filter((e) => e.type === "tool_call").map((e, i) => ({
      ...e,
      event_id: `dup_${i}`,
      seq: 1000 + i,
    }))];

    const replay = await replayTrajectory({
      events: doubled,
      parentArchive: await git.archiveTar(parentSha),
      parentTreeSha: parentTree,
      expectedTreeSha: null,
      recipe,
      backend,
      containerOptions: containerOptions(),
      tools: toolsFor({ allowAskUser: true }),
      artifacts,
      timeoutMs: 600_000,
      maxOutputChars: 20_000,
      network: false,
      logger: createLogger("test"),
      runAs: RUN_AS,
      expectedFinalTestsGreen: null,
    });

    expect(replay.passed).toBe(false);
    expect(replay.divergences.length).toBeGreaterThan(0);
  });
});

describe("workspace restoration", () => {
  itDocker("detects a restored workspace that does not match its claimed hash", async () => {
    // Capture a real workspace archive, the way the pipeline does after a solve attempt.
    const source = await parentContainer({ install: false });
    let archive;
    try {
      archive = await source.getArchive(`${WORKDIR}/.`);
    } finally {
      await source.destroy();
    }

    const container = await backend.createContainer({ ...containerOptions(), network: false });
    try {
      const restored = await restoreWorkspace(container, archive, {
        workdir: WORKDIR,
        expectedTreeSha: "2222222222222222222222222222222222222222",
        timeoutMs: 180_000,
        owner: RUN_AS,
      });
      // The hash is recomputed from the restored files, so a false claim cannot pass unnoticed.
      expect(restored.fidelityOk).toBe(false);
      expect(restored.treeSha).toBe(await git.treeSha(parentSha));
    } finally {
      await container.destroy();
    }
  });

  itDocker("refuses a pristine archive, naming the function that handles it", async () => {
    const container = await backend.createContainer({ ...containerOptions(), network: false });
    try {
      await expect(
        restoreWorkspace(container, await git.archiveTar(parentSha), {
          workdir: WORKDIR,
          expectedTreeSha: await git.treeSha(parentSha),
          timeoutMs: 180_000,
          owner: RUN_AS,
        }),
      ).rejects.toThrow(/placeSnapshot/);
    } finally {
      await container.destroy();
    }
  });
});
