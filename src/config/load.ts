import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { CONFIG_SCHEMA_VERSION, ForgeConfig } from "./schema.ts";
import { hashObject } from "../util/hash.ts";

export interface LoadedConfig {
  config: ForgeConfig;
  /** Absolute path of the config file. */
  path: string;
  /** Absolute workspace directory (SQLite + artifacts + manifests). */
  workspaceDir: string;
  /** Content address of the *validated* config, used as part of every cache key. */
  configHash: string;
  /** The raw parsed YAML, kept for the run manifest. */
  raw: unknown;
  /** Environment overrides that were applied, for logs and the run manifest. */
  envOverrides: string[];
}

export async function loadConfig(configPath: string): Promise<LoadedConfig> {
  const absolute = resolve(configPath);
  let text: string;
  try {
    text = await readFile(absolute, "utf8");
  } catch (error) {
    throw new Error(`cannot read config at ${absolute}: ${(error as Error).message}`);
  }

  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (error) {
    throw new Error(`invalid YAML in ${absolute}: ${(error as Error).message}`);
  }

  if (raw === null || typeof raw !== "object") {
    throw new Error(`config ${absolute} must be a YAML mapping`);
  }

  const declared = (raw as Record<string, unknown>).schema_version;
  if (declared !== CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `config ${absolute}: schema_version must be ${CONFIG_SCHEMA_VERSION}, got ${JSON.stringify(declared)}`,
    );
  }

  const parsed = ForgeConfig.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid config ${absolute}:\n${formatIssues(parsed.error)}`);
  }

  const config = parsed.data;
  const envOverrides = applyEnvironmentOverrides(config, process.env);
  const workspaceDir = isAbsolute(config.workspace)
    ? config.workspace
    : resolve(dirname(absolute), config.workspace);

  return {
    config,
    path: absolute,
    workspaceDir,
    configHash: hashObject(config),
    raw,
    envOverrides,
  };
}

/**
 * Host-specific settings that should not live in a shared config file.
 *
 *   FORGE_DOCKER_COMMAND  argv prefix for the container CLI, e.g. "wsl -d Ubuntu -e docker"
 *   FORGE_MODEL           "provider/model" for every role without an explicit per-role override
 *
 * Applied before the config is hashed, so a different model is a different run identity.
 */
export function applyEnvironmentOverrides(config: ForgeConfig, env: NodeJS.ProcessEnv): string[] {
  const applied: string[] = [];
  const docker = env.FORGE_DOCKER_COMMAND?.trim();
  if (docker) {
    config.sandbox.docker_command = docker.split(/\s+/);
    applied.push(`FORGE_DOCKER_COMMAND=${docker}`);
  }
  const model = env.FORGE_MODEL?.trim();
  if (model) {
    const slash = model.indexOf("/");
    if (slash <= 0 || slash === model.length - 1) {
      throw new Error(`FORGE_MODEL must look like "provider/model", got "${model}"`);
    }
    config.model.provider = model.slice(0, slash);
    config.model.model = model.slice(slash + 1);
    applied.push(`FORGE_MODEL=${model}`);
  }
  return applied;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.length ? issue.path.join(".") : "<root>"}: ${issue.message}`)
    .join("\n");
}

/** Validate an in-memory object (used by tests and by `forge init` self-check). */
export function validateConfig(value: unknown): ForgeConfig {
  const parsed = ForgeConfig.safeParse(value);
  if (!parsed.success) throw new Error(`invalid config:\n${formatIssues(parsed.error)}`);
  return parsed.data;
}
