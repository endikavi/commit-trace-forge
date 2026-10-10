import { Buffer } from "node:buffer";
import { exec } from "../util/exec.ts";
import { createTar } from "../util/tar.ts";
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

export interface DockerBackendOptions {
  /**
   * Argv prefix that reaches the docker CLI. `["docker"]` on a normal host. On a Windows host
   * whose daemon lives inside WSL, `["wsl","-d","Ubuntu","-e","docker"]`.
   */
  command: readonly string[];
  logger: Logger;
  defaultTimeoutMs?: number;
}

const CONTAINER_LABEL_KEY = "commit-trace-forge";

/** Tiny image used only to prove the daemon can actually start a container. */
const PROBE_IMAGE = "busybox:stable";

export class DockerBackend implements SandboxBackend {
  readonly name = "docker";
  private readonly command: readonly string[];
  private readonly logger: Logger;
  private readonly defaultTimeoutMs: number;

  constructor(options: DockerBackendOptions) {
    this.command = options.command;
    this.logger = options.logger;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 600_000;
  }

  private argv(args: readonly string[]): string[] {
    return [...this.command, ...args];
  }

  private async docker(
    args: readonly string[],
    options: { timeoutMs?: number; stdin?: Uint8Array | string; maxOutputBytes?: number; signal?: AbortSignal } = {},
  ) {
    return exec(this.argv(args), {
      timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
      stdin: options.stdin,
      maxOutputBytes: options.maxOutputBytes,
      signal: options.signal,
      // The docker CLI is launched without a shell, so Windows path mangling never applies.
      env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
    });
  }

  async available(): Promise<SandboxAvailability> {
    try {
      const version = await this.docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 60_000 });
      if (version.exitCode !== 0) {
        return {
          ok: false,
          version: null,
          detail: `docker daemon not reachable via \`${this.command.join(" ")}\`: ${version.stderr.toString("utf8").trim().slice(0, 300)}`,
        };
      }
      const serverVersion = version.stdout.toString("utf8").trim();

