import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Wall-clock limit in milliseconds. 0 disables the limit. */
  timeoutMs?: number;
  stdin?: Uint8Array | string;
  /** Hard cap on captured stdout/stderr. Excess is dropped and flagged. */
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  command: string[];
  cwd: string | undefined;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  durationMs: number;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Spawn a process without a shell. Every external command in the pipeline goes through here so
 * that command line, exit code, duration and truncation status are uniformly recorded.
 */
export function exec(command: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
  const [bin, ...args] = command;
  if (!bin) return Promise.reject(new TypeError("exec requires a non-empty command"));

  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const started = Date.now();

  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let outTruncated = false;
    let errTruncated = false;
    let timedOut = false;
    let settled = false;

    const collect = (chunks: Buffer[], chunk: Buffer, which: "out" | "err") => {
      const used = which === "out" ? outBytes : errBytes;
      const remaining = maxOutput - used;
      if (remaining <= 0) {
        if (which === "out") outTruncated = true;
        else errTruncated = true;
        return;
      }
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        if (which === "out") {
          outBytes = maxOutput;
          outTruncated = true;
        } else {
          errBytes = maxOutput;
          errTruncated = true;
        }
        return;
      }
      chunks.push(chunk);
      if (which === "out") outBytes += chunk.length;
      else errBytes += chunk.length;
    };

    child.stdout.on("data", (c: Buffer) => collect(outChunks, c, "out"));
    child.stderr.on("data", (c: Buffer) => collect(errChunks, c, "err"));

    let timer: NodeJS.Timeout | undefined;
    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);
    }

    const onAbort = () => {
      timedOut = false;
      child.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        command: [...command],
        cwd: options.cwd,
        exitCode,
        signal,
        stdout: Buffer.concat(outChunks),
        stderr: Buffer.concat(errChunks),
        durationMs: Date.now() - started,
        timedOut,
        stdoutTruncated: outTruncated,
        stderrTruncated: errTruncated,
      });
    };

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code, signal) => finish(code, signal));

    if (options.stdin !== undefined) {
      child.stdin.end(typeof options.stdin === "string" ? Buffer.from(options.stdin, "utf8") : Buffer.from(options.stdin));
    } else {
      child.stdin.end();
    }
  });
}

/** Same as {@link exec} but throws when the process does not exit 0. */
export async function execOk(command: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
  const result = await exec(command, options);
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString("utf8").trim();
    const stdout = result.stdout.toString("utf8").trim();
    throw new Error(
      `command failed (exit=${result.exitCode}${result.timedOut ? ", timed out" : ""}): ${command.join(" ")}\n${stderr || stdout}`,
    );
  }
  return result;
}

export function text(result: ExecResult): string {
  return result.stdout.toString("utf8");
}
