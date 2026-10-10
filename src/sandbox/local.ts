import { Buffer } from "node:buffer";
import { mkdtemp, rm, mkdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../util/exec.ts";
import { parseTar, createTar, type TarEntry } from "../util/tar.ts";
import { readdir, readFile, stat, writeFile, symlink, readlink, chmod } from "node:fs/promises";
import type { Logger } from "../util/logger.ts";
import type {
  BuiltImage,
  CreateContainerOptions,
  ImageBuildSpec,
  SandboxAvailability,
  SandboxBackend,
  SandboxContainer,
  SandboxExecOptions,
  SandboxExecResult,
} from "./types.ts";

/**
 * Fallback backend that runs commands as ordinary subprocesses in a temporary directory.
 *
 * It provides NO isolation: no user separation, no resource limits, no network policy. It exists
 * so the pipeline can be exercised on a machine without a container runtime. `forge doctor`
 * reports this loudly, every produced sample records `sandbox_backend: "local"`, and running an
 * untrusted repository through it executes that repository's code on the host with the caller's
 * privileges.
 */
export class LocalBackend implements SandboxBackend {
  readonly name = "local";
  private readonly logger: Logger;
  private readonly roots = new Set<string>();
  /** tag -> directory snapshot produced by commitContainer(). */
  private readonly images = new Map<string, string>();

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async available(): Promise<SandboxAvailability> {
    const probe = await exec([process.execPath, "-e", "process.exit(0)"], { timeoutMs: 30_000 });
    return {
      ok: probe.exitCode === 0,
      version: process.version,
      detail: "local subprocess backend (NO isolation)",
    };
  }

  async buildImage(spec: ImageBuildSpec): Promise<BuiltImage> {
    // There is no image to build. Setup commands run per container in the workspace instead,
    // so that the "image" carries no state between tasks.
    this.logger.warn("local backend: no image is built; setup commands run per container", { tag: spec.tag });
    return {
      imageRef: `local:${spec.tag}`,
      digest: null,
      baseImageDigest: null,
      buildLog: `local backend: image build skipped. setup commands deferred:\n${spec.setupCommands.join("\n")}`,
    };
  }

  async createContainer(options: CreateContainerOptions): Promise<SandboxContainer> {
    const root = await mkdtemp(join(tmpdir(), "forge-local-"));
    this.roots.add(root);
    // A committed "image" is a directory snapshot; restore it so a fresh container starts from
    // the provisioned state, matching the docker backend's semantics.
    const snapshot = this.images.get(options.imageRef);
    if (snapshot) await cp(snapshot, root, { recursive: true });
    const workdir = join(root, options.workdir.replace(/^\/+/, ""));
    await mkdir(workdir, { recursive: true });
    return new LocalContainer(root, workdir, options, () => this.roots.delete(root));
  }

  async commitContainer(container: SandboxContainer, tag: string): Promise<BuiltImage> {
    const source = (container as LocalContainer).rootDir;
    const target = await mkdtemp(join(tmpdir(), "forge-local-image-"));
    await cp(source, target, { recursive: true });
    this.images.set(tag, target);
    return {
      imageRef: tag,
      digest: null,
      baseImageDigest: null,
      buildLog: `local backend: directory snapshot of ${container.id} stored for ${tag}`,
    };
  }

  async removeImage(ref: string): Promise<void> {
    const dir = this.images.get(ref);
    if (!dir) return;
    this.images.delete(ref);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  async listImages(prefixes: readonly string[]): Promise<string[]> {
    return [...this.images.keys()].filter((ref) => prefixes.some((prefix) => ref.startsWith(prefix)));
  }

  async cleanup(): Promise<number> {
    let count = 0;
    for (const root of [...this.roots]) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
      this.roots.delete(root);
      count++;
    }
    for (const [tag, dir] of [...this.images]) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      this.images.delete(tag);
    }
    return count;
  }

  isolationNotes(): string[] {
    return [
      "NO ISOLATION. Commands run as ordinary subprocesses with the privileges of the forge process.",
      "No user separation, no CPU/memory/PID limits, no network policy: `network_during_solve: false` is NOT enforced.",
      "Only use this backend with repositories and commits you already trust. It exists to exercise the pipeline " +
        "on machines without a container runtime.",
    ];
  }
}

class LocalContainer implements SandboxContainer {
  readonly id: string;
  /** @internal used by LocalBackend.commitContainer */
  readonly rootDir: string;
  readonly imageRef: string;
  readonly networkDisabled = false;
  private readonly root: string;
  private readonly workdir: string;
  private readonly env: Record<string, string>;
  private readonly onDestroy: () => void;
  private destroyed = false;

  constructor(root: string, workdir: string, options: CreateContainerOptions, onDestroy: () => void) {
    this.root = root;
    this.rootDir = root;
    this.workdir = workdir;
    this.id = `local-${root.slice(-12)}`;
    this.imageRef = options.imageRef;
    this.env = { ...options.env };
    this.onDestroy = onDestroy;
  }

  private resolveInside(path: string): string {
    return path.startsWith("/") ? join(this.root, path.replace(/^\/+/, "")) : join(this.workdir, path);
  }

  async exec(argv: readonly string[], options: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    if (this.destroyed) throw new Error(`container ${this.id} was destroyed`);
    const result = await exec(argv, {
      cwd: options.cwd ? this.resolveInside(options.cwd) : this.workdir,
      env: { ...process.env, ...this.env, ...options.env },
      timeoutMs: options.timeoutMs ?? 300_000,
      stdin: options.stdin,
      maxOutputBytes: options.maxOutputBytes,
      signal: options.signal,
    }).catch((error: Error) => ({
      command: [...argv],
      cwd: this.workdir,
      exitCode: 127,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(String(error.message), "utf8"),
      durationMs: 0,
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    }));
    return {
      argv: [...argv],
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    };
  }

  async putArchive(archive: Uint8Array, destDir: string): Promise<void> {
    const base = this.resolveInside(destDir);
    await mkdir(base, { recursive: true });
    for (const entry of parseTar(archive)) {
      const target = join(base, entry.path);
      if (entry.type === "directory") {
        await mkdir(target, { recursive: true });
      } else if (entry.type === "symlink") {
        await mkdir(join(target, ".."), { recursive: true });
        await symlink(entry.linkname ?? "", target).catch(() => undefined);
      } else {
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, Buffer.from(entry.data));
        await chmod(target, entry.mode & 0o7777).catch(() => undefined);
      }
    }
  }

  async getArchive(srcPath: string): Promise<Buffer> {
    const base = this.resolveInside(srcPath.replace(/\/\.$/, ""));
    const entries: TarEntry[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const name of (await readdir(dir)).sort()) {
        const full = join(dir, name);
        const rel = prefix ? `${prefix}/${name}` : name;
        const info = await stat(full).catch(() => null);
        const link = await readlink(full).catch(() => null);
        if (link !== null) {
          entries.push({ path: rel, mode: 0o120777, type: "symlink", data: Buffer.alloc(0), linkname: link });
        } else if (info?.isDirectory()) {
          entries.push({ path: `${rel}/`, mode: 0o755, type: "directory", data: Buffer.alloc(0) });
          await walk(full, rel);
        } else if (info?.isFile()) {
          entries.push({ path: rel, mode: info.mode & 0o7777, type: "file", data: await readFile(full) });
        }
      }
    };
    await walk(base, "");
    return createTar(entries);
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.onDestroy();
    await rm(this.root, { recursive: true, force: true }).catch(() => undefined);
  }
}
