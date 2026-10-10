import { Buffer } from "node:buffer";
import { exec, execOk, type ExecResult } from "../util/exec.ts";

/**
 * Typed wrapper over the git CLI.
 *
 * All reads happen against a local mirror clone under the workspace; the upstream repository is
 * never modified and the solver never sees this directory.
 */
export class Git {
  readonly dir: string;
  private readonly timeoutMs: number;

  constructor(dir: string, timeoutMs = 600_000) {
    this.dir = dir;
    this.timeoutMs = timeoutMs;
  }

  private argv(args: readonly string[]): string[] {
    // -c settings neutralise host git config that could rewrite content (autocrlf) or
    // slow things down. --no-pager keeps output machine-readable.
    return [
      "git",
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.symlinks=true",
      "-c",
      "core.quotepath=false",
      "-c",
      "gc.auto=0",
      "--no-pager",
      ...args,
    ];
  }

  async run(args: readonly string[], options: { cwd?: string; stdin?: Uint8Array | string } = {}): Promise<ExecResult> {
    return exec(this.argv(args), { cwd: options.cwd ?? this.dir, timeoutMs: this.timeoutMs, stdin: options.stdin });
  }

  async runOk(args: readonly string[], options: { cwd?: string } = {}): Promise<string> {
    const result = await execOk(this.argv(args), { cwd: options.cwd ?? this.dir, timeoutMs: this.timeoutMs });
    return result.stdout.toString("utf8");
  }

  async runOkRaw(args: readonly string[], options: { cwd?: string } = {}): Promise<Buffer> {
    const result = await execOk(this.argv(args), {
      cwd: options.cwd ?? this.dir,
      timeoutMs: this.timeoutMs,
      // Archives of large repositories can exceed the default cap.
      maxOutputBytes: 512 * 1024 * 1024,
    });
    return result.stdout;
  }

  static async version(): Promise<string | null> {
    try {
      const result = await exec(["git", "--version"], { timeoutMs: 30_000 });
      return result.exitCode === 0 ? result.stdout.toString("utf8").trim() : null;
    } catch {
      return null;
    }
  }

  /** Resolve a ref (branch, tag, SHA) to a full commit SHA. */
  async resolveCommit(ref: string): Promise<string> {
    return (await this.runOk(["rev-parse", "--verify", `${ref}^{commit}`])).trim();
  }

  async treeSha(commit: string): Promise<string> {
    return (await this.runOk(["rev-parse", "--verify", `${commit}^{tree}`])).trim();
  }

  async commitExists(sha: string): Promise<boolean> {
    const result = await this.run(["cat-file", "-e", `${sha}^{commit}`]);
    return result.exitCode === 0;
  }

  /**
   * Enumerate commits reachable from `ref`, newest first.
   * Returns parents so merges and root commits are identifiable without a second call.
   */
  async listCommits(ref: string, limit: number): Promise<CommitSummary[]> {
    const SEP = "\u001f"; // unit separator: cannot appear in git metadata
    const REC = "\u001e"; // record separator
    const format = ["%H", "%P", "%aI", "%cI", "%an", "%ae", "%s"].join(SEP);
    const out = await this.runOk([
      "log",
      `--max-count=${limit}`,
      `--format=${format}${REC}`,
      ref,
    ]);
    const commits: CommitSummary[] = [];
    for (const record of out.split(REC)) {
      const line = record.replace(/^\n/, "");
      if (!line.trim()) continue;
      const parts = line.split(SEP);
      if (parts.length < 7) continue;
      const parents = (parts[1] ?? "").trim();
      commits.push({
        sha: (parts[0] ?? "").trim(),
        parents: parents === "" ? [] : parents.split(" "),
        authorDate: (parts[2] ?? "").trim(),
        committerDate: (parts[3] ?? "").trim(),
        authorName: parts[4] ?? "",
        authorEmail: parts[5] ?? "",
        subject: parts[6] ?? "",
      });
    }
    return commits;
  }

  async commitMessage(sha: string): Promise<string> {
    return this.runOk(["log", "-1", "--format=%B", sha]);
  }

