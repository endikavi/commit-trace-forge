import { Buffer } from "node:buffer";
import { z } from "zod";
import type { ForgeTool, ToolContext, ToolOutcome } from "./types.ts";

/**
 * The six tools an agent may use.
 *
 * Every one runs a real command inside the sandbox container. Results are recorded verbatim;
 * when a result is too large for the context window the model sees a clearly marked prefix and
 * the trajectory event carries the artifact hash of the complete payload.
 */

const MAX_PATCH_BYTES = 2 * 1024 * 1024;

async function truncate(
  full: string,
  ctx: ToolContext,
  isError: boolean,
  output: unknown,
): Promise<ToolOutcome> {
  if (full.length <= ctx.maxOutputChars) {
    return { text: full, output, isError, truncated: false, fullOutputArtifact: null };
  }
  const artifact = await ctx.artifacts.put(full);
  const keepHead = Math.floor(ctx.maxOutputChars * 0.6);
  const keepTail = ctx.maxOutputChars - keepHead - 200;
  const text =
    full.slice(0, keepHead) +
    `\n\n[... ${full.length - keepHead - keepTail} characters omitted. ` +
    `Full output stored as artifact ${artifact} ...]\n\n` +
    full.slice(full.length - keepTail);
  return { text, output, isError, truncated: true, fullOutputArtifact: artifact };
}

/** Reject absolute paths and traversal so a tool cannot reach outside the workspace. */
function normalizeRelative(path: string): string {
  const cleaned = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (cleaned.startsWith("/")) throw new Error(`path must be relative to the workspace root: ${path}`);
  if (cleaned.split("/").some((part) => part === "..")) {
    throw new Error(`path must not traverse above the workspace root: ${path}`);
  }
  return cleaned === "" ? "." : cleaned;
}

function formatExec(
  argv: readonly string[],
  exitCode: number | null,
  stdout: string,
  stderr: string,
  durationMs: number,
  timedOut: boolean,
): string {
  return [
    `$ ${argv.join(" ")}`,
    `exit: ${exitCode}${timedOut ? " (killed after the timeout)" : ""}  duration: ${durationMs}ms`,
    stdout.length > 0 ? `--- stdout ---\n${stdout}` : "--- stdout --- (empty)",
    stderr.length > 0 ? `--- stderr ---\n${stderr}` : "--- stderr --- (empty)",
  ].join("\n");
}

// ---------------------------------------------------------------------------

const ReadFileInput = z.object({
  path: z.string().min(1),
  start_line: z.number().int().min(1).optional(),
  end_line: z.number().int().min(1).optional(),
});

export const readFileTool: ForgeTool<z.infer<typeof ReadFileInput>> = {
  name: "read_file",
  description:
    "Read a UTF-8 text file from the workspace. Optionally limit the result to a 1-based inclusive line range.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the workspace root." },
      start_line: { type: "integer", minimum: 1, description: "First line to return (1-based, inclusive)." },
      end_line: { type: "integer", minimum: 1, description: "Last line to return (1-based, inclusive)." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      total_lines: { type: "integer" },
      returned_lines: { type: "integer" },
      exists: { type: "boolean" },
    },
    required: ["path", "exists"],
  },
  parse: (raw) => ReadFileInput.parse(raw),
  async execute(input, ctx) {
    const path = normalizeRelative(input.path);
    const result = await ctx.container.exec(["cat", "--", path], {
      cwd: ctx.workdir,
      timeoutMs: ctx.timeoutMs,
      maxOutputBytes: 32 * 1024 * 1024,
      signal: ctx.signal,
    });
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString("utf8").trim();
      return truncate(`cannot read ${path}: ${stderr || `exit ${result.exitCode}`}`, ctx, true, {
        path,
        exists: false,
      });
    }
    const content = result.stdout.toString("utf8");
    const lines = content.split("\n");
    const start = input.start_line ?? 1;
    const end = input.end_line ?? lines.length;
    if (start > end) throw new Error(`start_line (${start}) must be <= end_line (${end})`);
    const slice = lines.slice(start - 1, end);
    const numbered = slice.map((line, index) => `${start + index}\t${line}`).join("\n");
    return truncate(numbered, ctx, false, {
      path,
      exists: true,
      total_lines: lines.length,
      returned_lines: slice.length,
    });
  },
};

// ---------------------------------------------------------------------------

const ListFilesInput = z.object({
  path: z.string().default("."),
  max_depth: z.number().int().min(1).max(20).default(3),
});

