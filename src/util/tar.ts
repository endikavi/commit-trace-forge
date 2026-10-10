import { Buffer } from "node:buffer";

/**
 * Minimal USTAR reader/writer.
 *
 * Used to move file sets in and out of containers over stdin/stdout instead of bind-mounting
 * host directories (see docs/security.md: no host paths are ever mounted into a task container).
 */

export interface TarEntry {
  path: string;
  /** POSIX mode bits, e.g. 0o644 / 0o755 / 0o120000 for symlinks. */
  mode: number;
  type: "file" | "directory" | "symlink";
  /** File contents. Empty for directories. For symlinks this is ignored; use `linkname`. */
  data: Uint8Array;
  linkname?: string;
  mtime?: number;
  /** Numeric owner recorded in the header. Defaults to 0. */
  uid?: number;
  gid?: number;
}

const BLOCK = 512;

/**
 * Earliest modification time written: 1980-01-01T00:00:00Z.
 *
 * ZIP cannot represent earlier dates, and Python build backends that package through zipfile
 * (flit_core, hatchling, ...) fail outright on a file dated 1970 — so an entry without a usable
 * mtime would make `pip install -e .` fail for reasons that have nothing to do with the repository.
 */
export const MIN_MTIME_MS = Date.UTC(1980, 0, 1);

function writeString(block: Buffer, value: string, offset: number, length: number): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length - 1) {
    throw new RangeError(`tar field too long (${bytes.length} > ${length - 1}): ${value}`);
  }
  bytes.copy(block, offset);
}

function writeOctal(block: Buffer, value: number, offset: number, length: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  writeString(block, text, offset, length);
}

function header(entry: TarEntry, size: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  // USTAR splits long names into prefix(155) + name(100).
  let name = entry.path;
  let prefix = "";
  if (Buffer.byteLength(name) > 99) {
    const cut = name.lastIndexOf("/", name.length - 100 + name.length);
    const idx = name.length > 100 ? name.indexOf("/", name.length - 100) : -1;
    const splitAt = idx >= 0 ? idx : cut;
    if (splitAt <= 0) throw new RangeError(`tar path too long: ${entry.path}`);
    prefix = name.slice(0, splitAt);
    name = name.slice(splitAt + 1);
  }

  writeString(block, name, 0, 100);
  writeOctal(block, entry.mode & 0o7777, 100, 8);
  writeOctal(block, entry.uid ?? 0, 108, 8);
  writeOctal(block, entry.gid ?? 0, 116, 8);
  writeOctal(block, size, 124, 12);
  writeOctal(block, Math.floor(Math.max(entry.mtime ?? 0, MIN_MTIME_MS) / 1000), 136, 12);
  block.write("        ", 148, 8, "ascii"); // checksum placeholder
  const typeflag = entry.type === "directory" ? "5" : entry.type === "symlink" ? "2" : "0";
  block.write(typeflag, 156, 1, "ascii");
  if (entry.linkname) writeString(block, entry.linkname, 157, 100);
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  if (prefix) writeString(block, prefix, 345, 155);

  let checksum = 0;
  for (const byte of block) checksum += byte;
  const chk = checksum.toString(8).padStart(6, "0") + "\0 ";
  block.write(chk, 148, 8, "ascii");
  return block;
}

function padding(size: number): Buffer {
  const rem = size % BLOCK;
  return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rem);
}

export function createTar(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const body = entry.type === "file" ? Buffer.from(entry.data) : Buffer.alloc(0);
    parts.push(header(entry, body.length));
    if (body.length > 0) {
      parts.push(body);
      parts.push(padding(body.length));
    }
  }
  // Two zero blocks terminate the archive; pad to a 10240-byte record for strict readers.
  parts.push(Buffer.alloc(BLOCK * 2));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const recordPad = total % 10240 === 0 ? 0 : 10240 - (total % 10240);
  if (recordPad > 0) parts.push(Buffer.alloc(recordPad));
  return Buffer.concat(parts);
}

export function tarFromFiles(files: Record<string, string | Uint8Array>, mode = 0o644): Buffer {
  return createTar(
    Object.entries(files)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, data]) => ({
        path,
        mode,
        type: "file" as const,
        data: typeof data === "string" ? Buffer.from(data, "utf8") : data,
      })),
  );
}

function parseOctal(buf: Buffer): number {
  const text = buf.toString("ascii").replace(/\0.*$/, "").trim();
  if (text === "") return 0;
  return Number.parseInt(text, 8) || 0;
}

export function parseTar(archive: Uint8Array): TarEntry[] {
  const buf = Buffer.from(archive);
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + BLOCK <= buf.length) {
    const head = buf.subarray(offset, offset + BLOCK);
    if (head.every((b) => b === 0)) break;
    const rawName = head.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = head.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const size = parseOctal(head.subarray(124, 136));
    const mode = parseOctal(head.subarray(100, 108));
    const typeflag = head.subarray(156, 157).toString("ascii");
    const linkname = head.subarray(157, 257).toString("utf8").replace(/\0.*$/, "");
    offset += BLOCK;
    const data = buf.subarray(offset, offset + size);
    offset += size + (size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK));
    const path = prefix ? `${prefix}/${rawName}` : rawName;
    const uid = parseOctal(head.subarray(108, 116));
    const gid = parseOctal(head.subarray(116, 124));
    // Kept so a rewritten archive does not reset every file to 1970; `git archive` records the
    // commit time here.
    const mtime = parseOctal(head.subarray(136, 148)) * 1000;
    if (typeflag === "5") entries.push({ path, mode, type: "directory", data: Buffer.alloc(0), uid, gid, mtime });
    else if (typeflag === "2") {
      entries.push({ path, mode, type: "symlink", data: Buffer.alloc(0), linkname, uid, gid, mtime });
    } else if (typeflag === "0" || typeflag === "" || typeflag === "\0") {
      entries.push({ path, mode, type: "file", data: Buffer.from(data), uid, gid, mtime });
    }
    // Other typeflags (long name extensions, pax headers) are ignored on purpose: the archives we
    // read are produced by `git archive`, which emits plain ustar entries.
  }
  return entries;
}

/**
 * Rewrite an archive so every entry is owned by `uid:gid`.
 *
 * `git archive` records owner 0, and the container runtime extracts a tar preserving the header's
 * uid/gid. Rewriting the owner here means the workspace lands writable by the unprivileged task
 * user WITHOUT any privileged step inside the container: no `chown` as root, and therefore no
 * need to grant CAP_CHOWN back after dropping all capabilities.
 */
export function retarWithOwner(archive: Uint8Array, uid: number, gid: number): Buffer {
  return createTar(parseTar(archive).map((entry) => ({ ...entry, uid, gid })));
}

/** Parse a "uid:gid" string. Throws rather than guessing on malformed input. */
export function parseOwner(value: string): { uid: number; gid: number } {
  const match = /^(\d+):(\d+)$/.exec(value.trim());
  if (!match) throw new Error(`expected a numeric "uid:gid" owner, got: ${value}`);
  return { uid: Number(match[1]), gid: Number(match[2]) };
}