  /**
   * Numstat + raw status for a commit against a given parent.
   * `-M<sim>%` enables rename detection; binary files report "-" for both counts, which is
   * preserved as `is_binary` instead of being silently read as zero changed lines.
   */
  async diffEntries(parent: string, target: string, renameSimilarity: number): Promise<RawDiffEntry[]> {
    const numstat = await this.runOk([
      "diff",
      `-M${renameSimilarity}%`,
      "--numstat",
      "-z",
      "--no-color",
      parent,
      target,
    ]);
    const raw = await this.runOk([
      "diff",
      `-M${renameSimilarity}%`,
      "--raw",
      "-z",
      "--no-color",
      parent,
      target,
    ]);
    const numstats = parseNumstatZ(numstat);
    const rawEntries = parseRawZ(raw);

    const byPath = new Map<string, RawDiffEntry>();
    for (const entry of rawEntries) byPath.set(entry.path, entry);
    for (const stat of numstats) {
      const entry = byPath.get(stat.path);
      if (!entry) continue;
      entry.addedLines = stat.added;
      entry.deletedLines = stat.deleted;
      entry.isBinary = stat.binary;
    }
    return rawEntries;
  }

  /** Unified patch for a commit against a parent. */
  async patch(parent: string, target: string, renameSimilarity: number): Promise<string> {
    return this.runOk([
      "diff",
      `-M${renameSimilarity}%`,
      "--no-color",
      "--patch",
      "--no-ext-diff",
      parent,
      target,
    ]);
  }

  /** `git archive` tar of a tree. Contains file contents and modes, and no git objects. */
  async archiveTar(commitOrTree: string): Promise<Buffer> {
    return this.runOkRaw(["archive", "--format=tar", commitOrTree]);
  }

  /** Entries of a tree: mode, type, object sha, path. */
  async lsTree(commitOrTree: string): Promise<TreeEntry[]> {
    const out = await this.runOk(["ls-tree", "-r", "-z", "-t", commitOrTree]);
    const entries: TreeEntry[] = [];
    for (const record of out.split("\0")) {
      if (!record) continue;
      const tabIndex = record.indexOf("\t");
      if (tabIndex < 0) continue;
      const meta = record.slice(0, tabIndex).split(/\s+/);
      const [mode, type, sha] = meta;
      if (!mode || !type || !sha) continue;
      entries.push({ mode, type: type as TreeEntry["type"], sha, path: record.slice(tabIndex + 1) });
    }
    return entries;
  }

  async catFile(sha: string): Promise<Buffer> {
    return this.runOkRaw(["cat-file", "blob", sha]);
  }

  async catFileText(sha: string): Promise<string> {
    return (await this.catFile(sha)).toString("utf8");
  }

  /** Read a path at a revision. Returns null when the path does not exist there. */
  async showFile(rev: string, path: string): Promise<Buffer | null> {
    const result = await exec(this.argv(["show", `${rev}:${path}`]), {
      cwd: this.dir,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: 64 * 1024 * 1024,
    });
    if (result.exitCode !== 0) return null;
    return result.stdout;
  }

  async listPathsAt(rev: string): Promise<string[]> {
    const out = await this.runOk(["ls-tree", "-r", "--name-only", "-z", rev]);
    return out.split("\0").filter((p) => p.length > 0);
  }

  /** Detect a license file at a revision and return its SPDX id when confidently recognised. */
  async detectLicense(rev: string): Promise<{ spdx: string | null; path: string | null; notice: string | null }> {
    const paths = await this.listPathsAt(rev);
    const candidates = paths.filter((p) =>
      /^(LICENSE|LICENCE|COPYING|LICENSE\.(md|txt)|LICENCE\.(md|txt))$/i.test(p),
    );
    const chosen = candidates[0];
    if (!chosen) return { spdx: null, path: null, notice: null };
    const content = (await this.showFile(rev, chosen))?.toString("utf8") ?? "";
    return { spdx: identifyLicense(content), path: chosen, notice: content.slice(0, 4000) };
  }
}

export interface CommitSummary {
  sha: string;
  parents: string[];
  authorDate: string;
  committerDate: string;
  authorName: string;
  authorEmail: string;
  subject: string;
}

export interface TreeEntry {
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  path: string;
}

