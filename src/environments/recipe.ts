import { cacheKey, sha256Hex } from "../util/hash.ts";
import type { Git } from "../sources/git.ts";
import type { RepositoryConfig } from "../config/schema.ts";

export type Ecosystem = "python" | "node";

/**
 * A recipe describes how to build the runtime image and how to install and test a revision.
 *
 * Recipes are derived PER REVISION, not per repository: a repository whose runtime, dependency
 * manifests or test configuration changed across history yields different recipes for different
 * commits, and therefore different cache keys and different images.
 */
export interface Recipe {
  ecosystem: Ecosystem;
  baseImage: string;
  architecture: string;
  /** Baked into the image. Runtime + test runner only; never repository code. */
  imageSetupCommands: string[];
  /**
   * Run inside the container after the snapshot is placed, with network access.
   * The resulting container is committed into the task image so the solve phase can run offline.
   */
  installCommands: string[];
  /** Full reference suite. */
  testCommand: string[];
  /** Subset runner; `{tests}` is replaced with space-joined test ids. Null when unsupported. */
  testSelectionCommand: string[] | null;
  /** Path inside the container where the runner writes a JUnit XML report. */
  junitPath: string | null;
  workdir: string;
  env: Record<string, string>;
  /** Dependency manifests found at this revision. Their content hashes key the cache. */
  manifestPaths: string[];
  manifestHashes: Record<string, string>;
  /** Why this recipe was chosen, for the run report. */
  detection: string[];
}

const PYTHON_MANIFESTS = [
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "requirements-dev.txt",
  "requirements/dev.txt",
  "requirements/test.txt",
  "Pipfile",
  "poetry.lock",
  "uv.lock",
  "tox.ini",
  "pytest.ini",
];

const NODE_MANIFESTS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
];

export const DEFAULT_BASE_IMAGES: Record<Ecosystem, string> = {
  python: "python:3.12-slim",
  node: "node:22-bookworm-slim",
};

export const WORKDIR = "/workspace";
export const JUNIT_DIR = "/tmp/forge-report";
export const JUNIT_PATH = `${JUNIT_DIR}/junit.xml`;

export interface DetectOptions {
  git: Git;
  /** Revision whose contents decide the recipe. Always the PARENT of the candidate commit. */
  rev: string;
  repoConfig: RepositoryConfig;
  architecture: string;
}

export class RecipeDetectionError extends Error {
  readonly detection: string[];
  constructor(message: string, detection: string[]) {
    super(message);
    this.name = "RecipeDetectionError";
    this.detection = detection;
  }
}

/**
 * Detect the recipe for a revision.
 *
 * The MVP supports Python (pytest) and JavaScript/TypeScript with a declared test command.
 * Anything else fails loudly with `RecipeDetectionError` instead of pretending to be supported.
 */
