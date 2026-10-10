import { Git } from "../sources/git.ts";
import { createSandboxBackend } from "../sandbox/index.ts";
import { PiHarness } from "../harness/pi.ts";
import { modelForRole, type ForgeConfig, type ModelRole } from "../config/schema.ts";
import { createLogger } from "../util/logger.ts";
import { promptFingerprints } from "../prompts.ts";
import { PI_PACKAGE_VERSION } from "../harness/pi.ts";

/**
 * Environment check.
 *
 * `doctor` never reports a capability it has not exercised: it runs a real container, resolves a
 * real model, and prints exactly what it found. Anything it cannot verify is reported as PENDING,
 * not assumed to work.
 */

export type CheckStatus = "ok" | "warn" | "fail" | "pending";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  /** Extra lines printed underneath, such as isolation caveats. */
  notes?: string[];
}

export interface DoctorReport {
  checks: Check[];
  ok: boolean;
  /** Stages that cannot run in this environment, with the reason. */
  blocked: string[];
}

export async function runDoctor(config: ForgeConfig | null): Promise<DoctorReport> {
  const checks: Check[] = [];
  const blocked: string[] = [];

  // ---- runtime ------------------------------------------------------------
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  checks.push({
    name: "node runtime",
    status: major >= 22 ? "ok" : "fail",
    detail: `node ${process.version} on ${process.platform}/${process.arch}` +
      (major >= 22 ? "" : " — the pi SDK requires node >= 22.19.0"),
  });

  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE probe (x TEXT)");
    db.close();
    checks.push({ name: "sqlite", status: "ok", detail: "node:sqlite available" });
  } catch (error) {
    checks.push({ name: "sqlite", status: "fail", detail: `node:sqlite unavailable: ${(error as Error).message}` });
    blocked.push("everything: the workspace database cannot be opened");
  }

  // ---- git ----------------------------------------------------------------
  const gitVersion = await Git.version();
  checks.push({
    name: "git",
    status: gitVersion ? "ok" : "fail",
    detail: gitVersion ?? "git is not on PATH",
  });
  if (!gitVersion) blocked.push("mine, prepare, verify: git is required");

  // ---- prompts ------------------------------------------------------------
  try {
    const prompts = promptFingerprints();
    checks.push({
      name: "prompts",
      status: "ok",
      detail: Object.entries(prompts)
        .map(([role, p]) => `${role}@${p.version}`)
        .join(", "),
    });
  } catch (error) {
    checks.push({ name: "prompts", status: "fail", detail: (error as Error).message });
    blocked.push("grade, generate, solve: a prompt file is missing");
  }

  if (!config) {
    checks.push({
      name: "configuration",
      status: "pending",
      detail: "no --config given; container and model checks were skipped",
    });
    return { checks, ok: checks.every((c) => c.status !== "fail"), blocked };
  }

  // ---- sandbox ------------------------------------------------------------
  const logger = createLogger("doctor");
  const backend = createSandboxBackend(config.sandbox, logger);
  const availability = await backend.available();
  checks.push({
    name: `sandbox (${backend.name})`,
    status: availability.ok ? (backend.name === "local" ? "warn" : "ok") : "fail",
    detail: availability.detail,
    notes: backend.isolationNotes(),
  });
  if (!availability.ok) {
    blocked.push(`prepare, solve, verify, replay: the ${backend.name} backend cannot run containers`);
  }

  // ---- model providers ----------------------------------------------------
  const harness = new PiHarness({ logger: logger.child("pi"), agentDir: config.model.agent_dir });
  checks.push({ name: "pi package", status: "ok", detail: `@earendil-works/pi-coding-agent ${PI_PACKAGE_VERSION}` });

  const roles: ModelRole[] = ["grader", "taskgen", "taskreview", "solver", "user_simulator", "judge", "policy"];
  const seen = new Map<string, { ok: boolean; detail: string; roles: string[] }>();
  for (const role of roles) {
    const model = modelForRole(config, role);
    const key = `${model.provider}/${model.model}`;
    const existing = seen.get(key);
    if (existing) {
      existing.roles.push(role);
      continue;
    }
    const result = await harness.available(model);
    seen.set(key, { ...result, roles: [role] });
  }
  for (const [key, result] of seen) {
    checks.push({
      name: `model ${key}`,
      status: result.ok ? "ok" : "pending",
      detail: `${result.detail} — used by: ${result.roles.join(", ")}`,
    });
    if (!result.ok) {
      blocked.push(`${result.roles.join(", ")}: no usable credential or model for ${key}`);
    }
  }

  // ---- limits -------------------------------------------------------------
  checks.push({
    name: "budgets",
    status: "ok",
    detail:
      `tokens <= ${config.budgets.max_total_tokens}, cost <= $${config.budgets.max_total_cost_usd}, ` +
      `parallel tasks = ${config.budgets.max_parallel_tasks}, ` +
      `task timeout = ${config.sandbox.task_timeout_seconds}s`,
    notes: [
      "The cost limit only constrains calls whose model has a published price. Calls with an " +
        "unknown price are counted and reported, never charged against a guessed number.",
    ],
  });

  checks.push({
    name: "supported ecosystems",
    status: "ok",
    detail: "python (pytest) and javascript/typescript with a declared test command",
    notes: [
      "Other ecosystems are not supported by the MVP. A repository that matches none of them is " +
        "rejected with cause `env_recipe_undetected` rather than being processed on a guess.",
    ],
  });

  return { checks, ok: checks.every((c) => c.status !== "fail"), blocked };
}

export function formatDoctor(report: DoctorReport): string {
  const icon: Record<CheckStatus, string> = {
    ok: "ok",
    warn: "warn",
    fail: "FAIL",
    pending: "PENDING",
  };
  const lines: string[] = ["", "commit-trace-forge doctor", ""];
  for (const check of report.checks) {
    lines.push(`[${icon[check.status].padStart(7)}] ${check.name}`);
    lines.push(`           ${check.detail}`);
    for (const note of check.notes ?? []) lines.push(`           - ${note}`);
    lines.push("");
  }
  if (report.blocked.length > 0) {
    lines.push("Stages that cannot run here:");
    for (const item of report.blocked) lines.push(`  - ${item}`);
    lines.push("");
    lines.push("These stages are PENDING, not broken. The pipeline will refuse to report success");
    lines.push("for work it could not actually execute.");
    lines.push("");
  }
  return lines.join("\n");
}
