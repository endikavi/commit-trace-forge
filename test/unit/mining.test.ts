import { describe, expect, it, beforeAll } from "vitest";
import { join, resolve } from "node:path";
import { buildFixtureRepo, type FixtureCommit } from "../fixtures/build-fixture.ts";
import { Git } from "../../src/sources/git.ts";
import { buildMetrics } from "../../src/mining/metrics.ts";
import { screenCommitDiff, screenCommitMetadata, screenTargetGitignore } from "../../src/mining/filters.ts";
import { sampleCommits } from "../../src/mining/sample.ts";
import { validateConfig } from "../../src/config/load.ts";
import { effectiveFilters } from "../../src/config/schema.ts";
import { isFormattingOnlyPatch, classifyPath } from "../../src/mining/classify.ts";

/**
 * Every rejection class the fixture encodes must be detected, and must be detected for the RIGHT
 * reason. A commit rejected by the size filter when it was meant to exercise the binary detector
 * would leave that detector untested.
 */

const REPO_DIR = resolve(join(import.meta.dirname, "..", "fixtures", "repo"));

const CONFIG = validateConfig({
  schema_version: 1,
  repositories: [{ url: REPO_DIR, ref: "main", ecosystem: "python" }],
  filters: {
    changed_lines: { min: 10, max: 300 },
    lockfile_globs: ["**/poetry.lock", "**/requirements*.txt"],
  },
});

let git: Git;
let commits: FixtureCommit[];

beforeAll(async () => {
  commits = await buildFixtureRepo(REPO_DIR);
  git = new Git(REPO_DIR);
});

async function screen(sha: string) {
  const filters = effectiveFilters(CONFIG, CONFIG.repositories[0]!);
  const all = await git.listCommits("main", 100);
  const commit = all.find((c) => c.sha === sha);
  if (!commit) throw new Error(`commit ${sha} not found in the fixture`);

  const meta = screenCommitMetadata(commit, filters);
  if (!meta.eligible) return meta;

  const parent = commit.parents[0]!;
  const entries = await git.diffEntries(parent, commit.sha, filters.rename_similarity);
  const metrics = buildMetrics(entries, filters);
  const diffVerdict = await screenCommitDiff(metrics, filters, () =>
    git.patch(parent, commit.sha, filters.rename_similarity),
  );
  if (!diffVerdict.eligible) return diffVerdict;
  return screenTargetGitignore(git, parent, metrics, filters);
}

function shaOf(role: FixtureCommit["role"]): string {
  const found = commits.find((c) => c.role === role);
  if (!found?.sha) throw new Error(`fixture has no commit with role ${role}`);
  return found.sha;
}

describe("deterministic screening", () => {
  it("rejects the merge commit as a merge, not for its size", async () => {
    const verdict = await screen(shaOf("merge"));
    expect(verdict.eligible).toBe(false);
    expect(verdict.cause).toBe("merge_commit");
  });

  it("rejects the root commit for having no parent", async () => {
    const verdict = await screen(shaOf("root"));
    expect(verdict.eligible).toBe(false);
    expect(verdict.cause).toBe("root_commit");
  });

  it("rejects the binary change as binary, before the size filter sees zero lines", async () => {
    const verdict = await screen(shaOf("binary"));
    expect(verdict.eligible).toBe(false);
    // A binary entry reports "-" lines; reading that as a zero-line change would be wrong.
    expect(verdict.cause).toBe("binary_change");
  });

  it("rejects the oversized commit on changed lines", async () => {
    const verdict = await screen(shaOf("oversized"));
    expect(verdict.eligible).toBe(false);
    expect(verdict.cause).toBe("changed_lines_out_of_range");
    expect(verdict.detail).toContain("409");
  });

  it("rejects the reformatting commit as formatting-only", async () => {
    const verdict = await screen(shaOf("formatting_only"));
    expect(verdict.eligible).toBe(false);
    expect(verdict.cause).toBe("formatting_only");
  });

  it("rejects the lockfile bump as lockfile-only", async () => {
    const verdict = await screen(shaOf("lockfile_only"));
    expect(verdict.eligible).toBe(false);
    expect(verdict.cause).toBe("lockfile_only");
  });

  it("accepts the bugfix, the feature and the refactor", async () => {
    for (const role of ["bugfix", "feature", "refactor"] as const) {
      const verdict = await screen(shaOf(role));
      expect(verdict.eligible, `${role} should survive deterministic screening`).toBe(true);
    }
  });
});