export async function detectRecipe(options: DetectOptions): Promise<Recipe> {
  const { git, rev, repoConfig } = options;
  const paths = new Set(await git.listPathsAt(rev));
  const detection: string[] = [];

  const hinted = repoConfig.ecosystem;
  const hasPython = PYTHON_MANIFESTS.some((p) => paths.has(p)) || [...paths].some((p) => p.endsWith(".py"));
  const hasNode = paths.has("package.json");

  let ecosystem: Ecosystem;
  if (hinted !== "auto") {
    ecosystem = hinted;
    detection.push(`ecosystem forced to "${hinted}" by repository config`);
  } else if (hasPython && !hasNode) {
    ecosystem = "python";
    detection.push("python manifests or .py sources present, no package.json");
  } else if (hasNode && !hasPython) {
    ecosystem = "node";
    detection.push("package.json present, no python manifests");
  } else if (hasNode && hasPython) {
    ecosystem = paths.has("pyproject.toml") || paths.has("setup.py") ? "python" : "node";
    detection.push(`mixed repository; chose "${ecosystem}" from the dominant manifest`);
  } else {
    throw new RecipeDetectionError(
      `no supported ecosystem detected at ${rev.slice(0, 12)}: the MVP supports Python with pytest and ` +
        `JavaScript/TypeScript with a declared test command`,
      ["no python manifests or .py files", "no package.json"],
    );
  }

  const manifestNames = ecosystem === "python" ? PYTHON_MANIFESTS : NODE_MANIFESTS;
  const manifestPaths = manifestNames.filter((p) => paths.has(p));
  const manifestHashes: Record<string, string> = {};
  for (const path of manifestPaths) {
    const content = await git.showFile(rev, path);
    if (content) manifestHashes[path] = `sha256:${sha256Hex(content)}`;
  }

  const override = repoConfig.environment;
  const recipe =
    ecosystem === "python"
      ? await pythonRecipe({ paths, manifestPaths, manifestHashes, detection, options })
      : await nodeRecipe({ paths, manifestPaths, manifestHashes, detection, rev, git, options });

  if (override?.base_image) {
    recipe.baseImage = override.base_image;
    recipe.detection.push(`base_image overridden by repository config: ${override.base_image}`);
  }
  if (override?.setup_commands) {
    recipe.installCommands = [...override.setup_commands];
    recipe.detection.push("install commands overridden by repository config");
  }
  if (override?.test_command) {
    recipe.testCommand = [...override.test_command];
    recipe.detection.push("test command overridden by repository config");
  }
  if (override?.test_selection_command) recipe.testSelectionCommand = [...override.test_selection_command];
  if (override?.workdir) recipe.workdir = override.workdir;
  if (override?.env) recipe.env = { ...recipe.env, ...override.env };

  return recipe;
}

interface BuilderContext {
  paths: Set<string>;
  manifestPaths: string[];
  manifestHashes: Record<string, string>;
  detection: string[];
  options: DetectOptions;
}

async function pythonRecipe(ctx: BuilderContext): Promise<Recipe> {
  const { paths, detection } = ctx;
  const install: string[] = [];

  if (paths.has("pyproject.toml") || paths.has("setup.py") || paths.has("setup.cfg")) {
    // `-e .` keeps the source tree authoritative: a solver edit takes effect without reinstalling.
    install.push("python -m pip install --no-cache-dir -e .");
    detection.push("installs the project itself in editable mode");
  }
  for (const req of ["requirements.txt", "requirements-dev.txt", "requirements/dev.txt", "requirements/test.txt"]) {
    if (paths.has(req)) {
      install.push(`python -m pip install --no-cache-dir -r ${req}`);
      detection.push(`installs ${req}`);
    }
  }
  if (install.length === 0) {
    detection.push("no dependency manifest: the repository is installed by path only");
  }

  const hasTests = [...paths].some(
    (p) => /(^|\/)tests?(\/|$)/.test(p) || /(^|\/)test_[^/]*\.py$/.test(p) || /[^/]*_test\.py$/.test(p),
  );
  if (!hasTests) {
    throw new RecipeDetectionError("no pytest-style test files found at this revision", detection);
  }
  detection.push("pytest-style test files present");

  return {
    ecosystem: "python",
    baseImage: DEFAULT_BASE_IMAGES.python,
    architecture: ctx.options.architecture,
    imageSetupCommands: [
      "apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*",
      "python -m pip install --no-cache-dir --upgrade pip",
      "python -m pip install --no-cache-dir pytest==8.3.4",
      `mkdir -p ${JUNIT_DIR} && chmod 777 ${JUNIT_DIR}`,
    ],
    installCommands: install,
    testCommand: ["python", "-m", "pytest", "-p", "no:cacheprovider", "-q", `--junit-xml=${JUNIT_PATH}`],
    testSelectionCommand: [
      "python",
      "-m",
      "pytest",
      "-p",
      "no:cacheprovider",
      "-q",
      `--junit-xml=${JUNIT_PATH}`,
      "{tests}",
    ],
    junitPath: JUNIT_PATH,
    workdir: WORKDIR,
    env: {
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONUNBUFFERED: "1",
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
    },
    manifestPaths: ctx.manifestPaths,
    manifestHashes: ctx.manifestHashes,
    detection,
  };
}

