import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Buffer } from "node:buffer";
import { execOk } from "../../src/util/exec.ts";

/**
 * Build the deterministic fixture repository used by the integration tests and by the
 * reproducible walkthrough in the README.
 *
 * Commit dates, author identity and content are fixed, so the repository hashes to the same SHAs
 * on every machine. The history deliberately contains both usable commits and one instance of
 * every rejection class the pipeline must detect.
 */

const AUTHOR = { name: "Fixture Author", email: "fixture@example.invalid" };
const BASE_TIME = Date.parse("2024-03-01T10:00:00Z");

export interface FixtureCommit {
  /** Stable label the tests use to find the commit. */
  label: string;
  message: string;
  /** Why this commit exists: a usable task, or the rejection class it exercises. */
  role:
    | "root"
    | "bugfix"
    | "feature"
    | "refactor"
    | "binary"
    | "oversized"
    | "formatting_only"
    | "lockfile_only"
    | "breaks_baseline"
    | "fixes_baseline"
    | "merge"
    | "ambiguous";
  sha?: string;
}

interface Step {
  commit: FixtureCommit;
  /** path -> contents, or null to delete. */
  files: Record<string, string | Buffer | null>;
  branch?: string;
  mergeFrom?: string;
}

const PYPROJECT = `[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "calcstats"
version = "0.1.0"
description = "Small statistics helpers used as a commit-trace-forge fixture."
requires-python = ">=3.9"

[tool.setuptools.packages.find]
where = ["src"]

[tool.pytest.ini_options]
testpaths = ["tests"]
`;

const GITIGNORE = `__pycache__/
*.pyc
*.egg-info/
.pytest_cache/
build/
dist/
`;

const STATS_V1 = `"""Small statistics helpers."""


def mean(values):
    """Arithmetic mean of a non-empty sequence of numbers."""
    if not values:
        raise ValueError("mean() requires at least one value")
    return sum(values) / len(values)


def percent_change(old, new):
    """Relative change from *old* to *new*, expressed as a percentage."""
    return (new - old) / old * 100.0


def total(values):
    """Sum of a sequence of numbers."""
    return sum(values)
`;

const TESTS_V1 = `from calcstats import mean, percent_change, total

import pytest


def test_mean_of_integers():
    assert mean([1, 2, 3, 4]) == 2.5


def test_mean_rejects_empty_sequence():
    with pytest.raises(ValueError):
        mean([])


def test_percent_change_increase():
    assert percent_change(200.0, 250.0) == pytest.approx(25.0)


def test_percent_change_decrease():
    assert percent_change(200.0, 150.0) == pytest.approx(-25.0)


def test_total_of_floats():
    assert total([0.5, 1.5, 2.0]) == pytest.approx(4.0)
`;

const INIT_V1 = `from .stats import mean, percent_change, total

__all__ = ["mean", "percent_change", "total"]
`;

// ---- c2: bugfix. percent_change must reject a zero base explicitly. --------
const STATS_V2 = `"""Small statistics helpers."""


def mean(values):
    """Arithmetic mean of a non-empty sequence of numbers."""
    if not values:
        raise ValueError("mean() requires at least one value")
    return sum(values) / len(values)


def percent_change(old, new):
    """Relative change from *old* to *new*, expressed as a percentage.

    A zero baseline has no meaningful relative change, so it is rejected with a
    ValueError instead of surfacing a ZeroDivisionError from the arithmetic.
    """
    if old == 0:
        raise ValueError("percent_change() requires a non-zero baseline")
    return (new - old) / old * 100.0


def total(values):
    """Sum of a sequence of numbers."""
    return sum(values)
`;

const TESTS_V2 = `${TESTS_V1}

def test_percent_change_zero_baseline_raises_value_error():
    with pytest.raises(ValueError):
        percent_change(0.0, 10.0)


def test_percent_change_zero_baseline_message_mentions_baseline():
    with pytest.raises(ValueError) as excinfo:
        percent_change(0, 5)
    assert "baseline" in str(excinfo.value)
`;

// ---- c3: feature. median(). ------------------------------------------------
const STATS_V3 = `${STATS_V2}

def median(values):
    """Middle value of a non-empty sequence.

    For an even number of values the mean of the two central values is returned.
    """
    if not values:
        raise ValueError("median() requires at least one value")
    ordered = sorted(values)
    midpoint = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[midpoint]
    return (ordered[midpoint - 1] + ordered[midpoint]) / 2
`;

