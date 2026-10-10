import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "./util/hash.ts";
import { PROMPT_VERSIONS, type PromptRole } from "./storage/versions.ts";

/**
 * Versioned prompts, one directory per role.
 *
 * The version and the content hash of the loaded prompt both feed the stage input hash, so
 * editing a prompt invalidates exactly the cached artifacts that depended on it.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface LoadedPrompt {
  role: PromptRole;
  version: string;
  text: string;
  hash: string;
  path: string;
}

const cache = new Map<string, LoadedPrompt>();

export function loadPrompt(role: PromptRole, version = PROMPT_VERSIONS[role]): LoadedPrompt {
  const key = `${role}/${version}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const path = join(ROOT, "prompts", role, `${version}.md`);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`cannot load prompt ${key} from ${path}: ${(error as Error).message}`);
  }
  const loaded: LoadedPrompt = { role, version, text: text.trim(), hash: `sha256:${sha256Hex(text)}`, path };
  cache.set(key, loaded);
  return loaded;
}

/** Identity of every prompt in use, for the run manifest and for cache keys. */
export function promptFingerprints(): Record<string, { version: string; hash: string }> {
  const out: Record<string, { version: string; hash: string }> = {};
  for (const role of Object.keys(PROMPT_VERSIONS) as PromptRole[]) {
    const prompt = loadPrompt(role);
    out[role] = { version: prompt.version, hash: prompt.hash };
  }
  return out;
}