async function nodeRecipe(
  ctx: BuilderContext & { rev: string; git: Git },
): Promise<Recipe> {
  const { paths, detection, git, rev } = ctx;
  const pkgRaw = (await git.showFile(rev, "package.json"))?.toString("utf8") ?? "{}";
  let pkg: { scripts?: Record<string, string> } = {};
  try {
    pkg = JSON.parse(pkgRaw) as typeof pkg;
  } catch {
    throw new RecipeDetectionError("package.json at this revision is not valid JSON", detection);
  }

  const declaredTest = ctx.options.repoConfig.environment?.test_command;
  const testScript = pkg.scripts?.test;
  if (!declaredTest && (!testScript || /no test specified/i.test(testScript))) {
    // The MVP does not guess a test command for JS/TS projects.
    throw new RecipeDetectionError(
      "package.json declares no usable `test` script and the repository config declares no test_command",
      detection,
    );
  }
  detection.push(declaredTest ? "test command declared in repository config" : `npm test -> ${testScript}`);

  const packageManager = paths.has("pnpm-lock.yaml")
    ? "pnpm"
    : paths.has("yarn.lock")
      ? "yarn"
      : "npm";
  const install =
    packageManager === "pnpm"
      ? ["corepack enable pnpm", "pnpm install --frozen-lockfile=false"]
      : packageManager === "yarn"
        ? ["corepack enable yarn", "yarn install"]
        : [paths.has("package-lock.json") ? "npm ci || npm install" : "npm install"];
  detection.push(`package manager: ${packageManager}`);

  return {
    ecosystem: "node",
    baseImage: DEFAULT_BASE_IMAGES.node,
    architecture: ctx.options.architecture,
    imageSetupCommands: [
      "apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*",
      `mkdir -p ${JUNIT_DIR} && chmod 777 ${JUNIT_DIR}`,
    ],
    installCommands: install,
    testCommand: declaredTest ? [...declaredTest] : ["npm", "test", "--silent"],
    testSelectionCommand: ctx.options.repoConfig.environment?.test_selection_command
      ? [...ctx.options.repoConfig.environment.test_selection_command]
      : null,
    // Per-test granularity needs the runner to emit JUnit XML. Without it the pipeline
    // records suite-level results only and says so, instead of inventing per-test outcomes.
    junitPath: null,
    workdir: WORKDIR,
    env: { CI: "1", NODE_ENV: "test" },
    manifestPaths: ctx.manifestPaths,
    manifestHashes: ctx.manifestHashes,
    detection,
  };
}

/**
 * Cache key for the runtime image.
 *
 * Deliberately excludes prompt and generator versions: changing the task generator must not
 * invalidate an otherwise valid image. It DOES include the base image digest so a moved
 * upstream tag produces a different image.
 */
export function imageCacheKey(recipe: Recipe, baseImageDigest: string | null): string {
  return cacheKey("image", {
    ecosystem: recipe.ecosystem,
    base_image: recipe.baseImage,
    base_image_digest: baseImageDigest,
    architecture: recipe.architecture,
    image_setup: recipe.imageSetupCommands,
    env: recipe.env,
    workdir: recipe.workdir,
  });
}

/**
 * Cache key for a fully provisioned task image: runtime image plus the dependency state of one
 * specific revision. Includes repository identity, the install commands and the hashes of every
 * dependency manifest found at that revision.
 */
export function taskImageCacheKey(
  recipe: Recipe,
  repositoryUrl: string,
  rev: string,
  baseImageDigest: string | null,
): string {
  return cacheKey("task-image", {
    image: imageCacheKey(recipe, baseImageDigest),
    repository: repositoryUrl,
    rev,
    install: recipe.installCommands,
    manifests: recipe.manifestHashes,
  });
}

export function recipeId(recipe: Recipe, baseImageDigest: string | null): string {
  return imageCacheKey(recipe, baseImageDigest).replace("image:", "recipe_");
}
