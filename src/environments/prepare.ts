import { Buffer } from "node:buffer";
import type { ForgeConfig } from "../config/schema.ts";
import type { AcquiredRepo } from "../sources/index.ts";
import type { ArtifactStore } from "../storage/artifacts.ts";
import type { Logger } from "../util/logger.ts";
import { ForgeError } from "../util/errors.ts";
import type { CreateContainerOptions, SandboxBackend, SandboxContainer } from "../sandbox/types.ts";
import type { CandidateIdentity, EnvironmentVerification, TestRun } from "../types/index.ts";
import {
  detectRecipe,
  imageCacheKey,
  recipeId,
  RecipeDetectionError,
  taskImageCacheKey,
  type Recipe,
} from "./recipe.ts";
import { auditIsolation, neutraliseInstallPollution, placeSnapshot } from "./workspace.ts";
import { failingTestIds, passingTestIds, recordCommand, runTests, testRunGreen, writeFiles } from "./run.ts";
import { moduleToPath } from "./junit.ts";
import type { Store } from "../storage/state.ts";

export interface PrepareInput {
  config: ForgeConfig;
  repo: AcquiredRepo;
  identity: CandidateIdentity;
  backend: SandboxBackend;
  artifacts: ArtifactStore;
  store: Store;
  logger: Logger;
  signal?: AbortSignal;
}

export interface PrepareOutput {
  recipe: Recipe;
  recipeHash: string;
  verification: EnvironmentVerification;
  /** Image containing the runtime plus the PARENT's dependencies and the parent snapshot. */
  solveImageRef: string;
  /** Test paths changed by the target commit. Used to build the hidden test set. */
  changedTestPaths: string[];
}

const SOLVE_LABEL = "solve";

/**
 * Tail of a command's real output, for the rejection message.
 *
 * The complete log is always in the artifact store; this is a verbatim excerpt so a reader can
 * see the actual failure without opening it. Nothing here is summarised or paraphrased.
 */
function excerpt(record: { stdout_excerpt: string; stderr_excerpt: string } | null): string {
  if (!record) return "";
  const combined = `${record.stdout_excerpt}\n${record.stderr_excerpt}`.trimEnd();
  const lines = combined.split("\n").filter((line) => line.trim().length > 0);
  return lines.slice(-12).join("\n");
}

/**
 * Prepare and verify the environment for one candidate.
 *
 * Four things are checked in isolation, each in its own container:
 *   1. the parent installs and its reference suite is green (strict mode)
 *   2. the target installs and its reference suite is green
 *   3. the target's tests fail against the parent's source  -> fail-to-pass evidence
 *   4. the snapshot placed in the container reproduces the parent tree byte for byte
 *
 * Every command, exit code, duration and log is recorded. A candidate that cannot be verified is
 * discarded with an explicit cause rather than carried forward on optimism.
 */
