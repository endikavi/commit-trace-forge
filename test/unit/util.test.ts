import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { canonicalJson, cacheKey, hashObject } from "../../src/util/hash.ts";
import { Prng, derive } from "../../src/util/prng.ts";
import { createTar, parseTar, parseOwner, retarWithOwner, tarFromFiles } from "../../src/util/tar.ts";
import { parseJunitXml, moduleToPath, testId } from "../../src/environments/junit.ts";
import { validateConfig } from "../../src/config/load.ts";
import { CONFIG_SCHEMA_VERSION, effectiveFilters, modelForRole } from "../../src/config/schema.ts";

describe("canonical hashing", () => {
  it("ignores key order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(hashObject({ b: 1, a: 2 })).toBe(hashObject({ a: 2, b: 1 }));
  });

  it("does not ignore array order", () => {
    expect(hashObject([1, 2])).not.toBe(hashObject([2, 1]));
  });

  it("folds the label into the key, so renaming an input invalidates it", () => {
    expect(cacheKey("image", { a: 1 })).not.toBe(cacheKey("image", { b: 1 }));
    expect(cacheKey("image", { a: 1 })).not.toBe(cacheKey("task-image", { a: 1 }));
  });

  it("refuses to hash a non-finite number instead of coercing it", () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(/non-finite/);
  });
});

describe("prng", () => {
  it("is reproducible for a seed", () => {
    const a = new Prng("seed");
    const b = new Prng("seed");
    expect(Array.from({ length: 8 }, () => a.nextUint32())).toEqual(
      Array.from({ length: 8 }, () => b.nextUint32()),
    );
  });

  it("differs between seeds", () => {
    expect(new Prng("a").nextUint32()).not.toBe(new Prng("b").nextUint32());
  });

  it("derives independent sub-streams", () => {
    expect(derive(1, "sampling").nextUint32()).not.toBe(derive(1, "splits").nextUint32());
  });

  it("stays inside the requested range", () => {
    const prng = new Prng("range");
    for (let i = 0; i < 1000; i++) {
      const value = prng.nextInt(7);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(7);
    }
  });

  it("shuffles without losing or duplicating elements", () => {
    const input = Array.from({ length: 50 }, (_, i) => i);
    const shuffled = new Prng("s").shuffled(input);
    expect(shuffled).toHaveLength(input.length);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(input);
    expect(shuffled).not.toEqual(input);
  });
});

describe("tar", () => {
  it("round-trips text, binary, modes and symlinks", () => {
    const binary = Buffer.from([0, 1, 2, 255, 254]);
    const archive = createTar([
      { path: "a.txt", mode: 0o644, type: "file", data: Buffer.from("hello", "utf8") },
      { path: "bin/run", mode: 0o755, type: "file", data: binary },
      { path: "link", mode: 0o777, type: "symlink", data: Buffer.alloc(0), linkname: "a.txt" },
      { path: "dir/", mode: 0o755, type: "directory", data: Buffer.alloc(0) },
    ]);
    const entries = parseTar(archive);

    const text = entries.find((e) => e.path === "a.txt");
    expect(Buffer.from(text!.data).toString("utf8")).toBe("hello");

    const exe = entries.find((e) => e.path === "bin/run");
    expect(exe!.mode & 0o111).toBeTruthy();
    expect(Buffer.from(exe!.data).equals(binary)).toBe(true);

    expect(entries.find((e) => e.path === "link")?.linkname).toBe("a.txt");
    expect(entries.find((e) => e.path === "dir/")?.type).toBe("directory");
  });

  it("rewrites ownership without touching content", () => {
    const original = tarFromFiles({ "a.txt": "content", "b/c.txt": "more" });
    const owned = retarWithOwner(original, 1000, 1000);
    const entries = parseTar(owned);
    expect(entries.every((e) => e.uid === 1000 && e.gid === 1000)).toBe(true);
    expect(Buffer.from(entries.find((e) => e.path === "a.txt")!.data).toString("utf8")).toBe("content");
  });

  it("keeps modification times when rewriting ownership, and never writes a pre-1980 date", () => {
    // flit_core and hatchling build wheels through zipfile, which rejects dates before 1980; a
    // workspace whose files all read 1970 cannot be installed with `pip install -e .`.
    const commitTime = Date.UTC(2024, 4, 1, 12, 0, 0);
    const original = createTar([{ path: "a.py", mode: 0o644, type: "file", data: Buffer.from("x"), mtime: commitTime }]);
    expect(parseTar(retarWithOwner(original, 1000, 1000))[0]?.mtime).toBe(commitTime);
    expect(parseTar(tarFromFiles({ "b.py": "y" }))[0]?.mtime).toBe(Date.UTC(1980, 0, 1));
  });

  it("rejects a malformed owner rather than guessing", () => {
    expect(parseOwner("1000:1000")).toEqual({ uid: 1000, gid: 1000 });
    expect(() => parseOwner("root:root")).toThrow(/numeric/);
  });
});

