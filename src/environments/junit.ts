import type { TestOutcome } from "../types/index.ts";

/**
 * Tolerant JUnit XML reader.
 *
 * Only what test runners actually emit is parsed. When parsing fails the caller records
 * `parsed: false` and the pipeline falls back to suite-level exit codes; it never fabricates
 * per-test outcomes.
 */
export interface ParsedJunit {
  outcomes: TestOutcome[];
  totals: { passed: number; failed: number; errored: number; skipped: number };
  /**
   * Modules the runner could not collect at all, as dotted module names.
   *
   * A collection failure is real evidence — the test file cannot even import — but it produces a
   * MODULE id, not a test id, so it can never be matched against the per-test ids of a later
   * passing run. Reporting it separately keeps the two kinds of evidence from being conflated.
   */
  collectionErrors: string[];
}

const TESTCASE_RE = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase\s*>)/g;
const ATTR_RE = /([\w:.-]+)\s*=\s*"([^"]*)"/g;

function attrs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let match: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((match = ATTR_RE.exec(text)) !== null) {
    out[match[1] as string] = decodeXml(match[2] as string);
  }
  return out;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

/**
 * Build a stable test id.
 *
 * pytest's JUnit output puts the module path in `classname` (dotted) and the test name in `name`;
 * `file` carries the real path when available, which is what makes the id comparable to a
 * `path::test` node id that can be fed back to pytest.
 */
export function testId(a: Record<string, string>): string {
  const file = a.file;
  const name = a.name ?? "<unnamed>";
  const classname = a.classname ?? "";
  if (file) {
    // classname is "pkg.module.Class" for class-based tests; keep only the class part.
    const dotted = classname.split(".");
    const last = dotted[dotted.length - 1] ?? "";
    const looksLikeClass = /^[A-Z]/.test(last);
    return looksLikeClass ? `${file}::${last}::${name}` : `${file}::${name}`;
  }
  return classname ? `${classname}::${name}` : name;
}

export function parseJunitXml(xml: string): ParsedJunit | null {
  if (!xml.includes("<testcase") && !xml.includes("<testsuite")) return null;
  const outcomes: TestOutcome[] = [];
  const totals = { passed: 0, failed: 0, errored: 0, skipped: 0 };
  const collectionErrors: string[] = [];

  let match: RegExpExecArray | null;
  TESTCASE_RE.lastIndex = 0;
  while ((match = TESTCASE_RE.exec(xml)) !== null) {
    const a = attrs(match[1] ?? "");
    const body = match[3] ?? "";
    let status: TestOutcome["status"] = "passed";
    let excerpt: string | null = null;

    if (/<failure\b/.test(body)) {
      status = "failed";
      excerpt = firstMessage(body, "failure");
    } else if (/<error\b/.test(body)) {
      status = "error";
      excerpt = firstMessage(body, "error");
    } else if (/<skipped\b/.test(body)) {
      status = "skipped";
      excerpt = firstMessage(body, "skipped");
    }

    totals[status === "passed" ? "passed" : status === "failed" ? "failed" : status === "error" ? "errored" : "skipped"]++;
    const id = testId(a);
    if (status === "error" && isCollectionFailure(a, body)) collectionErrors.push(id);
    outcomes.push({ test_id: id, status, failure_excerpt: excerpt });
  }

  if (outcomes.length === 0 && !xml.includes("<testsuite")) return null;
  return { outcomes, totals, collectionErrors };
}

/**
 * A collection failure, as opposed to a failing test.
 *
 * pytest reports one as `<testcase classname="" name="tests.test_stats"><error
 * message="collection failure">`: an empty classname, a dotted module name, and an explicit
 * message. The module never ran, so there is no per-test outcome to compare against later.
 */
function isCollectionFailure(a: Record<string, string>, body: string): boolean {
  if (/message="[^"]*collection (failure|error)/i.test(body)) return true;
  return (a.classname ?? "") === "" && !(a.name ?? "").includes("::");
}

function firstMessage(body: string, tag: string): string | null {
  const open = new RegExp(`<${tag}\\b([^>]*?)(\\/>|>([\\s\\S]*?)<\\/${tag}\\s*>)`);
  const m = open.exec(body);
  if (!m) return null;
  const a = attrs(m[1] ?? "");
  const inner = decodeXml((m[3] ?? "").trim());
  const message = a.message ?? "";
  const combined = [message, inner].filter(Boolean).join("\n").trim();
  return combined.length > 0 ? combined.slice(0, 2000) : null;
}

/** Ids that a run reports as failing or erroring. */
export function failingIds(parsed: ParsedJunit): string[] {
  return parsed.outcomes.filter((o) => o.status === "failed" || o.status === "error").map((o) => o.test_id);
}

export function passingIds(parsed: ParsedJunit): string[] {
  return parsed.outcomes.filter((o) => o.status === "passed").map((o) => o.test_id);
}

/**
 * Map a dotted pytest module name back to a repository path.
 *
 * `tests.test_stats` -> `tests/test_stats.py`, checked against the paths actually written so a
 * guess is never turned into a requirement.
 */
export function moduleToPath(moduleName: string, knownPaths: readonly string[]): string | null {
  const candidate = `${moduleName.split(".").join("/")}.py`;
  if (knownPaths.includes(candidate)) return candidate;
  const suffix = `${moduleName.split(".").pop()}.py`;
  const matches = knownPaths.filter((p) => p.endsWith(`/${suffix}`) || p === suffix);
  return matches.length === 1 ? (matches[0] as string) : null;
}