export async function prepareEnvironment(input: PrepareInput): Promise<PrepareOutput> {
  const { config, repo, identity, backend, artifacts, logger } = input;
  const repoConfig = config.repositories.find((r) => r.url === repo.url);
  if (!repoConfig) throw new ForgeError("internal_error", `no config entry for ${repo.url}`);

  // ---- recipe ------------------------------------------------------------
  let recipe: Recipe;
  try {
    recipe = await detectRecipe({
      git: repo.git,
      rev: identity.parent_sha,
      repoConfig,
      architecture: process.arch === "arm64" ? "arm64" : "amd64",
    });
  } catch (error) {
    if (error instanceof RecipeDetectionError) {
      throw new ForgeError("env_recipe_undetected", error.message, { detection: error.detection });
    }
    throw error;
  }

  const runtimeKey = imageCacheKey(recipe, null);
  const timeouts = {
    provision: config.sandbox.provision_timeout_seconds * 1000,
    command: config.sandbox.command_timeout_seconds * 1000,
    task: config.sandbox.task_timeout_seconds * 1000,
  };

  // ---- runtime image (cached across candidates) --------------------------
  let runtimeImage = input.store.getImage(runtimeKey);
  if (!runtimeImage) {
    logger.info("building runtime image", { ecosystem: recipe.ecosystem, base: recipe.baseImage });
    try {
      const built = await backend.buildImage({
        baseImage: recipe.baseImage,
        setupCommands: recipe.imageSetupCommands,
        workdir: recipe.workdir,
        env: recipe.env,
        runAs: config.sandbox.run_as,
        tag: `forge-runtime:${runtimeKey.split(":")[1]}`,
        timeoutMs: timeouts.provision,
      });
      await artifacts.put(built.buildLog);
      input.store.putImage(runtimeKey, built.imageRef, built.digest, recipe, backend.name);
      input.store.recordRunImage(built.imageRef, "runtime", null);
      input.store.recordRunImage(recipe.baseImage, "base", null);
      runtimeImage = { image_ref: built.imageRef, image_digest: built.digest };
    } catch (error) {
      const log = (error as Error & { buildLog?: string }).buildLog;
      if (log) await artifacts.put(log);
      throw new ForgeError("env_image_build_failed", (error as Error).message);
    }
  }

  const commonContainerOptions: Omit<CreateContainerOptions, "network"> = {
    imageRef: runtimeImage.image_ref,
    cpuLimit: config.sandbox.cpu_limit,
    memoryMb: config.sandbox.memory_mb,
    pidsLimit: config.sandbox.pids_limit,
    workdir: recipe.workdir,
    user: config.sandbox.run_as,
    env: recipe.env,
  };

  const verification: EnvironmentVerification = {
    recipe_id: recipeId(recipe, runtimeImage.image_digest),
    image_ref: runtimeImage.image_ref,
    image_digest: runtimeImage.image_digest,
    snapshot_fidelity_ok: false,
    parent_install: null,
    parent_tests: null,
    target_install: null,
    target_tests: null,
    dependency_changes: [],
    offline_store_ready: false,
    preexisting_failures: [],
    fail_to_pass: [],
    pass_to_pass: [],
    ok: false,
    rejection_cause: null,
  };

  // ---- dependency delta ---------------------------------------------------
  // Computed on the evaluator side from the mirror clone, never inside a solver container.
  const dependencyChanges: string[] = [];
  for (const path of recipe.manifestPaths) {
    const before = await repo.git.showFile(identity.parent_sha, path);
    const after = await repo.git.showFile(identity.target_sha, path);
    const beforeText = before?.toString("utf8") ?? null;
    const afterText = after?.toString("utf8") ?? null;
    if (beforeText !== afterText) dependencyChanges.push(path);
  }
  verification.dependency_changes = dependencyChanges;

  if (dependencyChanges.length > 0) {
    if (config.sandbox.dependency_policy === "reject_new") {
      verification.rejection_cause = "env_dependency_unresolvable_offline";
      throw new ForgeError(
        "env_dependency_unresolvable_offline",
        `reaching the target changes dependency manifests (${dependencyChanges.join(", ")}) and ` +
          `sandbox.dependency_policy is "reject_new"`,
        { verification },
      );
    }
    if (config.sandbox.dependency_policy === "offline_store") {
      // Not implemented. Carrying on would provision from the PARENT's manifests and then run the
      // solver with no network, so a candidate that genuinely needs a new dependency would fail
      // for a reason the record would attribute to the agent. Refusing is the honest behaviour.
      verification.rejection_cause = "env_dependency_unresolvable_offline";
      throw new ForgeError(
        "env_dependency_unresolvable_offline",
        `reaching the target changes dependency manifests (${dependencyChanges.join(", ")}) and ` +
          `sandbox.dependency_policy is "offline_store", which is NOT IMPLEMENTED. ` +
          `Use "reject_new" to discard such candidates, or "allow_network_during_solve" to let the ` +
          `solver install them (recorded on the sample as relaxed isolation).`,
        { verification },
      );
    }
    // allow_network_during_solve: provisioning proceeds, and the solve container is created with
    // network access. The sample records that this candidate ran with relaxed isolation.
    logger.warn("target changes dependency manifests; the solver will run WITH network access", {
      candidate: identity.candidate_id,
      manifests: dependencyChanges,
    });
  }

  const parentArchive = await repo.git.archiveTar(identity.parent_sha);
  const targetArchive = await repo.git.archiveTar(identity.target_sha);

  // ---- phase 1: parent install + baseline suite ---------------------------
  let solveImageRef: string;
  const parentContainer = await backend.createContainer({ ...commonContainerOptions, network: true, label: SOLVE_LABEL });
  try {
    const snapshot = await placeSnapshot(parentContainer, parentArchive, {
      workdir: recipe.workdir,
      expectedTreeSha: identity.parent_tree_sha,
      timeoutMs: timeouts.command,
      owner: config.sandbox.run_as,
    });
    if (!snapshot.fidelityOk) {
      verification.rejection_cause = "env_snapshot_fidelity_mismatch";
      throw new ForgeError(
        "env_snapshot_fidelity_mismatch",
        `the snapshot placed in the container hashes to ${snapshot.treeSha} but the parent tree is ` +
          `${identity.parent_tree_sha}; the workspace does not faithfully represent the parent state`,
        { verification },
      );
    }
    verification.snapshot_fidelity_ok = true;

    const install = await runInstall(parentContainer, recipe, timeouts.provision, input, "parent_install");
    verification.parent_install = install.record;
    if (!install.ok) {
      verification.rejection_cause = "env_parent_install_failed";
      throw new ForgeError(
        "env_parent_install_failed",
        `installing the parent revision failed (exit ${install.record?.exit_code}); ` +
          `full log: ${install.record?.log_artifact}
` +
          excerpt(install.record),
        { verification },
      );
    }

    const pollution = await neutraliseInstallPollution(parentContainer, {
      workdir: recipe.workdir,
      expectedTreeSha: identity.parent_tree_sha,
      timeoutMs: timeouts.command,
    });
    if (!pollution.restored) {
      verification.rejection_cause = "env_snapshot_fidelity_mismatch";
      throw new ForgeError(
        "env_snapshot_fidelity_mismatch",
        `installing dependencies changed the versioned tree and it could not be restored ` +
          `(modified tracked files: ${pollution.modifiedTracked.slice(0, 5).join(", ") || "none"}); ` +
          `exactness could not be measured honestly`,
        { verification, untracked: pollution.untracked.slice(0, 20) },
      );
    }

    const audit = await auditIsolation(parentContainer, {
      workdir: recipe.workdir,
      targetSha: identity.target_sha,
      timeoutMs: timeouts.command,
    });
    if (!audit.clean) {
      verification.rejection_cause = "grade_gate_isolation";
      throw new ForgeError("grade_gate_isolation", `workspace isolation audit failed: ${audit.findings.join("; ")}`, {
        verification,
        audit,
      });
    }
    await artifacts.putJson({ kind: "isolation_audit", candidate: identity.candidate_id, audit });

    const baseline = await runTests({
      container: parentContainer,
      recipe,
      workdir: recipe.workdir,
      timeoutMs: timeouts.task,
      artifacts,
      label: "parent_reference_suite",
      signal: input.signal,
    });
    verification.parent_tests = baseline;

    if (config.verification.strict_baseline && !testRunGreen(baseline)) {
      verification.rejection_cause = "env_parent_baseline_broken";
      throw new ForgeError(
        "env_parent_baseline_broken",
        `the parent baseline is not green (exit ${baseline.command.exit_code}, ` +
          `${baseline.totals.failed} failed / ${baseline.totals.errored} errored); ` +
          `strict mode discards candidates with pre-existing failures. ` +
          `full log: ${baseline.command.log_artifact}`,
        { verification },
      );
    }

    // Freeze the provisioned parent state. Every later phase starts from this image with no
    // network, so provisioning and solving are cleanly separated.
    const frozen = await backend.commitContainer(
      parentContainer,
      `forge-task:${taskImageCacheKey(recipe, repo.url, identity.parent_sha, runtimeImage.image_digest).split(":")[1]}`,
    );
    solveImageRef = frozen.imageRef;
    // Tracked so cleanup can drop it once this repository is finished: one committed image per
    // (repository, parent revision) is by far the largest thing a run leaves behind.
    input.store.recordRunImage(frozen.imageRef, "task", repo.url);
  } finally {
    await parentContainer.destroy();
  }

  // ---- phase 2: target install + suite ------------------------------------
  const targetContainer = await backend.createContainer({ ...commonContainerOptions, network: true, label: SOLVE_LABEL });
  try {
    const snapshot = await placeSnapshot(targetContainer, targetArchive, {
      workdir: recipe.workdir,
      expectedTreeSha: identity.target_tree_sha,
      timeoutMs: timeouts.command,
      owner: config.sandbox.run_as,
    });
    if (!snapshot.fidelityOk) {
      verification.rejection_cause = "env_snapshot_fidelity_mismatch";
      throw new ForgeError(
        "env_snapshot_fidelity_mismatch",
        `the target snapshot hashes to ${snapshot.treeSha}, expected ${identity.target_tree_sha}`,
        { verification },
      );
    }

    const install = await runInstall(targetContainer, recipe, timeouts.provision, input, "target_install");
    verification.target_install = install.record;
    if (!install.ok) {
      verification.rejection_cause = "env_target_install_failed";
      throw new ForgeError(
        "env_target_install_failed",
        `installing the target revision failed (exit ${install.record?.exit_code}); ` +
          `full log: ${install.record?.log_artifact}
` +
          excerpt(install.record),
        { verification },
      );
    }

    const targetTests = await runTests({
      container: targetContainer,
      recipe,
      workdir: recipe.workdir,
      timeoutMs: timeouts.task,
      artifacts,
      label: "target_reference_suite",
      signal: input.signal,
    });
    verification.target_tests = targetTests;

    if (!testRunGreen(targetTests)) {
      verification.rejection_cause = "env_target_tests_failed";
      throw new ForgeError(
        "env_target_tests_failed",
        `the target revision's own suite is not green (exit ${targetTests.command.exit_code}); ` +
          `it cannot serve as the objective. full log: ${targetTests.command.log_artifact}`,
        { verification },
      );
    }
  } finally {
    await targetContainer.destroy();
  }

  // ---- phase 3: fail-to-pass probe ----------------------------------------
  const changedTestPaths = await collectChangedTestPaths(repo, identity, recipe);
  const probe = await runFailToPassProbe({
    input,
    recipe,
    solveImageRef,
    commonContainerOptions,
    timeouts,
    changedTestPaths,
  });
  verification.fail_to_pass = probe.failToPass;

  const baseline = verification.parent_tests as TestRun;
  const targetTests = verification.target_tests as TestRun;
  if (baseline.parsed && targetTests.parsed) {
    const baselineFailing = new Set(failingTestIds(baseline));
    const targetFailing = new Set(failingTestIds(targetTests));
    verification.preexisting_failures = [...baselineFailing].filter((id) => targetFailing.has(id));
    const baselinePassing = new Set(passingTestIds(baseline));
    verification.pass_to_pass = passingTestIds(targetTests).filter((id) => baselinePassing.has(id));
  } else {
    // No parsed report: only the suite-level verdict is trustworthy. Saying so is better than
    // fabricating per-test sets.
    verification.preexisting_failures = [];
    verification.pass_to_pass = [];
  }

  // True when no dependency delta needs resolving at all. `offline_store` never reaches here.
  verification.offline_store_ready = dependencyChanges.length === 0;
  verification.ok = true;

  return {
    recipe,
    recipeHash: runtimeKey,
    verification,
    solveImageRef,
    changedTestPaths,
  };
}

