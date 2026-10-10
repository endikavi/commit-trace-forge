import type { Buffer } from "node:buffer";

/** Result of a command executed inside a sandbox. Always from real execution. */
export interface SandboxExecResult {
  argv: string[];
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  durationMs: number;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface SandboxExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Run as a different uid:gid than the container default. */
  user?: string;
  stdin?: Uint8Array | string;
  signal?: AbortSignal;
}

export interface SandboxContainer {
  readonly id: string;
  readonly imageRef: string;
  /** True when the container was created without network access. */
  readonly networkDisabled: boolean;
  exec(argv: readonly string[], options?: SandboxExecOptions): Promise<SandboxExecResult>;
  /** Extract a tar archive into `destDir` inside the container. */
  putArchive(archive: Uint8Array, destDir: string): Promise<void>;
  /** Read `srcPath` out of the container as a tar archive. */
  getArchive(srcPath: string): Promise<Buffer>;
  destroy(): Promise<void>;
}

export interface ImageBuildSpec {
  /** Fully-qualified base image, e.g. "python:3.12-slim". */
  baseImage: string;
  /** RUN lines executed with network access during provisioning. */
  setupCommands: readonly string[];
  workdir: string;
  env: Readonly<Record<string, string>>;
  /** uid:gid created in the image and used for every task command. Never root. */
  runAs: string;
  /** Deterministic tag derived from the recipe hash. */
  tag: string;
  timeoutMs: number;
}

export interface BuiltImage {
  imageRef: string;
  /** Local image id. Null when the backend cannot report one. */
  digest: string | null;
  baseImageDigest: string | null;
  buildLog: string;
}

export interface CreateContainerOptions {
  imageRef: string;
  /** false creates the container with no network interface at all. */
  network: boolean;
  cpuLimit: number;
  memoryMb: number;
  pidsLimit: number;
  workdir: string;
  env?: Record<string, string>;
  user?: string;
  label?: string;
}

export interface SandboxAvailability {
  ok: boolean;
  detail: string;
  version: string | null;
}

export interface SandboxBackend {
  readonly name: string;
  /**
   * Whether the backend can actually run. `forge doctor` surfaces this verbatim; the pipeline
   * refuses to claim success when the backend is unavailable.
   */
  available(): Promise<SandboxAvailability>;
  buildImage(spec: ImageBuildSpec): Promise<BuiltImage>;
  createContainer(options: CreateContainerOptions): Promise<SandboxContainer>;
  /**
   * Freeze a provisioned container into a reusable image.
   *
   * This is how dependency provisioning (which needs network) is separated from solving and
   * verification (which run with no network): the provisioned state is committed once, and every
   * later phase starts a fresh container from that image.
   */
  commitContainer(container: SandboxContainer, tag: string): Promise<BuiltImage>;
  removeImage(ref: string): Promise<void>;
  /**
   * Images whose tag starts with one of these prefixes.
   *
   * Used to find orphans: a run that was killed before it could record an image, or one whose
   * workspace was deleted, leaves images nothing else will ever reclaim.
   */
  listImages(prefixes: readonly string[]): Promise<string[]>;
  /** Remove containers left behind by an interrupted run. */
  cleanup(label: string): Promise<number>;
  /**
   * Honest description of the isolation this backend provides. Printed by `forge doctor` and
   * copied into the run report; never presented as an absolute guarantee.
   */
  isolationNotes(): string[];
}
