import { Buffer } from "node:buffer";
import type { SandboxBackend, CreateContainerOptions } from "../sandbox/types.ts";
import type { ArtifactStore } from "../storage/artifacts.ts";
import type { Git } from "../sources/git.ts";
import type { BehavioralChecks, CandidateIdentity, EnvironmentVerification, TaskSpec, TestRun } from "../types/index.ts";
import type { Recipe } from "../environments/recipe.ts";
import { failingTestIds, passingTestIds, runTests, writeFiles } from "../environments/run.ts";
import { restoreWorkspace } from "../environments/workspace.ts";
import { parseTar } from "../util/tar.ts";

/**
 * Functional equivalence.
 *
 * Runs in a container the solver never touched, over a COPY of the solver's result. The hidden
 * tests — the test files as they exist at the target commit — are written in after the copy is in
 * place, so a solver that deleted or weakened a visible test cannot escape evaluation.
 *
 * A passing result is labelled `behaviorally_verified`. That is a claim about the checks that ran,
 * not a claim of universal equivalence and not a claim of exact reconstruction.
 */

export interface BehavioralInput {
  identity: CandidateIdentity;
  task: TaskSpec;
  environment: EnvironmentVerification;
  recipe: Recipe;
  backend: SandboxBackend;
  containerOptions: Omit<CreateContainerOptions, "network">;
  /** Tar of the solver's workspace, extracted from the solve container. */
  solutionArchive: Uint8Array;
  /** Tree hash of the solution, already computed inside the solve container. */
  solutionTreeSha: string;
  hiddenTestPaths: readonly string[];
  git: Git;
  artifacts: ArtifactStore;
  timeoutMs: number;
  requireFailToPass: boolean;
  networkDuringVerify: boolean;
  /** uid:gid the workspace is handed to after the archive is unpacked. */
  runAs: string;
  signal?: AbortSignal;
}

export async function runBehavioralChecks(input: BehavioralInput): Promise<BehavioralChecks> {
  const checks: BehavioralChecks = {
    fail_to_pass_run: null,
    pass_to_pass_run: null,
    fail_to_pass_satisfied: [],
    fail_to_pass_missing: [],
    regressions: [],
    structural_checks: [],
    visible_tests_tampered: false,
    tampered_paths: [],
    passed: false,
  };

  // ---- tamper detection ---------------------------------------------------
  // Compare the solver's copy of each hidden test path against the parent's version. A change
  // here does not by itself fail the sample, because the hidden copy is restored anyway, but a
  // solver that removed a test must not be able to hide it.
  const tampered: string[] = [];
  for (const path of input.hiddenTestPaths) {
    const parentContent = await input.git.showFile(input.identity.parent_sha, path);
    if (!parentContent) continue; // the target added this test; the solver had nothing to tamper with
    const solverContent = findInArchive(input.solutionArchive, path);
    if (solverContent === null) {
      tampered.push(`${path} (deleted)`);
    } else if (!Buffer.from(solverContent).equals(Buffer.from(parentContent))) {
      tampered.push(`${path} (modified)`);
    }
  }
  checks.visible_tests_tampered = tampered.length > 0;
  checks.tampered_paths = tampered;

  const container = await input.backend.createContainer({
    ...input.containerOptions,
    network: input.networkDuringVerify,
    label: "verify",
  });
  try {
    // The solution arrives as a tar carrying its own repository. Restoring it into an emptied
    // workdir and recomputing the tree confirms the copy under test really is the solver's result,
    // rather than trusting the hash the solve container reported.
    const restored = await restoreWorkspace(container, input.solutionArchive, {
      workdir: input.recipe.workdir,
      expectedTreeSha: input.solutionTreeSha,
      timeoutMs: input.timeoutMs,
      owner: input.runAs,
    });
    if (!restored.fidelityOk) {
      throw new Error(
        `the restored solution hashes to ${restored.treeSha}, but the solve container reported ` +
          `${input.solutionTreeSha}; behavioural checks would not be measuring the solver's result`,
      );
    }

    // Restore the hidden tests over whatever the solver left behind.
    const hidden = new Map<string, Uint8Array>();
    for (const path of input.hiddenTestPaths) {
      const content = await input.git.showFile(input.identity.target_sha, path);
      if (content) hidden.set(path, content);
    }
    if (hidden.size > 0) await writeFiles(container, input.recipe.workdir, hidden, input.timeoutMs);

    // ---- fail-to-pass ------------------------------------------------------
    // Requirements arrive prefixed. `test::` names an individual test; `file::` names a module
    // the parent could not collect, so the whole module must pass; `suite::` means only a
    // suite-level verdict was ever available.
    const requirements = input.environment.fail_to_pass;
    const needsSelection = requirements.some((r) => r.startsWith("test::") || r.startsWith("file::"));

    if (requirements.length > 0) {
      const run = await runTests({
        container,
        recipe: input.recipe,
        workdir: input.recipe.workdir,
        timeoutMs: input.timeoutMs,
        artifacts: input.artifacts,
        label: "solution_fail_to_pass",
        selection:
          needsSelection && input.recipe.testSelectionCommand && input.hiddenTestPaths.length > 0
            ? input.hiddenTestPaths
            : undefined,
        signal: input.signal,
      });
      checks.fail_to_pass_run = run;

      const verdict = evaluateRequirements(requirements, run);
      checks.fail_to_pass_satisfied = verdict.satisfied;
      checks.fail_to_pass_missing = verdict.missing;
    }

    // ---- regressions -------------------------------------------------------
    const full = await runTests({
      container,
      recipe: input.recipe,
      workdir: input.recipe.workdir,
      timeoutMs: input.timeoutMs,
      artifacts: input.artifacts,
      label: "solution_full_suite",
      signal: input.signal,
    });
    checks.pass_to_pass_run = full;

    if (full.parsed) {
      const nowFailing = new Set(failingTestIds(full));
      const preexisting = new Set(input.environment.preexisting_failures);
      checks.regressions = input.environment.pass_to_pass.filter((id) => nowFailing.has(id) && !preexisting.has(id));
    } else if (full.command.exit_code !== 0) {
      checks.regressions = ["<suite> the full suite does not pass with the solution in place"];
    }

    // ---- refactor structural objective -------------------------------------
    if (input.task.task_type === "refactor") {
      // A refactor has no fail-to-pass evidence by construction. Its objective is that behaviour
      // is preserved (the full suite stays green) and that the structural goal was met at all,
      // which is checked as "the solution is not byte-identical to the parent".
      checks.structural_checks.push({
        name: "behaviour_preserved",
        passed: full.command.exit_code === 0 && (!full.parsed || full.totals.failed + full.totals.errored === 0),
        detail: `full suite exit ${full.command.exit_code}, ${full.totals.failed} failed / ${full.totals.errored} errored`,
      });
      checks.structural_checks.push({
        name: "workspace_changed",
        passed: input.solutionTreeSha !== input.identity.parent_tree_sha,
        detail:
          input.solutionTreeSha === input.identity.parent_tree_sha
            ? "the solution is identical to the parent state: nothing was refactored"
            : `solution tree ${input.solutionTreeSha.slice(0, 12)} differs from the parent tree`,
      });
    }
  } finally {
    await container.destroy();
  }

  checks.passed = decide(checks, input);
  return checks;
}