async function runInstall(
  container: SandboxContainer,
  recipe: Recipe,
  timeoutMs: number,
  input: PrepareInput,
  label: string,
): Promise<{ ok: boolean; record: EnvironmentVerification["parent_install"] }> {
  if (recipe.installCommands.length === 0) {
    const noop = await container.exec(["true"], { cwd: recipe.workdir, timeoutMs: 30_000 });
    return { ok: true, record: await recordCommand(`${label} (no dependency manifest)`, noop, input.artifacts) };
  }
  const script = recipe.installCommands.join(" && ");
  const result = await container.exec(["sh", "-c", script], {
    cwd: recipe.workdir,
    timeoutMs,
    env: recipe.env,
    maxOutputBytes: 8 * 1024 * 1024,
    signal: input.signal,
  });
  return { ok: result.exitCode === 0, record: await recordCommand(label, result, input.artifacts) };
}

/** Test files the target commit touched. These become the hidden test set. */
async function collectChangedTestPaths(
  repo: AcquiredRepo,
  identity: CandidateIdentity,
  recipe: Recipe,
): Promise<string[]> {
  const entries = await repo.git.diffEntries(identity.parent_sha, identity.target_sha, 50);
  const isTest =
    recipe.ecosystem === "python"
      ? (p: string) => /(^|\/)tests?\//.test(p) || /(^|\/)test_[^/]*\.py$/.test(p) || /[^/]*_test\.py$/.test(p)
      : (p: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)(__tests__|test|tests)\//.test(p);
  return entries
    .filter((e) => e.status !== "deleted" && isTest(e.path))
    .map((e) => e.path)
    .sort();
}