export interface RawDiffEntry {
  path: string;
  oldPath: string | null;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "type_changed";
  oldMode: string | null;
  newMode: string | null;
  addedLines: number;
  deletedLines: number;
  isBinary: boolean;
  isSubmodule: boolean;
  score: number | null;
}

function parseNumstatZ(out: string): Array<{ path: string; added: number; deleted: number; binary: boolean }> {
  // NUL-separated. A rename emits: "<add>\t<del>\t\0<old>\0<new>\0"
  const fields = out.split("\0");
  const result: Array<{ path: string; added: number; deleted: number; binary: boolean }> = [];
  let i = 0;
  while (i < fields.length) {
    const head = fields[i];
    if (head === undefined || head === "") {
      i++;
      continue;
    }
    const parts = head.split("\t");
    const addedText = parts[0] ?? "";
    const deletedText = parts[1] ?? "";
    const inlinePath = parts[2] ?? "";
    const binary = addedText === "-" || deletedText === "-";
    const added = binary ? 0 : Number.parseInt(addedText, 10) || 0;
    const deleted = binary ? 0 : Number.parseInt(deletedText, 10) || 0;
    if (inlinePath === "") {
      // rename/copy: the next two NUL fields are old and new paths
      const newPath = fields[i + 2] ?? "";
      result.push({ path: newPath, added, deleted, binary });
      i += 3;
    } else {
      result.push({ path: inlinePath, added, deleted, binary });
      i += 1;
    }
  }
  return result;
}

function parseRawZ(out: string): RawDiffEntry[] {
  // ":<oldmode> <newmode> <oldsha> <newsha> <status>\0<path>\0[<newpath>\0]"
  const fields = out.split("\0");
  const entries: RawDiffEntry[] = [];
  let i = 0;
  while (i < fields.length) {
    const meta = fields[i];
    if (meta === undefined || !meta.startsWith(":")) {
      i++;
      continue;
    }
    const parts = meta.slice(1).split(" ");
    const oldMode = parts[0] ?? null;
    const newMode = parts[1] ?? null;
    const statusField = parts[4] ?? "M";
    const statusLetter = statusField[0] ?? "M";
    const score = statusField.length > 1 ? Number.parseInt(statusField.slice(1), 10) : null;
    const isRenameOrCopy = statusLetter === "R" || statusLetter === "C";
    const firstPath = fields[i + 1] ?? "";
    const secondPath = isRenameOrCopy ? (fields[i + 2] ?? "") : null;
    i += isRenameOrCopy ? 3 : 2;

    const status: RawDiffEntry["status"] =
      statusLetter === "A"
        ? "added"
        : statusLetter === "D"
          ? "deleted"
          : statusLetter === "R"
            ? "renamed"
            : statusLetter === "C"
              ? "copied"
              : statusLetter === "T"
                ? "type_changed"
                : "modified";

    entries.push({
      path: secondPath ?? firstPath,
      oldPath: secondPath ? firstPath : null,
      status,
      oldMode,
      newMode,
      addedLines: 0,
      deletedLines: 0,
      isBinary: false,
      isSubmodule: oldMode === "160000" || newMode === "160000",
      score,
    });
  }
  return entries;
}

/** Conservative license identification. Returns null rather than guessing. */
export function identifyLicense(text: string): string | null {
  const t = text.toLowerCase();
  if (t.includes("apache license") && t.includes("version 2.0")) return "Apache-2.0";
  if (t.includes("mit license") || (t.includes("permission is hereby granted, free of charge") && t.includes("without restriction")))
    return "MIT";
  if (t.includes("gnu general public license") && t.includes("version 3")) return "GPL-3.0";
  if (t.includes("gnu general public license") && t.includes("version 2")) return "GPL-2.0";
  if (t.includes("gnu lesser general public license") && t.includes("version 3")) return "LGPL-3.0";
  if (t.includes("mozilla public license") && t.includes("2.0")) return "MPL-2.0";
  if (t.includes("redistribution and use in source and binary forms")) {
    if (t.includes("neither the name")) return "BSD-3-Clause";
    return "BSD-2-Clause";
  }
  if (t.includes("this is free and unencumbered software released into the public domain")) return "Unlicense";
  if (t.includes("isc license") || t.includes("permission to use, copy, modify, and/or distribute")) return "ISC";
  return null;
}