describe("metrics", () => {
  it("counts binary entries separately instead of as zero-line changes", async () => {
    const filters = effectiveFilters(CONFIG, CONFIG.repositories[0]!);
    const sha = shaOf("binary");
    const all = await git.listCommits("main", 100);
    const commit = all.find((c) => c.sha === sha)!;
    const entries = await git.diffEntries(commit.parents[0]!, sha, filters.rename_similarity);
    const metrics = buildMetrics(entries, filters);

    expect(metrics.raw.binary_files).toBe(1);
    expect(metrics.raw.changed_files).toBe(1);
    expect(metrics.files[0]!.is_binary).toBe(true);
    // The line count is zero, which is exactly why it must not be the deciding signal.
    expect(metrics.raw.changed_lines).toBe(0);
  });

  it("keeps raw and filtered metrics separate", async () => {
    const filters = effectiveFilters(
      validateConfig({
        schema_version: 1,
        repositories: [{ url: REPO_DIR }],
        filters: { exclude_path_globs: ["tests/**"] },
      }),
      { url: REPO_DIR, ref: "main", ecosystem: "auto" } as never,
    );
    const sha = shaOf("bugfix");
    const all = await git.listCommits("main", 100);
    const commit = all.find((c) => c.sha === sha)!;
    const entries = await git.diffEntries(commit.parents[0]!, sha, filters.rename_similarity);
    const metrics = buildMetrics(entries, filters);

    expect(metrics.raw.changed_files).toBe(2);
    expect(metrics.filtered.changed_files).toBe(1);
    expect(metrics.filtered.changed_lines).toBeLessThan(metrics.raw.changed_lines);
  });
});

describe("classification", () => {
  it("treats a lockfile as a lockfile and a source file as source", () => {
    const filters = effectiveFilters(CONFIG, CONFIG.repositories[0]!);
    expect(classifyPath("poetry.lock", filters)).toBe("lockfile");
    expect(classifyPath("src/calcstats/stats.py", filters)).toBe("source");
    expect(classifyPath("node_modules/x/index.js", filters)).toBe("vendored");
    expect(classifyPath("dist/bundle.js", filters)).toBe("generated");
  });

  it("detects whitespace-only rewrites but not real edits", () => {
    expect(
      isFormattingOnlyPatch(["-    return a / b", "+    return a/b"].join("\n")),
    ).toBe(true);
    expect(
      isFormattingOnlyPatch(["-    return a / b", "+    return b / a"].join("\n")),
    ).toBe(false);
  });
});

describe("sampling", () => {
  const population = Array.from({ length: 40 }, (_, i) => ({
    repositoryUrl: i % 4 === 0 ? "repo-small" : "repo-large",
    commitSha: `sha${String(i).padStart(3, "0")}`,
  }));
  const sampling = validateConfig({
    schema_version: 1,
    repositories: [{ url: "x" }],
  }).sampling;

  it("is deterministic for the same seed and population", () => {
    const a = sampleCommits(population, sampling, 42, { wanted: 10 });
    const b = sampleCommits(population, sampling, 42, { wanted: 10 });
    expect(a.selected).toEqual(b.selected);
  });

  it("changes with the seed", () => {
    const a = sampleCommits(population, sampling, 42, { wanted: 10 });
    const b = sampleCommits(population, sampling, 43, { wanted: 10 });
    expect(a.selected).not.toEqual(b.selected);
  });

  it("does not depend on the input order", () => {
    const reversed = [...population].reverse();
    const a = sampleCommits(population, sampling, 42, { wanted: 10 });
    const b = sampleCommits(reversed, sampling, 42, { wanted: 10 });
    expect(a.selected).toEqual(b.selected);
  });

  it("never repeats a commit without replacement", () => {
    const result = sampleCommits(population, sampling, 7, { wanted: 40 });
    const keys = result.selected.map((c) => `${c.repositoryUrl}@${c.commitSha}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("balances across repositories under the by-repo strategy", () => {
    const result = sampleCommits(population, sampling, 42, { wanted: 20 });
    const small = result.selected.filter((c) => c.repositoryUrl === "repo-small").length;
    // repo-small holds 10 of 40 commits; balanced draw should give it far more than a flat 25%.
    expect(small).toBeGreaterThan(6);
  });

  it("draws proportionally under the flat strategy", () => {
    const flat = { ...sampling, strategy: "uniform_over_eligible_commits" as const };
    const result = sampleCommits(population, flat, 42, { wanted: 20 });
    const small = result.selected.filter((c) => c.repositoryUrl === "repo-small").length;
    expect(small).toBeLessThan(10);
  });

  it("reports a shortfall instead of padding the count", () => {
    const result = sampleCommits(population.slice(0, 3), sampling, 42, { wanted: 10 });
    expect(result.selected).toHaveLength(3);
    expect(result.deficitReason).toMatch(/drew 3 of 10/);
  });
});