export const listFilesTool: ForgeTool<z.infer<typeof ListFilesInput>> = {
  name: "list_files",
  description: "List files and directories under a workspace path, up to a maximum depth.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory relative to the workspace root. Defaults to '.'." },
      max_depth: { type: "integer", minimum: 1, maximum: 20, description: "Recursion depth. Defaults to 3." },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { path: { type: "string" }, entries: { type: "integer" } },
    required: ["path", "entries"],
  },
  parse: (raw) => ListFilesInput.parse(raw ?? {}),
  async execute(input, ctx) {
    const path = normalizeRelative(input.path);
    const result = await ctx.container.exec(
      ["find", path, "-maxdepth", String(input.max_depth), "-not", "-path", "*/.git/*", "-not", "-name", ".git"],
      { cwd: ctx.workdir, timeoutMs: ctx.timeoutMs, maxOutputBytes: 8 * 1024 * 1024, signal: ctx.signal },
    );
    if (result.exitCode !== 0) {
      return truncate(`cannot list ${path}: ${result.stderr.toString("utf8").trim()}`, ctx, true, {
        path,
        entries: 0,
      });
    }
    const entries = result.stdout.toString("utf8").split("\n").filter((line) => line.trim().length > 0).sort();
    return truncate(entries.join("\n"), ctx, false, { path, entries: entries.length });
  },
};

// ---------------------------------------------------------------------------

const SearchInput = z.object({
  pattern: z.string().min(1),
  path: z.string().default("."),
  /** Restrict to files whose name matches this glob. */
  glob: z.string().optional(),
  case_sensitive: z.boolean().default(true),
  max_results: z.number().int().min(1).max(2000).default(200),
});

export const searchTool: ForgeTool<z.infer<typeof SearchInput>> = {
  name: "search",
  description:
    "Search workspace file contents with a POSIX extended regular expression. Returns path:line:text matches.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "POSIX extended regular expression." },
      path: { type: "string", description: "Directory or file to search. Defaults to '.'." },
      glob: { type: "string", description: "Only search files whose name matches this shell glob." },
      case_sensitive: { type: "boolean", description: "Defaults to true." },
      max_results: { type: "integer", minimum: 1, maximum: 2000, description: "Defaults to 200." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { matches: { type: "integer" }, truncated_to_max: { type: "boolean" } },
    required: ["matches"],
  },
  parse: (raw) => SearchInput.parse(raw),
  async execute(input, ctx) {
    const path = normalizeRelative(input.path);
    const argv = ["grep", "-rnE", "--exclude-dir=.git", "-I"];
    if (!input.case_sensitive) argv.push("-i");
    if (input.glob) argv.push(`--include=${input.glob}`);
    argv.push("--", input.pattern, path);

    const result = await ctx.container.exec(argv, {
      cwd: ctx.workdir,
      timeoutMs: ctx.timeoutMs,
      maxOutputBytes: 16 * 1024 * 1024,
      signal: ctx.signal,
    });
    // grep exits 1 when there are no matches; that is a valid empty result, not an error.
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      return truncate(
        `search failed: ${result.stderr.toString("utf8").trim() || `exit ${result.exitCode}`}`,
        ctx,
        true,
        { matches: 0 },
      );
    }
    const all = result.stdout.toString("utf8").split("\n").filter((l) => l.length > 0);
    const limited = all.slice(0, input.max_results);
    const text =
      limited.length === 0
        ? "no matches"
        : limited.join("\n") +
          (all.length > limited.length ? `\n[... ${all.length - limited.length} further matches omitted ...]` : "");
    return truncate(text, ctx, false, { matches: all.length, truncated_to_max: all.length > limited.length });
  },
};

// ---------------------------------------------------------------------------

const ApplyPatchInput = z.object({
  patch: z.string().min(1),
});