interface ProbeArgs {
  input: PrepareInput;
  recipe: Recipe;
  solveImageRef: string;
  commonContainerOptions: Omit<CreateContainerOptions, "network">;
  timeouts: { provision: number; command: number; task: number };
  changedTestPaths: string[];
}

/**
 * Run the target's test files against the parent's source.
 *
 * Tests that fail here and pass in the target's own suite are the fail-to-pass evidence: they
 * demonstrate the behaviour the task is about. A failure caused by installation rather than
 * behaviour is not counted, because the container is already provisioned before the probe runs.
 */
async function runFailToPassProbe(args: ProbeArgs): Promise<{ failToPass: string[] }> {
  const { input, recipe, solveImageRef, timeouts, changedTestPaths } = args;
  if (changedTestPaths.length === 0) return { failToPass: [] };

  const container = await input.backend.createContainer({
    ...args.commonContainerOptions,
    imageRef: solveImageRef,
    network: false,
    label: SOLVE_LABEL,
  });
  try {
    const files = new Map<string, Uint8Array>();
    for (const path of changedTestPaths) {
      const content = await input.repo.git.showFile(input.identity.target_sha, path);
      if (content) files.set(path, content);
    }
    await writeFiles(container, recipe.workdir, files, timeouts.command);

    const run = await runTests({
      container,
      recipe,
      workdir: recipe.workdir,
      timeoutMs: timeouts.task,
      artifacts: input.artifacts,
      label: "fail_to_pass_probe",
      selection: recipe.testSelectionCommand ? changedTestPaths : undefined,
      signal: input.signal,
    });

    if (!run.parsed) {
      // Suite-level only: a non-zero exit with the target tests in place is still real evidence
      // that the parent source does not satisfy them, but no per-test ids can be claimed.
      return { failToPass: run.command.exit_code === 0 ? [] : ["suite::"] };
    }

    // A module the parent cannot even collect reports a MODULE id, not a test id, so it can never
    // be matched against the per-test ids of a later passing run. It becomes a file-level
    // requirement instead: every test in that module must pass, and at least one must run.
    const collectionErrors = new Set(run.collection_errors);
    const requirements: string[] = [];
    for (const moduleName of collectionErrors) {
      const path = moduleToPath(moduleName, changedTestPaths);
      if (path) {
        requirements.push(`file::${path}`);
      } else {
        // The module could not be mapped to a file that was actually written. Claiming a
        // requirement for it would be guessing, so the evidence is recorded as suite-level.
        requirements.push("suite::");
      }
    }
    for (const id of failingTestIds(run)) {
      if (collectionErrors.has(id)) continue;
      requirements.push(`test::${id}`);
    }
    return { failToPass: [...new Set(requirements)] };
  } finally {
    await container.destroy();
  }
}

export function buildHiddenTestSet(
  repo: AcquiredRepo,
  identity: CandidateIdentity,
  paths: readonly string[],
): Promise<Map<string, Uint8Array>> {
  return (async () => {
    const files = new Map<string, Uint8Array>();
    for (const path of paths) {
      const content = await repo.git.showFile(identity.target_sha, path);
      if (content) files.set(path, Buffer.from(content));
    }
    return files;
  })();
}
