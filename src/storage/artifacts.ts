import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { hashBytes, sha256Hex } from "../util/hash.ts";

/**
 * Content-addressed artifact store.
 *
 * Large payloads (full tool outputs, test logs, patches, snapshots) never live inside the
 * dataset records: records reference `sha256:<hex>` and the bytes live here. Truncated tool
 * results in a trajectory always carry the artifact hash of the untruncated payload.
 */
export class ArtifactStore {
  readonly root: string;

  constructor(workspaceDir: string) {
    this.root = join(workspaceDir, "artifacts");
  }

  private pathFor(hash: string): string {
    const hex = hash.startsWith("sha256:") ? hash.slice("sha256:".length) : hash;
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`not a sha256 artifact id: ${hash}`);
    return join(this.root, hex.slice(0, 2), hex.slice(2, 4), hex);
  }

  async put(data: Uint8Array | string): Promise<string> {
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
    const hash = hashBytes(bytes);
    const path = this.pathFor(hash);
    try {
      await stat(path);
      return hash; // already stored; content-addressed so contents are identical
    } catch {
      /* not present yet */
    }
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, bytes);
    return hash;
  }

  async putJson(value: unknown): Promise<string> {
    return this.put(JSON.stringify(value, null, 2));
  }

  async get(hash: string): Promise<Buffer> {
    return readFile(this.pathFor(hash));
  }

  async getText(hash: string): Promise<string> {
    return (await this.get(hash)).toString("utf8");
  }

  async getJson<T = unknown>(hash: string): Promise<T> {
    return JSON.parse(await this.getText(hash)) as T;
  }

  async has(hash: string): Promise<boolean> {
    try {
      await stat(this.pathFor(hash));
      return true;
    } catch {
      return false;
    }
  }

  /** Absolute path, for tooling that needs a real file (e.g. `docker build -f`). */
  resolve(hash: string): string {
    return this.pathFor(hash);
  }

  static hashOf(data: Uint8Array | string): string {
    return `sha256:${sha256Hex(typeof data === "string" ? data : Buffer.from(data))}`;
  }
}