export const applyPatchTool: ForgeTool<z.infer<typeof ApplyPatchInput>> = {
  name: "apply_patch",
  description:
    "Apply a unified diff to the workspace with `git apply`. Paths use the a/ and b/ prefixes. " +
    "The patch is validated first; if it does not apply cleanly nothing is changed.",
  inputSchema: {
    type: "object",
    properties: {
      patch: {
        type: "string",
        description: "A unified diff. Include file headers (--- a/path, +++ b/path) and @@ hunks.",
      },
    },
    required: ["patch"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      applied: { type: "boolean" },
      files_changed: { type: "array", items: { type: "string" } },
    },
    required: ["applied"],
  },
  parse: (raw) => ApplyPatchInput.parse(raw),
  async execute(input, ctx) {
    const patch = input.patch.endsWith("\n") ? input.patch : `${input.patch}\n`;
    const bytes = Buffer.from(patch, "utf8");
    if (bytes.length > MAX_PATCH_BYTES) {
      return truncate(`patch rejected: ${bytes.length} bytes exceeds the ${MAX_PATCH_BYTES} byte limit`, ctx, true, {
        applied: false,
      });
    }

    const base = ["git", "-c", "core.autocrlf=false", "apply", "--whitespace=nowarn"];
    const check = await ctx.container.exec([...base, "--check", "-"], {
      cwd: ctx.workdir,
      timeoutMs: ctx.timeoutMs,
      stdin: bytes,
      signal: ctx.signal,
    });
    if (check.exitCode !== 0) {
      const stderr = check.stderr.toString("utf8").trim();
      return truncate(
        `patch does not apply; the workspace is unchanged.\n${stderr || `git apply --check exited ${check.exitCode}`}`,
        ctx,
        true,
        { applied: false },
      );
    }

    // `git apply --numstat` PRINTS the per-file counts and applies NOTHING. Collect the file
    // list with it first, then apply for real with a plain `git apply`. Conflating the two
    // reports a successful patch while the workspace is untouched.
    const listing = await ctx.container.exec([...base, "--numstat", "-"], {
      cwd: ctx.workdir,
      timeoutMs: ctx.timeoutMs,
      stdin: bytes,
      signal: ctx.signal,
    });
    const filesChanged = listing.stdout
      .toString("utf8")
      .split("\n")
      .map((line) => line.split("\t")[2])
      .filter((p): p is string => Boolean(p));

    const apply = await ctx.container.exec([...base, "-"], {
      cwd: ctx.workdir,
      timeoutMs: ctx.timeoutMs,
      stdin: bytes,
      signal: ctx.signal,
    });
    if (apply.exitCode !== 0) {
      return truncate(
        `patch failed to apply after passing the check: ${apply.stderr.toString("utf8").trim()}`,
        ctx,
        true,
        { applied: false },
      );
    }
    return truncate(
      `patch applied. files changed: ${filesChanged.length > 0 ? filesChanged.join(", ") : "(none reported)"}`,
      ctx,
      false,
      { applied: true, files_changed: filesChanged },
    );
  },
};

// ---------------------------------------------------------------------------

const RunCommandInput = z.object({
  command: z.string().min(1),
  timeout_seconds: z.number().int().min(1).max(3600).optional(),
});

export const runCommandTool: ForgeTool<z.infer<typeof RunCommandInput>> = {
  name: "run_command",
  description:
    "Run a shell command in the workspace root and return its real exit code, stdout and stderr.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command executed with `sh -c`." },
      timeout_seconds: { type: "integer", minimum: 1, maximum: 3600, description: "Per-command timeout." },
    },
    required: ["command"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      exit_code: { type: ["integer", "null"] },
      duration_ms: { type: "integer" },
      timed_out: { type: "boolean" },
    },
    required: ["exit_code", "duration_ms", "timed_out"],
  },
  parse: (raw) => RunCommandInput.parse(raw),
  async execute(input, ctx) {
    const timeoutMs = input.timeout_seconds ? input.timeout_seconds * 1000 : ctx.timeoutMs;
    const argv = ["sh", "-c", input.command];
    const result = await ctx.container.exec(argv, {
      cwd: ctx.workdir,
      timeoutMs,
      maxOutputBytes: 16 * 1024 * 1024,
      signal: ctx.signal,
    });
    const text = formatExec(
      ["sh", "-c", input.command],
      result.exitCode,
      result.stdout.toString("utf8"),
      result.stderr.toString("utf8"),
      result.durationMs,
      result.timedOut,
    );
    return truncate(text, ctx, result.exitCode !== 0, {
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
      timed_out: result.timedOut,
    });
  },
};

// ---------------------------------------------------------------------------

const AskUserInput = z.object({
  question: z.string().min(1).max(2000),
});

export const askUserTool: ForgeTool<z.infer<typeof AskUserInput>> = {
  name: "ask_user",
  description:
    "Ask the user a single clarifying question about the desired behaviour. Use it only when the " +
    "answer would change what you build; do not use it to narrate progress.",
  inputSchema: {
    type: "object",
    properties: { question: { type: "string", maxLength: 2000 } },
    required: ["question"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { answer: { type: "string" }, origin: { type: "string" } },
    required: ["answer", "origin"],
  },
  parse: (raw) => AskUserInput.parse(raw),
  async execute(input, ctx) {
    if (!ctx.askUser) {
      return truncate("the user is not available for questions in this session", ctx, true, {
        answer: "",
        origin: "unavailable",
      });
    }
    const answer = await ctx.askUser(input.question);
    return truncate(answer, ctx, false, { answer, origin: "synthetic_user" });
  },
};

export const FORGE_TOOLS: ForgeTool[] = [
  readFileTool,
  listFilesTool,
  searchTool,
  applyPatchTool,
  runCommandTool,
  askUserTool,
] as ForgeTool[];

export function toolsFor(options: { allowAskUser: boolean }): ForgeTool[] {
  return FORGE_TOOLS.filter((tool) => options.allowAskUser || tool.name !== "ask_user");
}

export function toolByName(name: string): ForgeTool | undefined {
  return FORGE_TOOLS.find((tool) => tool.name === name);
}

/** Tool definitions as the agent sees them, for the exported training and RL views. */
export function toolSchemas(tools: readonly ForgeTool[]): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
  return tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema }));
}