function decide(checks: BehavioralChecks, input: BehavioralInput): boolean {
  if (checks.regressions.length > 0) return false;
  if (checks.structural_checks.some((c) => !c.passed)) return false;

  if (input.task.task_type === "refactor") {
    // Refactors are not required to produce a fail-to-pass test; demanding one would be
    // manufacturing evidence that the change was never meant to provide.
    return checks.structural_checks.length > 0 && checks.structural_checks.every((c) => c.passed);
  }

  if (!input.requireFailToPass) {
    return checks.pass_to_pass_run?.command.exit_code === 0;
  }

  if (checks.fail_to_pass_run === null) return false;
  if (checks.fail_to_pass_missing.length > 0) return false;
  return checks.fail_to_pass_satisfied.length > 0;
}

/**
 * Decide which fail-to-pass requirements the solution satisfies.
 *
 * A `file::` requirement is satisfied only when the module actually ran: at least one test from
 * it passed and none failed. A module that still fails to collect reports zero passes, so it
 * cannot be mistaken for success.
 */
function evaluateRequirements(
  requirements: readonly string[],
  run: TestRun,
): { satisfied: string[]; missing: string[] } {
  const satisfied: string[] = [];
  const missing: string[] = [];

  const passing = new Set(passingTestIds(run));
  const failing = new Set(failingTestIds(run));

  for (const requirement of requirements) {
    if (requirement.startsWith("test::")) {
      const id = requirement.slice("test::".length);
      (passing.has(id) ? satisfied : missing).push(requirement);
      continue;
    }
    if (requirement.startsWith("file::")) {
      const path = requirement.slice("file::".length);
      if (!run.parsed) {
        // Without a parsed report there is no way to tell which module a result belongs to.
        (run.command.exit_code === 0 ? satisfied : missing).push(requirement);
        continue;
      }
      const fromFile = run.outcomes.filter((o) => belongsToFile(o.test_id, path));
      const passedHere = fromFile.filter((o) => o.status === "passed").length;
      const failedHere = fromFile.filter((o) => o.status === "failed" || o.status === "error").length;
      (passedHere > 0 && failedHere === 0 ? satisfied : missing).push(requirement);
      continue;
    }
    // suite::
    (run.command.exit_code === 0 && failing.size === 0 ? satisfied : missing).push(requirement);
  }

  return { satisfied, missing };
}

/** Does a test id come from this file? Handles both `path::test` ids and dotted module ids. */
function belongsToFile(testId: string, path: string): boolean {
  if (testId.startsWith(`${path}::`)) return true;
  const dotted = path.replace(/\.py$/, "").split("/").join(".");
  return testId === dotted || testId.startsWith(`${dotted}::`) || testId.startsWith(`${dotted}.`);
}

/** Read one path out of a tar archive. Returns null when it is absent. */
function findInArchive(archive: Uint8Array, path: string): Uint8Array | null {
  for (const entry of parseTar(archive)) {
    if (entry.type !== "file") continue;
    if (entry.path.replace(/^\.\//, "") === path) return entry.data;
  }
  return null;
}