      // A reachable daemon is not enough. A misconfigured storage driver answers `docker version`
      // happily and then fails to mount any container rootfs, so the only honest check is to run
      // a real container. Note: no empty-string argument is passed anywhere, because an empty
      // argv entry is mangled when the CLI is reached through `wsl -e`.
      const pull = await this.docker(["pull", "--quiet", PROBE_IMAGE], { timeoutMs: 300_000 });
      if (pull.exitCode !== 0) {
        return {
          ok: false,
          version: serverVersion,
          detail:
            `docker ${serverVersion} answers but cannot pull ${PROBE_IMAGE}: ` +
            (pull.stderr.toString("utf8").trim() || `exit ${pull.exitCode}`).slice(0, 400),
        };
      }
      const probe = await this.docker(["run", "--rm", "--network", "none", PROBE_IMAGE, "true"], {
        timeoutMs: 300_000,
      });
      if (probe.exitCode !== 0) {
        return {
          ok: false,
          version: serverVersion,
          detail:
            `docker ${serverVersion} answers but cannot run a container: ` +
            (probe.stderr.toString("utf8").trim() || `exit ${probe.exitCode}`).slice(0, 400),
        };
      }
      return { ok: true, version: serverVersion, detail: `docker server ${serverVersion}, container probe passed` };
    } catch (error) {
      return {
        ok: false,
        version: null,
        detail: `cannot execute \`${this.command.join(" ")}\`: ${(error as Error).message}`,
      };
    }
  }

  async buildImage(spec: ImageBuildSpec): Promise<BuiltImage> {
    const [uid, gid] = spec.runAs.split(":");
    const dockerfile = [
      `FROM ${spec.baseImage}`,
      // A dedicated non-root account owns the workdir. Task commands never run as root.
      `RUN (getent group ${gid} || groupadd -g ${gid} forge) >/dev/null 2>&1 || true`,
      `RUN (id -u ${uid} >/dev/null 2>&1 || useradd -m -u ${uid} -g ${gid} forge) || true`,
      ...Object.entries(spec.env).map(([k, v]) => `ENV ${k}=${JSON.stringify(v)}`),
      `RUN mkdir -p ${spec.workdir} && chown -R ${spec.runAs} ${spec.workdir}`,
      ...spec.setupCommands.map((cmd) => `RUN ${cmd}`),
      `WORKDIR ${spec.workdir}`,
    ].join("\n");

    this.logger.debug("building image", { tag: spec.tag, base: spec.baseImage });
    const context = createTar([
      { path: "Dockerfile", mode: 0o644, type: "file", data: Buffer.from(dockerfile, "utf8") },
    ]);

    const build = await this.docker(["build", "--quiet=false", "-t", spec.tag, "-"], {
      timeoutMs: spec.timeoutMs,
      stdin: context,
      maxOutputBytes: 16 * 1024 * 1024,
    });
    const buildLog = `$ docker build -t ${spec.tag} -\n--- Dockerfile ---\n${dockerfile}\n--- output ---\n${build.stdout.toString("utf8")}${build.stderr.toString("utf8")}`;
    if (build.exitCode !== 0) {
      const error = new Error(`docker build failed for ${spec.tag} (exit ${build.exitCode})`);
      (error as Error & { buildLog?: string }).buildLog = buildLog;
      throw error;
    }

    const digest = await this.imageId(spec.tag);
    const baseDigest = await this.imageId(spec.baseImage);
    return { imageRef: spec.tag, digest, baseImageDigest: baseDigest, buildLog };
  }

  private async imageId(ref: string): Promise<string | null> {
    const result = await this.docker(["image", "inspect", ref, "--format", "{{.Id}}"], { timeoutMs: 120_000 });
    if (result.exitCode !== 0) return null;
    const id = result.stdout.toString("utf8").trim();
    return id.length > 0 ? id : null;
  }

  async createContainer(options: CreateContainerOptions): Promise<SandboxContainer> {
    const args = [
      "create",
      "--label",
      `${CONTAINER_LABEL_KEY}=${options.label ?? "task"}`,
      "--workdir",
      options.workdir,
      // Resource limits.
      "--cpus",
      String(options.cpuLimit),
      "--memory",
      `${options.memoryMb}m`,
      "--memory-swap",
      `${options.memoryMb}m`,
      "--pids-limit",
      String(options.pidsLimit),
      // Privilege reduction. No capabilities, no privilege escalation, never --privileged.
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      // No host mounts at all: no docker socket, no host home, no shared writable caches.
      // Files move in and out over tar streams instead.
      "--network",
      options.network ? "bridge" : "none",
    ];
    if (options.user) args.push("--user", options.user);
    for (const [key, value] of Object.entries(options.env ?? {})) args.push("--env", `${key}=${value}`);
    args.push(options.imageRef, "sleep", "infinity");

    const created = await this.docker(args, { timeoutMs: 300_000 });
    if (created.exitCode !== 0) {
      throw new Error(`docker create failed: ${created.stderr.toString("utf8").trim().slice(0, 500)}`);
    }
    const id = created.stdout.toString("utf8").trim();

    const started = await this.docker(["start", id], { timeoutMs: 300_000 });
    if (started.exitCode !== 0) {
      await this.docker(["rm", "-f", id], { timeoutMs: 120_000 });
      throw new Error(`docker start failed: ${started.stderr.toString("utf8").trim().slice(0, 500)}`);
    }

    return new DockerContainer(this, id, options);
  }

  async commitContainer(container: SandboxContainer, tag: string): Promise<BuiltImage> {
    const result = await this.docker(["commit", container.id, tag], { timeoutMs: 900_000 });
    if (result.exitCode !== 0) {
      throw new Error(`docker commit failed: ${result.stderr.toString("utf8").trim().slice(0, 500)}`);
    }
    return {
      imageRef: tag,
      digest: await this.imageId(tag),
      baseImageDigest: await this.imageId(container.imageRef),
      buildLog: `$ docker commit ${container.id.slice(0, 12)} ${tag}\n${result.stdout.toString("utf8")}`,
    };
  }

  async removeImage(ref: string): Promise<void> {
    const result = await this.docker(["image", "rm", "-f", ref], { timeoutMs: 300_000 });
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString("utf8").trim();
      // An image that is already gone is the desired end state, not a failure.
      if (/No such image|not found/i.test(stderr)) return;
      throw new Error(`docker image rm ${ref} failed: ${stderr.slice(0, 300)}`);
    }
  }

  async listImages(prefixes: readonly string[]): Promise<string[]> {
    const result = await this.docker(["images", "--format", "{{.Repository}}:{{.Tag}}"], { timeoutMs: 300_000 });
    if (result.exitCode !== 0) return [];
    return result.stdout
      .toString("utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((ref) => ref.length > 0 && ref !== "<none>:<none>")
      .filter((ref) => prefixes.some((prefix) => ref.startsWith(prefix)));
  }

  async cleanup(label: string): Promise<number> {
    const list = await this.docker(
      ["ps", "-aq", "--filter", `label=${CONTAINER_LABEL_KEY}=${label}`],
      { timeoutMs: 120_000 },
    );
    if (list.exitCode !== 0) return 0;
    const ids = list.stdout.toString("utf8").split("\n").map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) return 0;
    await this.docker(["rm", "-f", ...ids], { timeoutMs: 300_000 });
    return ids.length;
  }

  isolationNotes(): string[] {
    return [
      "Containers run as a non-root uid:gid with all Linux capabilities dropped and no-new-privileges set.",
      "No host path, docker socket, credential file or shared writable cache is mounted; files move over tar streams.",
      "CPU, memory, swap and PID limits are applied; the solve phase runs with --network none by default.",
      "This is configured isolation, not a guarantee against hostile code: container escapes, kernel bugs and " +
        "resource-exhaustion attacks remain possible. Run untrusted repositories on a disposable host.",
    ];
  }

  /** @internal used by DockerContainer */
  invoke(
    args: readonly string[],
    options: { timeoutMs?: number; stdin?: Uint8Array | string; maxOutputBytes?: number; signal?: AbortSignal } = {},
  ) {
    return this.docker(args, options);
  }
}