describe("junit parsing", () => {
  it("reads passes and failures with per-test ids", () => {
    const xml = `<testsuites><testsuite name="pytest" tests="2">
      <testcase classname="tests.test_stats" name="test_a" file="tests/test_stats.py" time="0.1"/>
      <testcase classname="tests.test_stats" name="test_b" file="tests/test_stats.py" time="0.1">
        <failure message="assert 1 == 2">boom</failure>
      </testcase>
    </testsuite></testsuites>`;
    const parsed = parseJunitXml(xml)!;
    expect(parsed.totals).toMatchObject({ passed: 1, failed: 1 });
    expect(parsed.outcomes.map((o) => o.test_id)).toEqual([
      "tests/test_stats.py::test_a",
      "tests/test_stats.py::test_b",
    ]);
    expect(parsed.outcomes[1]?.failure_excerpt).toContain("assert 1 == 2");
    expect(parsed.collectionErrors).toEqual([]);
  });

  it("separates a module collection failure from a failing test", () => {
    // This is exactly what pytest emits when the module cannot be imported.
    const xml = `<testsuites><testsuite name="pytest" errors="1" tests="1">
      <testcase classname="" name="tests.test_stats" time="0.0">
        <error message="collection failure">ImportError: cannot import name 'median'</error>
      </testcase>
    </testsuite></testsuites>`;
    const parsed = parseJunitXml(xml)!;
    expect(parsed.collectionErrors).toEqual(["tests.test_stats"]);
    expect(parsed.outcomes[0]?.status).toBe("error");
  });

  it("maps a dotted module back to a path it actually knows about", () => {
    expect(moduleToPath("tests.test_stats", ["tests/test_stats.py"])).toBe("tests/test_stats.py");
    // Never invent a path that was not written.
    expect(moduleToPath("tests.other", ["tests/test_stats.py"])).toBeNull();
  });

  it("builds a class-qualified id when the class is identifiable", () => {
    expect(testId({ classname: "tests.test_x.TestThing", name: "test_a", file: "tests/test_x.py" })).toBe(
      "tests/test_x.py::TestThing::test_a",
    );
  });

  it("returns null for output that is not a junit report", () => {
    expect(parseJunitXml("not xml")).toBeNull();
  });
});

describe("configuration", () => {
  const minimal = { schema_version: CONFIG_SCHEMA_VERSION, repositories: [{ url: "https://example.invalid/r.git" }] };

  it("fills defaults", () => {
    const config = validateConfig(minimal);
    expect(config.sampling.target_samples).toBe(100);
    expect(config.verification.acceptance_mode).toBe("exact_tree");
    expect(config.sandbox.run_as).toBe("1000:1000");
    expect(config.filters.changed_lines).toEqual({ min: 10, max: 300 });
  });

  it("rejects weights that do not sum to one", () => {
    expect(() =>
      validateConfig({ ...minimal, grading: { weights: { task_clarity: 0.9, testability: 0.9 } } }),
    ).toThrow();
  });

  it("rejects splits that do not sum to one", () => {
    expect(() =>
      validateConfig({ ...minimal, export: { splits: { train: 0.5, validation: 0.1, test: 0.1 } } }),
    ).toThrow();
  });

  it("rejects an inverted range", () => {
    expect(() => validateConfig({ ...minimal, filters: { changed_lines: { min: 100, max: 10 } } })).toThrow();
  });

  it("rejects a root sandbox user", () => {
    expect(() => validateConfig({ ...minimal, sandbox: { run_as: "root:root" } })).toThrow();
  });

  it("merges per-repository filter overrides over the global block", () => {
    const config = validateConfig({
      ...minimal,
      filters: { changed_lines: { min: 10, max: 300 }, exclude_merges: true },
      repositories: [{ url: "https://example.invalid/r.git", filters: { changed_lines: { min: 50, max: 80 } } }],
    });
    const filters = effectiveFilters(config, config.repositories[0]!);
    expect(filters.changed_lines).toEqual({ min: 50, max: 80 });
    // Untouched global settings survive the merge.
    expect(filters.exclude_merges).toBe(true);
  });

  it("resolves per-role model overrides with fallback", () => {
    const config = validateConfig({
      ...minimal,
      model: { provider: "p", model: "base", thinking: "off", roles: { solver: { model: "strong" } } },
    });
    expect(modelForRole(config, "solver")).toEqual({ provider: "p", model: "strong", thinking: "off" });
    expect(modelForRole(config, "grader")).toEqual({ provider: "p", model: "base", thinking: "off" });
  });
});