const INIT_V3 = `from .stats import mean, median, percent_change, total

__all__ = ["mean", "median", "percent_change", "total"]
`;

const TESTS_V3 = `${TESTS_V2}

def test_median_odd_length():
    assert median([5, 1, 3]) == 3


def test_median_even_length():
    assert median([4, 1, 3, 2]) == pytest.approx(2.5)


def test_median_rejects_empty_sequence():
    with pytest.raises(ValueError):
        median([])
`.replace(
  "from calcstats import mean, percent_change, total",
  "from calcstats import mean, median, percent_change, total",
);

// ---- c4: refactor. Shared validation helper, identical behaviour. ----------
const STATS_V4 = `"""Small statistics helpers."""


def _require_values(values, caller):
    """Reject an empty sequence on behalf of *caller*."""
    if not values:
        raise ValueError(caller + "() requires at least one value")
    return values


def mean(values):
    """Arithmetic mean of a non-empty sequence of numbers."""
    _require_values(values, "mean")
    return sum(values) / len(values)


def percent_change(old, new):
    """Relative change from *old* to *new*, expressed as a percentage.

    A zero baseline has no meaningful relative change, so it is rejected with a
    ValueError instead of surfacing a ZeroDivisionError from the arithmetic.
    """
    if old == 0:
        raise ValueError("percent_change() requires a non-zero baseline")
    return (new - old) / old * 100.0


def total(values):
    """Sum of a sequence of numbers."""
    return sum(values)


def median(values):
    """Middle value of a non-empty sequence.

    For an even number of values the mean of the two central values is returned.
    """
    _require_values(values, "median")
    ordered = sorted(values)
    midpoint = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[midpoint]
    return (ordered[midpoint - 1] + ordered[midpoint]) / 2
`;

// ---- rejection fixtures ----------------------------------------------------

/** A deterministic 1x1 PNG. Exercises the binary-change rejection. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Reformatted only: identical tokens once whitespace is removed, so the formatting-only
 * detector must reject it. Deliberately large enough to clear the changed_lines minimum,
 * otherwise the size filter would reject it first and the detector would go untested.
 */
const STATS_V4_REFORMATTED = (
  [
    ["def _require_values(values, caller):", "def _require_values(values,  caller):"],
    [
      'raise ValueError(caller + "() requires at least one value")',
      'raise ValueError(caller+"() requires at least one value")',
    ],
    ["    return sum(values) / len(values)", "    return sum(values)/len(values)"],
    ["    return (new - old) / old * 100.0", "    return (new-old)/old*100.0"],
    ["    ordered = sorted(values)", "    ordered  = sorted(values)"],
    ["    midpoint = len(ordered) // 2", "    midpoint = len(ordered)//2"],
    ["    if len(ordered) % 2 == 1:", "    if len(ordered)%2 == 1:"],
    [
      "    return (ordered[midpoint - 1] + ordered[midpoint]) / 2",
      "    return (ordered[midpoint-1]+ordered[midpoint])/2",
    ],
  ] as Array<[string, string]>
).reduce((text, [from, to]) => text.replace(from, to), STATS_V4);

/**
 * A lockfile the recipe classifies as one but never installs.
 *
 * Deliberately NOT requirements.txt: the python recipe installs requirements*.txt, so pinning
 * versions there would make the fixture depend on those exact versions still existing on PyPI,
 * and every later commit's parent would fail to install for a reason that has nothing to do with
 * the pipeline. poetry.lock matches `lockfile_globs` and is never installed, which is exactly
 * what the lockfile-only filter needs to be exercised.
 */
const LOCKFILE_V1 = `# Generated by the fixture builder. Not installed by the recipe.
[[package]]
name = "pytest"
version = "8.3.4"

[[package]]
name = "iniconfig"
version = "2.0.0"

[[package]]
name = "packaging"
version = "24.0"

[[package]]
name = "pluggy"
version = "1.5.0"

[[package]]
name = "tomli"
version = "2.0.1"

[[package]]
name = "exceptiongroup"
version = "1.2.0"
`;

/** Only lockfile lines move, so the lockfile-only detector must reject this commit. */
const LOCKFILE_V2 = `# Generated by the fixture builder. Not installed by the recipe.
[[package]]
name = "pytest"
version = "8.3.5"

[[package]]
name = "iniconfig"
version = "2.1.0"

[[package]]
name = "packaging"
version = "24.1"

[[package]]
name = "pluggy"
version = "1.6.0"

[[package]]
name = "tomli"
version = "2.1.0"

[[package]]
name = "exceptiongroup"
version = "1.2.2"
`;