class DockerContainer implements SandboxContainer {
  readonly id: string;
  readonly imageRef: string;
  readonly networkDisabled: boolean;
  private readonly backend: DockerBackend;
  private readonly defaultUser: string | undefined;
  private readonly defaultWorkdir: string;
  private destroyed = false;

  constructor(backend: DockerBackend, id: string, options: CreateContainerOptions) {
    this.backend = backend;
    this.id = id;
    this.imageRef = options.imageRef;
    this.networkDisabled = !options.network;
    this.defaultUser = options.user;
    this.defaultWorkdir = options.workdir;
  }

  async exec(argv: readonly string[], options: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    if (this.destroyed) throw new Error(`container ${this.id.slice(0, 12)} was destroyed`);
    const args = ["exec"];
    if (options.stdin !== undefined) args.push("-i");
    args.push("--workdir", options.cwd ?? this.defaultWorkdir);
    const user = options.user ?? this.defaultUser;
    if (user) args.push("--user", user);
    for (const [key, value] of Object.entries(options.env ?? {})) args.push("--env", `${key}=${value}`);
    args.push(this.id, ...argv);

    const result = await this.backend.invoke(args, {
      timeoutMs: options.timeoutMs ?? 300_000,
      stdin: options.stdin,
      maxOutputBytes: options.maxOutputBytes,
      signal: options.signal,
    });
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
    const result = await this.backend.invoke(["cp", "-", `${this.id}:${destDir}`], {
      timeoutMs: 600_000,
      stdin: archive,
    });
    if (result.exitCode !== 0) {
      throw new Error(`docker cp into ${destDir} failed: ${result.stderr.toString("utf8").trim().slice(0, 400)}`);
    }
  }

  async getArchive(srcPath: string): Promise<Buffer> {
    const result = await this.backend.invoke(["cp", `${this.id}:${srcPath}`, "-"], {
      timeoutMs: 600_000,
      maxOutputBytes: 512 * 1024 * 1024,
    });
    if (result.exitCode !== 0) {
      throw new Error(`docker cp out of ${srcPath} failed: ${result.stderr.toString("utf8").trim().slice(0, 400)}`);
    }
    return result.stdout;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.backend.invoke(["rm", "-f", this.id], { timeoutMs: 300_000 });
  }
}
