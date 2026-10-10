import { Buffer } from "node:buffer";
import type { SandboxContainer, SandboxExecResult } from "../sandbox/types.ts";
import type { ArtifactStore } from "../storage/artifacts.ts";
import type { CommandRecord, TestRun } from "../types/index.ts";
import { parseJunitXml } from "./junit.ts";
import type { Recipe } from "./recipe.ts";

const EXCERPT_BYTES = 4000;

/**
 * Record a command execution.
 *
 * The full stdout+stderr always goes to the artifact store; the inline excerpt is a prefix of the
 * real output, never a paraphrase. Nothing here is ever synthesised.
 */
export async function recordCommand(
  label: string,
  result: SandboxExecResult,
  artifacts: ArtifactStore,
): Promise<CommandRecord> {
  const stdout = result.stdout.toString("utf8");
  const stderr = result.stderr.toString("utf8");
  const log =
    `$ ${result.argv.join(" ")}\n` +
    `--- exit: ${result.exitCode}${result.timedOut ? " (timed out)" : ""} in ${result.durationMs}ms\n` +
    `--- stdout${result.stdoutTruncated ? " (truncated by the output cap)" : ""} ---\n${stdout}\n` +
    `--- stderr${result.stderrTruncated ? " (truncated by the output cap)" : ""} ---\n${stderr}\n`;
  return {
    label,
    argv: [...result.argv],
    exit_code: result.exitCode,
    duration_ms: result.durationMs,
    timed_out: result.timedOut,
    log_artifact: await artifacts.put(log),
    stdout_excerpt: stdout.slice(0, EXCERPT_BYTES),
    stderr_excerpt: stderr.slice(0, EXCERPT_BYTES),
  };
}

export interface RunTestsOptions {
  container: SandboxContainer;
  recipe: Recipe;
  workdir: string;
  timeoutMs: number;
  artifacts: ArtifactStore;
  label: string;
  /** Restrict the run to these test ids. Requires `recipe.testSelectionCommand`. */
  selection?: readonly string[];
  signal?: AbortSignal;
}

/**
 * Execute the test suite and parse its machine-readable report.
 *
 * When the runner produces no parsable report the run is marked `parsed: false` and only the
 * suite-level exit code is trusted. Per-test outcomes are never invented to fill the gap.
 */
export async function runTests(options: RunTestsOptions): Promise<TestRun> {
  const { container, recipe, workdir, timeoutMs, artifacts, label } = options;

  let argv: string[];
  if (options.selection && options.selection.length > 0) {
    if (!recipe.testSelectionCommand) {
      throw new Error(`recipe for ${recipe.ecosystem} cannot run a test subset (no test_selection_command)`);
    }
    argv = recipe.testSelectionCommand.flatMap((part) =>
      part === "{tests}" ? [...options.selection!] : [part],
    );
  } else {
    argv = [...recipe.testCommand];
  }

  // A stale report from a previous phase would silently be read as this run's result.
  if (recipe.junitPath) {
    await container.exec(["rm", "-f", recipe.junitPath], { cwd: workdir, timeoutMs: 60_000 });
  }

  const result = await container.exec(argv, {
    cwd: workdir,
    timeoutMs,
    env: recipe.env,
    maxOutputBytes: 8 * 1024 * 1024,
    signal: options.signal,
  });
  const command = await recordCommand(label, result, artifacts);

  let parsed = false;
  let outcomes: TestRun["outcomes"] = [];
  let collectionErrors: string[] = [];
  let totals = { passed: 0, failed: 0, errored: 0, skipped: 0 };

  if (recipe.junitPath) {
    const report = await container.exec(["cat", recipe.junitPath], { cwd: workdir, timeoutMs: 120_000 });
    if (report.exitCode === 0) {
      const junit = parseJunitXml(report.stdout.toString("utf8"));
      if (junit) {
        parsed = true;
        outcomes = junit.outcomes;
        totals = junit.totals;
        collectionErrors = junit.collectionErrors;
        await artifacts.put(report.stdout);
      }
    }
  }

  return { label, command, outcomes, parsed, collection_errors: collectionErrors, totals };
}

/** A run is green when the runner exited 0 and, if parsed, reported no failures or errors. */
export function testRunGreen(run: TestRun): boolean {
  if (run.command.timed_out) return false;
  if (run.command.exit_code !== 0) return false;
  if (run.parsed && (run.totals.failed > 0 || run.totals.errored > 0)) return false;
  return true;
}

export function failingTestIds(run: TestRun): string[] {
  return run.outcomes.filter((o) => o.status === "failed" || o.status === "error").map((o) => o.test_id);
}

export function passingTestIds(run: TestRun): string[] {
  return run.outcomes.filter((o) => o.status === "passed").map((o) => o.test_id);
}

/** Overwrite paths inside a container from a map of path -> bytes. */
export async function writeFiles(
  container: SandboxContainer,
  workdir: string,
  files: ReadonlyMap<string, Uint8Array>,
  timeoutMs: number,
): Promise<void> {
  for (const [path, data] of files) {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
    const mk = await container.exec(["mkdir", "-p", dir], { cwd: workdir, timeoutMs });
    if (mk.exitCode !== 0) {
      throw new Error(`cannot create ${dir}: ${mk.stderr.toString("utf8").slice(0, 300)}`);
    }
    const write = await container.exec(["sh", "-c", `cat > "$1"`, "sh", path], {
      cwd: workdir,
      timeoutMs,
      stdin: Buffer.from(data),
    });
    if (write.exitCode !== 0) {
      throw new Error(`cannot write ${path}: ${write.stderr.toString("utf8").slice(0, 300)}`);
    }
  }
}

export async function removeFiles(
  container: SandboxContainer,
  workdir: string,
  paths: readonly string[],
  timeoutMs: number,
): Promise<void> {
  if (paths.length === 0) return;
  const result = await container.exec(["rm", "-f", ...paths], { cwd: workdir, timeoutMs });
  if (result.exitCode !== 0) {
    throw new Error(`cannot remove ${paths.join(", ")}: ${result.stderr.toString("utf8").slice(0, 300)}`);
  }
}