function oversizedModule(): string {
  const lines: string[] = ['"""Generated lookup table used to exercise the size filter."""', "", "TABLE = {"];
  for (let i = 0; i < 400; i++) lines.push(`    ${i}: ${i * i},`);
  lines.push("}", "", "", "def square(n):", '    """Look up n squared."""', "    return TABLE[n]", "");
  return lines.join("\n");
}

const BROKEN_TEST = `

def test_total_ignores_none_entries():
    # Known gap: total() should skip None entries. Tracked, not yet implemented.
    assert total([1, None, 2]) == 3


def test_total_ignores_none_entries_with_floats():
    # Same known gap, exercised with floats.
    assert total([0.5, None, 1.5]) == pytest.approx(2.0)


def test_total_of_all_none_entries_is_zero():
    # Same known gap, degenerate case.
    assert total([None, None]) == 0
`;

const STATS_V5_FIXED = `${STATS_V4}

def _drop_missing(values):
    """Remove None entries so callers can pass sparse sequences.

    Callers collect samples from sources that report gaps as None; dropping them here
    keeps total() usable without making every caller pre-filter its own input.
    """
    if values is None:
        return []
    return [value for value in values if value is not None]
`.replace(
  `def total(values):
    """Sum of a sequence of numbers."""
    return sum(values)`,
  `def total(values):
    """Sum of a sequence of numbers, ignoring missing entries."""
    return sum(_drop_missing(values))`,
);

const STEPS: Step[] = [
  {
    commit: { label: "c0_initial", role: "root", message: "Add calcstats with mean, percent_change and total" },
    files: {
      "pyproject.toml": PYPROJECT,
      ".gitignore": GITIGNORE,
      "src/calcstats/__init__.py": INIT_V1,
      "src/calcstats/stats.py": STATS_V1,
      "tests/test_stats.py": TESTS_V1,
      "poetry.lock": LOCKFILE_V1,
    },
  },
  {
    commit: {
      label: "c1_bugfix",
      role: "bugfix",
      message: "Reject a zero baseline in percent_change\n\npercent_change() leaked a ZeroDivisionError when old was 0.",
    },
    files: { "src/calcstats/stats.py": STATS_V2, "tests/test_stats.py": TESTS_V2 },
  },
  {
    commit: { label: "c2_feature", role: "feature", message: "Add median()" },
    files: {
      "src/calcstats/stats.py": STATS_V3,
      "src/calcstats/__init__.py": INIT_V3,
      "tests/test_stats.py": TESTS_V3,
    },
  },
  {
    commit: {
      label: "c3_refactor",
      role: "refactor",
      message: "Extract a shared empty-sequence guard",
    },
    files: { "src/calcstats/stats.py": STATS_V4 },
  },
  {
    commit: { label: "c4_binary", role: "binary", message: "Add project logo" },
    files: { "docs/logo.png": PNG_BYTES },
  },
  {
    commit: { label: "c5_oversized", role: "oversized", message: "Add a precomputed square table" },
    files: { "src/calcstats/table.py": oversizedModule() },
  },
  {
    commit: { label: "c6_formatting", role: "formatting_only", message: "Reformat stats.py" },
    files: { "src/calcstats/stats.py": STATS_V4_REFORMATTED },
  },
  {
    commit: { label: "c7_lockfile", role: "lockfile_only", message: "Bump pinned dependency versions" },
    files: { "poetry.lock": LOCKFILE_V2 },
  },
  {
    commit: {
      label: "c8_breaks_baseline",
      role: "breaks_baseline",
      message: "Add a failing regression test for missing entries in total()",
    },
    // Restores the un-reformatted module so later diffs stay readable.
    files: { "src/calcstats/stats.py": STATS_V4, "tests/test_stats.py": TESTS_V3 + BROKEN_TEST },
  },
  {
    commit: {
      label: "c9_fixes_baseline",
      role: "fixes_baseline",
      message: "Make total() ignore missing entries",
    },
    files: { "src/calcstats/stats.py": STATS_V5_FIXED },
  },
  {
    commit: {
      label: "c10_ambiguous",
      role: "ambiguous",
      message: "Assorted cleanups",
    },
    // Two unrelated intents in one commit plus a vague message: no single coherent request
    // describes it, so task generation must reject it.
    files: {
      "src/calcstats/stats.py": `${STATS_V5_FIXED}

def variance(values):
    """Population variance of a non-empty sequence."""
    _require_values(values, "variance")
    average = mean(values)
    return sum((value - average) ** 2 for value in values) / len(values)
`,
      "README.md": "# calcstats\n\nA few statistics helpers.\n\nInstall with `pip install -e .`.\n",
      "src/calcstats/__init__.py": `from .stats import mean, median, percent_change, total, variance

__all__ = ["mean", "median", "percent_change", "total", "variance"]
`,
      "tests/test_stats.py": `${TESTS_V3 + BROKEN_TEST}

def test_variance_of_constant_sequence():
    assert variance([3, 3, 3]) == 0
`.replace(
        "from calcstats import mean, median, percent_change, total",
        "from calcstats import mean, median, percent_change, total, variance",
      ),
    },
  },
];

