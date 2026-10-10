import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const DB_SCHEMA_VERSION = 1;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id       TEXT PRIMARY KEY,
  config_hash  TEXT NOT NULL,
  config_json  TEXT NOT NULL,
  seed         TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL,
  deficit_reason TEXT
);

-- Manifest of the population that was examined. Keeping it is what makes a sampling
-- run repeatable even though the upstream repository keeps moving.
CREATE TABLE IF NOT EXISTS population (
  run_id        TEXT NOT NULL,
  repository_url TEXT NOT NULL,
  resolved_sha  TEXT NOT NULL,
  commit_sha    TEXT NOT NULL,
  parent_sha    TEXT,
  author_date   TEXT NOT NULL,
  position      INTEGER NOT NULL,
  eligible      INTEGER NOT NULL,
  reject_cause  TEXT,
  PRIMARY KEY (run_id, repository_url, commit_sha)
);
CREATE INDEX IF NOT EXISTS population_run_idx ON population(run_id, eligible);

CREATE TABLE IF NOT EXISTS candidates (
  candidate_id   TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL,
  repository_url TEXT NOT NULL,
  repository_family TEXT NOT NULL,
  target_sha     TEXT NOT NULL,
  parent_sha     TEXT NOT NULL,
  identity_json  TEXT NOT NULL,
  metrics_json   TEXT NOT NULL,
  selection_order INTEGER NOT NULL,
  status         TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS candidates_run_idx ON candidates(run_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS candidates_commit_idx
  ON candidates(run_id, repository_url, target_sha);

-- Per-stage memoisation. input_hash folds in the implementation version and the prompt
-- version of the stage, so bumping a generator invalidates exactly its dependents.
CREATE TABLE IF NOT EXISTS stage_state (
  candidate_id TEXT NOT NULL,
  stage        TEXT NOT NULL,
  status       TEXT NOT NULL,
  input_hash   TEXT NOT NULL,
  output_json  TEXT,
  error        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  started_at   TEXT,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (candidate_id, stage)
);

CREATE TABLE IF NOT EXISTS rejections (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT NOT NULL,
  candidate_id TEXT,
  stage        TEXT NOT NULL,
  cause        TEXT NOT NULL,
  detail       TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rejections_run_idx ON rejections(run_id, cause);

-- Every model call, successful or not. Cost is NULL when the price is unknown.
CREATE TABLE IF NOT EXISTS usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL,
  candidate_id  TEXT,
  role          TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL,
  cost_known    INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_run_idx ON usage(run_id);

-- Environment image cache, keyed by recipe hash only. Prompt-version changes never
-- invalidate a still-valid image.
CREATE TABLE IF NOT EXISTS images (
  recipe_hash  TEXT PRIMARY KEY,
  image_ref    TEXT NOT NULL,
  image_digest TEXT,
  recipe_json  TEXT NOT NULL,
  backend      TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

-- Every image this tool created, so cleanup removes exactly what it made and nothing else.
CREATE TABLE IF NOT EXISTS run_images (
  image_ref      TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  repository_url TEXT,
  run_id         TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_images_repo_idx ON run_images(repository_url);

CREATE TABLE IF NOT EXISTS samples (
  sample_id    TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  sample_json  TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  split        TEXT,
  accepted     INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS samples_run_idx ON samples(run_id, accepted);

-- LLM-judge verdicts on accepted (teacher) trajectories. Additive: older workspaces gain the
-- table on open without a schema bump.
CREATE TABLE IF NOT EXISTS judgments (
  sample_id     TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  judgment_json TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- Policy rollouts and externally scored trajectories, each with its reward breakdown.
CREATE TABLE IF NOT EXISTS rollouts (
  rollout_id   TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  group_id     TEXT NOT NULL,
  rollout_json TEXT NOT NULL,
  reward       REAL NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rollouts_run_idx ON rollouts(run_id, task_id);
`;

export type StageName =
  | "mine"
  | "prepare"
  | "grade"
  | "generate"
  | "solve"
  | "verify"
  | "replay"
  | "export";

export const STAGE_ORDER: StageName[] = [
  "mine",
  "prepare",
  "grade",
  "generate",
  "solve",
  "verify",
  "replay",
  "export",
];

export interface ForgeDbOptions {
  workspaceDir: string;
}

export class ForgeDb {
  readonly db: DatabaseSync;
  readonly path: string;

  private constructor(db: DatabaseSync, path: string) {
    this.db = db;
    this.path = path;
  }

  static open(options: ForgeDbOptions): ForgeDb {
    const path = join(options.workspaceDir, "forge.sqlite");
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(SCHEMA);
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    if (!row) {
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(
        String(DB_SCHEMA_VERSION),
      );
    } else if (Number(row.value) !== DB_SCHEMA_VERSION) {
      throw new Error(
        `workspace database at ${path} uses schema version ${row.value}, expected ${DB_SCHEMA_VERSION}. ` +
          `Use a fresh workspace directory or migrate manually.`,
      );
    }
    return new ForgeDb(db, path);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* rollback failures must not mask the original error */
      }
      throw error;
    }
  }
}

export function bool(value: boolean): number {
  return value ? 1 : 0;
}

export function fromBool(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}
