import { createHash } from "node:crypto";

/**
 * Canonical JSON: object keys sorted recursively, no insignificant whitespace.
 * Used for every cache key and content-address so that hashes are stable across runs
 * and across machines.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError(`non-finite number cannot be canonicalized: ${String(value)}`);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Date) return value.toISOString();
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Content address of an arbitrary structure. Prefixed so it is never confused with a git sha. */
export function hashObject(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

export function hashBytes(data: Uint8Array): string {
  return `sha256:${sha256Hex(data)}`;
}

/**
 * A cache key is a hash over an ordered list of labelled inputs. Labels are part of the
 * hash so that reordering or renaming an input invalidates the key.
 */
export function cacheKey(kind: string, inputs: Record<string, unknown>): string {
  return `${kind}:${sha256Hex(canonicalJson({ kind, inputs })).slice(0, 32)}`;
}

/** Short, human-readable but collision-resistant id derived from content. */
export function shortId(prefix: string, value: unknown): string {
  return `${prefix}_${sha256Hex(canonicalJson(value)).slice(0, 16)}`;
}