async function writeFiles(root: string, files: Step["files"]): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    if (content === null) {
      await rm(full, { force: true });
      continue;
    }
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, typeof content === "string" ? content : content);
  }
}

export async function buildFixtureRepo(targetDir: string): Promise<FixtureCommit[]> {
  const root = resolve(targetDir);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  const git = async (args: string[], extraEnv: Record<string, string> = {}) =>
    execOk(["git", ...args], {
      cwd: root,
      timeoutMs: 120_000,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: AUTHOR.name,
        GIT_AUTHOR_EMAIL: AUTHOR.email,
        GIT_COMMITTER_NAME: AUTHOR.name,
        GIT_COMMITTER_EMAIL: AUTHOR.email,
        GIT_CONFIG_NOSYSTEM: "1",
        HOME: root,
        ...extraEnv,
      },
    });

  await git(["init", "--quiet", "--initial-branch=main"]);
  await git(["config", "core.autocrlf", "false"]);
  await git(["config", "commit.gpgsign", "false"]);

  const built: FixtureCommit[] = [];
  let clock = BASE_TIME;

  for (const step of STEPS) {
    clock += 3_600_000;
    const stamp = new Date(clock).toISOString();
    await writeFiles(root, step.files);
    await git(["add", "-A"]);
    await git(["commit", "--quiet", "--no-verify", "-m", step.commit.message], {
      GIT_AUTHOR_DATE: stamp,
      GIT_COMMITTER_DATE: stamp,
    });
    const sha = (await execOk(["git", "rev-parse", "HEAD"], { cwd: root, timeoutMs: 60_000 })).stdout
      .toString("utf8")
      .trim();
    built.push({ ...step.commit, sha });
  }

  // A merge commit, so the merge filter has something real to reject.
  clock += 3_600_000;
  const branchStamp = new Date(clock).toISOString();
  await git(["checkout", "--quiet", "-b", "sidebranch"]);
  await writeFiles(root, {
    "docs/NOTES.md": "# Notes\n\nScratch notes kept on a side branch.\n",
  });
  await git(["add", "-A"]);
  await git(["commit", "--quiet", "--no-verify", "-m", "Add scratch notes"], {
    GIT_AUTHOR_DATE: branchStamp,
    GIT_COMMITTER_DATE: branchStamp,
  });
  await git(["checkout", "--quiet", "main"]);
  clock += 3_600_000;
  const mergeStamp = new Date(clock).toISOString();
  await git(["merge", "--quiet", "--no-ff", "--no-verify", "-m", "Merge side branch notes", "sidebranch"], {
    GIT_AUTHOR_DATE: mergeStamp,
    GIT_COMMITTER_DATE: mergeStamp,
  });
  const mergeSha = (await execOk(["git", "rev-parse", "HEAD"], { cwd: root, timeoutMs: 60_000 })).stdout
    .toString("utf8")
    .trim();
  built.push({ label: "c11_merge", role: "merge", message: "Merge side branch notes", sha: mergeSha });

  return built;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2] ?? join(process.cwd(), "test", "fixtures", "repo");
  const commits = await buildFixtureRepo(target);
  process.stdout.write(`fixture repository built at ${resolve(target)}\n`);
  for (const commit of commits) {
    process.stdout.write(`  ${commit.sha?.slice(0, 12)}  ${commit.role.padEnd(18)} ${commit.label}\n`);
  }
}
