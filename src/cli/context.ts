import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { loadConfig, type LoadedConfig } from "../config/load.ts";
import { ForgeDb } from "../storage/db.ts";
import { Store } from "../storage/state.ts";
import { ArtifactStore } from "../storage/artifacts.ts";
import { createSandboxBackend } from "../sandbox/index.ts";
import { PiHarness, PiModelProvider } from "../harness/pi.ts";
import { createLogger, type Logger } from "../util/logger.ts";
import { shortId } from "../util/hash.ts";
import type { PipelineContext } from "../pipeline.ts";

export interface CliContext extends PipelineContext {
  loaded: LoadedConfig;
  db: ForgeDb;
  close(): void;
}

export interface BuildContextOptions {
  configPath: string;
  /** Reuse this run id instead of creating a new one. */
  runId?: string;
  /** Continue the most recent run for this config. */
  resume?: boolean;
  /**
   * The command works on the results of an earlier run (judge, rollout, score, export, report,
   * replay). It never creates a run, and when the configuration changed since that run — a new
   * field, a different reward weight — it falls back to the latest run with accepted samples
   * instead of starting an empty one.
   */
  postRun?: boolean;
  offline?: boolean;
  logger?: Logger;
  signal?: AbortSignal;
}

export async function buildContext(options: BuildContextOptions): Promise<CliContext> {
  const loaded = await loadConfig(options.configPath);
  await mkdir(loaded.workspaceDir, { recursive: true });

  const logger = options.logger ?? createLogger("forge");
  const db = ForgeDb.open({ workspaceDir: loaded.workspaceDir });
  for (const override of loaded.envOverrides) logger.info("environment override", { override });

  let runId = options.runId;
  if (!runId && options.resume) {
    runId = Store.latestRunId(db, loaded.configHash);
    if (runId) logger.info("resuming run", { run: runId });
  }
  if (options.postRun && !options.runId && (!runId || !Store.hasAcceptedSamples(db, runId))) {
    const fallback = Store.latestRunWithSamples(db);
    if (fallback) {
      if (fallback !== runId) {
        logger.warn("no run with accepted samples matches this configuration exactly; using the latest one", {
          run: fallback,
        });
      }
      runId = fallback;
    }
  }
  if (options.postRun && (!runId || !Store.runExists(db, runId))) {
    db.close();
    throw new Error(
      `no completed run in ${loaded.workspaceDir}${options.runId ? ` with id ${options.runId}` : ""}; ` +
        "run `forge run --config <file>` first",
    );
  }
  if (!runId) {
    runId = shortId("run", { config: loaded.configHash, at: Date.now() });
  }

  // A post-run command reads a finished run; re-registering it would flip its status back to running.
  if (!options.postRun) Store.createRun(db, runId, loaded.configHash, loaded.config, String(loaded.config.seed));
  const store = new Store(db, runId);
  const artifacts = new ArtifactStore(loaded.workspaceDir);

  const backend = createSandboxBackend(loaded.config.sandbox, logger);
  const harness = new PiHarness({ logger: logger.child("pi"), agentDir: loaded.config.model.agent_dir });
  const provider = new PiModelProvider({ logger: logger.child("pi"), agentDir: loaded.config.model.agent_dir });

  return {
    loaded,
    config: loaded.config,
    workspaceDir: loaded.workspaceDir,
    configDir: dirname(loaded.path),
    db,
    store,
    artifacts,
    backend,
    harness,
    provider,
    logger,
    runId,
    signal: options.signal,
    offline: options.offline,
    close: () => db.close(),
  };
}
