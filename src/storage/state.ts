import type { ForgeDb, StageName } from "./db.ts";
import { bool } from "./db.ts";
import type { RejectionCause } from "../util/errors.ts";
import type { CandidateIdentity, CommitMetrics, TokenUsage } from "../types/index.ts";
import { hashObject } from "../util/hash.ts";
import { IMPL_VERSIONS } from "./versions.ts";

export type CandidateStatus =
  | "selected"
  | "prepared"
  | "graded"
  | "generated"
  | "solved"
  | "verified"
  | "accepted"
  | "rejected";

export type StageStatus = "pending" | "running" | "done" | "failed";

export interface StageRecord<T = unknown> {
  status: StageStatus;
  input_hash: string;
  output: T | null;
  error: string | null;
  attempts: number;
}

export interface CandidateRow {
  candidate_id: string;
  run_id: string;
  repository_url: string;
  repository_family: string;
  target_sha: string;
  parent_sha: string;
  identity: CandidateIdentity;
  metrics: CommitMetrics;
  selection_order: number;
  status: CandidateStatus;
}

const now = () => new Date().toISOString();

export class Store {
  private readonly db: ForgeDb;
  readonly runId: string;

  constructor(db: ForgeDb, runId: string) {
    this.db = db;
    this.runId = runId;
  }

  // ---- runs ---------------------------------------------------------------

  static createRun(db: ForgeDb, runId: string, configHash: string, config: unknown, seed: string): void {
    db.db
      .prepare(
        `INSERT INTO runs (run_id, config_hash, config_json, seed, started_at, status)
         VALUES (?, ?, ?, ?, ?, 'running')
         ON CONFLICT(run_id) DO UPDATE SET status='running'`,
      )
      .run(runId, configHash, JSON.stringify(config), seed, now());
  }

  finishRun(status: "completed" | "failed" | "partial", deficitReason?: string): void {
    this.db.db
      .prepare(`UPDATE runs SET status = ?, finished_at = ?, deficit_reason = ? WHERE run_id = ?`)
      .run(status, now(), deficitReason ?? null, this.runId);
  }

  getRun(): { run_id: string; config_hash: string; status: string; started_at: string; seed: string } | undefined {
    return this.db.db
      .prepare(`SELECT run_id, config_hash, status, started_at, seed FROM runs WHERE run_id = ?`)
      .get(this.runId) as never;
  }

  static latestRunId(db: ForgeDb, configHash?: string): string | undefined {
    const row = configHash
      ? (db.db
          .prepare(`SELECT run_id FROM runs WHERE config_hash = ? ORDER BY started_at DESC LIMIT 1`)
          .get(configHash) as { run_id: string } | undefined)
      : (db.db.prepare(`SELECT run_id FROM runs ORDER BY started_at DESC LIMIT 1`).get() as
          | { run_id: string }
          | undefined);
    return row?.run_id;
  }

  /** The most recent run in this workspace that produced at least one accepted sample. */
  static latestRunWithSamples(db: ForgeDb): string | undefined {
    const row = db.db
      .prepare(`SELECT run_id FROM samples WHERE accepted = 1 ORDER BY created_at DESC LIMIT 1`)
      .get() as { run_id: string } | undefined;
    return row?.run_id;
  }

  static runExists(db: ForgeDb, runId: string): boolean {
    return db.db.prepare(`SELECT 1 FROM runs WHERE run_id = ?`).get(runId) !== undefined;
  }

  static hasAcceptedSamples(db: ForgeDb, runId: string): boolean {
    return db.db.prepare(`SELECT 1 FROM samples WHERE run_id = ? AND accepted = 1 LIMIT 1`).get(runId) !== undefined;
  }

  // ---- population ---------------------------------------------------------

  recordPopulation(
    rows: ReadonlyArray<{
      repository_url: string;
      resolved_sha: string;
      commit_sha: string;
      parent_sha: string | null;
      author_date: string;
      position: number;
      eligible: boolean;
      reject_cause: RejectionCause | null;
    }>,
  ): void {
    const stmt = this.db.db.prepare(
      `INSERT INTO population
        (run_id, repository_url, resolved_sha, commit_sha, parent_sha, author_date, position, eligible, reject_cause)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, repository_url, commit_sha) DO UPDATE SET
         eligible = excluded.eligible, reject_cause = excluded.reject_cause, position = excluded.position`,
    );
    this.db.transaction(() => {
      for (const r of rows) {
        stmt.run(
          this.runId,
          r.repository_url,
          r.resolved_sha,
          r.commit_sha,
          r.parent_sha,
          r.author_date,
          r.position,
          bool(r.eligible),
          r.reject_cause,
        );
      }
    });
  }

  populationStats(): Array<{ repository_url: string; examined: number; eligible: number }> {
    return this.db.db
      .prepare(
        `SELECT repository_url, COUNT(*) AS examined, SUM(eligible) AS eligible
         FROM population WHERE run_id = ? GROUP BY repository_url ORDER BY repository_url`,
      )
      .all(this.runId) as never;
  }

  // ---- candidates ---------------------------------------------------------

  /**
   * Record a drawn candidate for this run.
   *
   * Candidate ids are content-derived (repository + commit), so stage memoisation carries across
   * runs. A commit drawn again by a later run moves to that run, with the new draw order and
   * status; its unchanged stages are then reused from the cache rather than recomputed.
   */
  upsertCandidate(row: Omit<CandidateRow, "run_id">): void {
    this.db.db
      .prepare(
        `INSERT INTO candidates
          (candidate_id, run_id, repository_url, repository_family, target_sha, parent_sha,
           identity_json, metrics_json, selection_order, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(candidate_id) DO UPDATE SET
           run_id = excluded.run_id, selection_order = excluded.selection_order,
           status = excluded.status, updated_at = excluded.updated_at`,
      )
      .run(
        row.candidate_id,
        this.runId,
        row.repository_url,
        row.repository_family,
        row.target_sha,
        row.parent_sha,
        JSON.stringify(row.identity),
        JSON.stringify(row.metrics),
        row.selection_order,
        row.status,
        now(),
        now(),
      );
  }

  setCandidateStatus(candidateId: string, status: CandidateStatus): void {
    this.db.db
      .prepare(`UPDATE candidates SET status = ?, updated_at = ? WHERE candidate_id = ?`)
      .run(status, now(), candidateId);
  }

  listCandidates(statuses?: readonly CandidateStatus[]): CandidateRow[] {
    const sql = statuses?.length
      ? `SELECT * FROM candidates WHERE run_id = ? AND status IN (${statuses.map(() => "?").join(",")})
         ORDER BY selection_order`
      : `SELECT * FROM candidates WHERE run_id = ? ORDER BY selection_order`;
    const rows = this.db.db.prepare(sql).all(this.runId, ...(statuses ?? [])) as Array<
      Record<string, unknown>
    >;
    return rows.map(hydrateCandidate);
  }

  getCandidate(candidateId: string): CandidateRow | undefined {
    const row = this.db.db
      .prepare(`SELECT * FROM candidates WHERE candidate_id = ?`)
      .get(candidateId) as Record<string, unknown> | undefined;
    return row ? hydrateCandidate(row) : undefined;
  }

  // ---- stage state --------------------------------------------------------

  /**
   * Compute the input hash for a stage. Folding in the implementation version and any prompt
   * version means a changed generator invalidates its own cached output and everything
   * downstream that consumes it, without touching unrelated caches.
   */
  stageInputHash(stage: StageName, inputs: Record<string, unknown>): string {
    return hashObject({ stage, impl: IMPL_VERSIONS[stage], inputs });
  }

  getStage<T>(candidateId: string, stage: StageName): StageRecord<T> | undefined {
    const row = this.db.db
      .prepare(`SELECT * FROM stage_state WHERE candidate_id = ? AND stage = ?`)
      .get(candidateId, stage) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      status: row.status as StageStatus,
      input_hash: row.input_hash as string,
      output: row.output_json ? (JSON.parse(row.output_json as string) as T) : null,
      error: (row.error as string | null) ?? null,
      attempts: Number(row.attempts ?? 0),
    };
  }

  /** Returns a cached output only when the stage completed with a matching input hash. */
  getCachedStageOutput<T>(candidateId: string, stage: StageName, inputHash: string): T | undefined {
    const record = this.getStage<T>(candidateId, stage);
    if (!record) return undefined;
    if (record.status !== "done") return undefined;
    if (record.input_hash !== inputHash) return undefined;
    return record.output ?? undefined;
  }

  beginStage(candidateId: string, stage: StageName, inputHash: string): void {
    this.db.db
      .prepare(
        `INSERT INTO stage_state (candidate_id, stage, status, input_hash, attempts, started_at, updated_at)
         VALUES (?, ?, 'running', ?, 1, ?, ?)
         ON CONFLICT(candidate_id, stage) DO UPDATE SET
           status = 'running',
           input_hash = excluded.input_hash,
           attempts = stage_state.attempts + 1,
           started_at = excluded.started_at,
           updated_at = excluded.updated_at,
           error = NULL`,
      )
      .run(candidateId, stage, inputHash, now(), now());
  }

  completeStage(candidateId: string, stage: StageName, inputHash: string, output: unknown): void {
    this.db.db
      .prepare(
        `INSERT INTO stage_state (candidate_id, stage, status, input_hash, output_json, attempts, updated_at)
         VALUES (?, ?, 'done', ?, ?, 1, ?)
         ON CONFLICT(candidate_id, stage) DO UPDATE SET
           status = 'done', input_hash = excluded.input_hash,
           output_json = excluded.output_json, error = NULL, updated_at = excluded.updated_at`,
      )
      .run(candidateId, stage, inputHash, JSON.stringify(output ?? null), now());
  }

  failStage(candidateId: string, stage: StageName, inputHash: string, error: string): void {
    this.db.db
      .prepare(
        `INSERT INTO stage_state (candidate_id, stage, status, input_hash, error, attempts, updated_at)
         VALUES (?, ?, 'failed', ?, ?, 1, ?)
         ON CONFLICT(candidate_id, stage) DO UPDATE SET
           status = 'failed', input_hash = excluded.input_hash,
           error = excluded.error, updated_at = excluded.updated_at`,
      )
      .run(candidateId, stage, inputHash, error, now());
  }

  /** Stages left in `running` by a crash. Resume treats them as retryable, never as done. */
  resetStaleRunningStages(): number {
    const result = this.db.db
      .prepare(
        `UPDATE stage_state SET status = 'failed', error = COALESCE(error, 'interrupted: process exited while stage was running')
         WHERE status = 'running' AND candidate_id IN (SELECT candidate_id FROM candidates WHERE run_id = ?)`,
      )
      .run(this.runId);
    return Number(result.changes ?? 0);
  }

  // ---- rejections ---------------------------------------------------------

  reject(candidateId: string | null, stage: StageName, cause: RejectionCause, detail = ""): void {
    this.db.db
      .prepare(
        `INSERT INTO rejections (run_id, candidate_id, stage, cause, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(this.runId, candidateId, stage, cause, detail, now());
    if (candidateId) this.setCandidateStatus(candidateId, "rejected");
  }

  rejectionCounts(): Array<{ stage: string; cause: string; count: number }> {
    return this.db.db
      .prepare(
        `SELECT stage, cause, COUNT(*) AS count FROM rejections WHERE run_id = ?
         GROUP BY stage, cause ORDER BY count DESC`,
      )
      .all(this.runId) as never;
  }

  rejectionsFor(candidateId: string): Array<{ stage: string; cause: string; detail: string }> {
    return this.db.db
      .prepare(`SELECT stage, cause, detail FROM rejections WHERE candidate_id = ? ORDER BY id`)
      .all(candidateId) as never;
  }

  // ---- usage / budget -----------------------------------------------------

  recordUsage(
    candidateId: string | null,
    role: string,
    model: string,
    usage: TokenUsage,
    durationMs: number,
  ): void {
    this.db.db
      .prepare(
        `INSERT INTO usage (run_id, candidate_id, role, model, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, cost_usd, cost_known, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.runId,
        candidateId,
        role,
        model,
        usage.input_tokens,
        usage.output_tokens,
        usage.cache_read_tokens,
        usage.cache_write_tokens,
        usage.cost_usd,
        bool(usage.cost_known),
        durationMs,
        now(),
      );
  }

  totals(): {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cost_usd: number;
    calls: number;
    calls_with_unknown_cost: number;
  } {
    const row = this.db.db
      .prepare(
        `SELECT
           COALESCE(SUM(input_tokens),0)  AS input_tokens,
           COALESCE(SUM(output_tokens),0) AS output_tokens,
           COALESCE(SUM(CASE WHEN cost_known = 1 THEN cost_usd ELSE 0 END),0) AS cost_usd,
           COUNT(*) AS calls,
           COALESCE(SUM(CASE WHEN cost_known = 0 THEN 1 ELSE 0 END),0) AS calls_with_unknown_cost
         FROM usage WHERE run_id = ?`,
      )
      .get(this.runId) as Record<string, number>;
    const input = Number(row.input_tokens ?? 0);
    const output = Number(row.output_tokens ?? 0);
    return {
      input_tokens: input,
      output_tokens: output,
      total_tokens: input + output,
      cost_usd: Number(row.cost_usd ?? 0),
      calls: Number(row.calls ?? 0),
      calls_with_unknown_cost: Number(row.calls_with_unknown_cost ?? 0),
    };
  }

  usageByRole(): Array<{ role: string; calls: number; total_tokens: number; cost_usd: number; unknown_cost: number }> {
    return this.db.db
      .prepare(
        `SELECT role, COUNT(*) AS calls,
                COALESCE(SUM(input_tokens + output_tokens),0) AS total_tokens,
                COALESCE(SUM(CASE WHEN cost_known = 1 THEN cost_usd ELSE 0 END),0) AS cost_usd,
                COALESCE(SUM(CASE WHEN cost_known = 0 THEN 1 ELSE 0 END),0) AS unknown_cost
         FROM usage WHERE run_id = ? GROUP BY role ORDER BY total_tokens DESC`,
      )
      .all(this.runId) as never;
  }

  // ---- images -------------------------------------------------------------

  getImage(recipeHash: string): { image_ref: string; image_digest: string | null } | undefined {
    return this.db.db
      .prepare(`SELECT image_ref, image_digest FROM images WHERE recipe_hash = ?`)
      .get(recipeHash) as never;
  }

  putImage(recipeHash: string, imageRef: string, digest: string | null, recipe: unknown, backend: string): void {
    this.db.db
      .prepare(
        `INSERT INTO images (recipe_hash, image_ref, image_digest, recipe_json, backend, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(recipe_hash) DO UPDATE SET
           image_ref = excluded.image_ref, image_digest = excluded.image_digest`,
      )
      .run(recipeHash, imageRef, digest, JSON.stringify(recipe), backend, now());
  }

  // ---- image bookkeeping for cleanup --------------------------------------

  /**
   * Record an image this tool built, so cleanup removes exactly what the run created.
   *
   * Scoping removal to this table is what keeps an unrelated image on the same daemon safe.
   */
  recordRunImage(imageRef: string, kind: "runtime" | "task" | "base", repositoryUrl: string | null): void {
    this.db.db
      .prepare(
        `INSERT INTO run_images (image_ref, kind, repository_url, run_id, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(image_ref) DO UPDATE SET repository_url = COALESCE(run_images.repository_url, excluded.repository_url)`,
      )
      .run(imageRef, kind, repositoryUrl, this.runId, now());
  }

  listRunImages(kind: "runtime" | "task" | "base", repositoryUrl?: string): string[] {
    const rows = repositoryUrl
      ? (this.db.db
          .prepare(`SELECT image_ref FROM run_images WHERE kind = ? AND repository_url = ?`)
          .all(kind, repositoryUrl) as Array<{ image_ref: string }>)
      : (this.db.db.prepare(`SELECT image_ref FROM run_images WHERE kind = ?`).all(kind) as Array<{
          image_ref: string;
        }>);
    return rows.map((r) => r.image_ref);
  }

  forgetRunImage(imageRef: string): void {
    this.db.db.prepare(`DELETE FROM run_images WHERE image_ref = ?`).run(imageRef);
  }

  repositoriesWithImages(): string[] {
    const rows = this.db.db
      .prepare(`SELECT DISTINCT repository_url FROM run_images WHERE repository_url IS NOT NULL`)
      .all() as Array<{ repository_url: string }>;
    return rows.map((r) => r.repository_url);
  }

  /** Drop the runtime image cache. Called when those images have actually been removed. */
  clearImageCache(): void {
    this.db.db.prepare(`DELETE FROM images`).run();
  }

  /** Mirror clone directory recorded for a repository, if the run created one. */
  mirrorDirFor(repositoryUrl: string): string | null {
    const row = this.db.db
      .prepare(`SELECT value FROM meta WHERE key = ?`)
      .get(`mirror:${repositoryUrl}`) as { value: string } | undefined;
    return row?.value ?? null;
  }

  recordMirrorDir(repositoryUrl: string, dir: string): void {
    this.db.db
      .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(`mirror:${repositoryUrl}`, dir);
  }

  /** Artifact hashes of stored workspace snapshots, the largest artifact class. */
  listSolutionSnapshots(): string[] {
    const rows = this.db.db
      .prepare(`SELECT output_json FROM stage_state WHERE stage = 'solve' AND output_json IS NOT NULL`)
      .all() as Array<{ output_json: string }>;
    const hashes: string[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.output_json) as { solutionArchiveArtifact?: string | null };
        if (parsed.solutionArchiveArtifact) hashes.push(parsed.solutionArchiveArtifact);
      } catch {
        /* a malformed row is not a reason to delete something */
      }
    }
    return [...new Set(hashes)];
  }

  // ---- samples ------------------------------------------------------------

  putSample(
    sampleId: string,
    candidateId: string,
    sample: unknown,
    manifest: unknown,
    accepted: boolean,
    split: string | null,
  ): void {
    this.db.db
      .prepare(
        `INSERT INTO samples (sample_id, run_id, candidate_id, sample_json, manifest_json, split, accepted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sample_id) DO UPDATE SET
           sample_json = excluded.sample_json, manifest_json = excluded.manifest_json,
           split = excluded.split, accepted = excluded.accepted`,
      )
      .run(
        sampleId,
        this.runId,
        candidateId,
        JSON.stringify(sample),
        JSON.stringify(manifest),
        split,
        bool(accepted),
        now(),
      );
  }

  setSampleSplit(sampleId: string, split: string): void {
    this.db.db.prepare(`UPDATE samples SET split = ? WHERE sample_id = ?`).run(split, sampleId);
  }

  listSamples(acceptedOnly = true): Array<{
    sample_id: string;
    candidate_id: string;
    sample: unknown;
    manifest: unknown;
    split: string | null;
  }> {
    const sql = acceptedOnly
      ? `SELECT sample_id, candidate_id, sample_json, manifest_json, split FROM samples WHERE run_id = ? AND accepted = 1 ORDER BY created_at`
      : `SELECT sample_id, candidate_id, sample_json, manifest_json, split FROM samples WHERE run_id = ? ORDER BY created_at`;
    const rows = this.db.db.prepare(sql).all(this.runId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      sample_id: r.sample_id as string,
      candidate_id: r.candidate_id as string,
      sample: JSON.parse(r.sample_json as string),
      manifest: JSON.parse(r.manifest_json as string),
      split: (r.split as string | null) ?? null,
    }));
  }

  // ---- judgments and rollouts --------------------------------------------

  putJudgment(sampleId: string, judgment: unknown): void {
    this.db.db
      .prepare(
        `INSERT INTO judgments (sample_id, run_id, judgment_json, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(sample_id) DO UPDATE SET judgment_json = excluded.judgment_json, created_at = excluded.created_at`,
      )
      .run(sampleId, this.runId, JSON.stringify(judgment), now());
  }

  listJudgments(): Map<string, unknown> {
    const rows = this.db.db
      .prepare(`SELECT sample_id, judgment_json FROM judgments WHERE run_id = ?`)
      .all(this.runId) as Array<{ sample_id: string; judgment_json: string }>;
    return new Map(rows.map((r) => [r.sample_id, JSON.parse(r.judgment_json) as unknown]));
  }

  putRollout(rolloutId: string, taskId: string, groupId: string, rollout: unknown, reward: number): void {
    this.db.db
      .prepare(
        `INSERT INTO rollouts (rollout_id, run_id, task_id, group_id, rollout_json, reward, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(rollout_id) DO UPDATE SET rollout_json = excluded.rollout_json, reward = excluded.reward`,
      )
      .run(rolloutId, this.runId, taskId, groupId, JSON.stringify(rollout), reward, now());
  }

  listRollouts(): unknown[] {
    const rows = this.db.db
      .prepare(`SELECT rollout_json FROM rollouts WHERE run_id = ? ORDER BY task_id, created_at`)
      .all(this.runId) as Array<{ rollout_json: string }>;
    return rows.map((r) => JSON.parse(r.rollout_json) as unknown);
  }

  countAccepted(): number {
    const row = this.db.db
      .prepare(`SELECT COUNT(*) AS n FROM samples WHERE run_id = ? AND accepted = 1`)
      .get(this.runId) as { n: number };
    return Number(row.n ?? 0);
  }
}

function hydrateCandidate(row: Record<string, unknown>): CandidateRow {
  return {
    candidate_id: row.candidate_id as string,
    run_id: row.run_id as string,
    repository_url: row.repository_url as string,
    repository_family: row.repository_family as string,
    target_sha: row.target_sha as string,
    parent_sha: row.parent_sha as string,
    identity: JSON.parse(row.identity_json as string) as CandidateIdentity,
    metrics: JSON.parse(row.metrics_json as string) as CommitMetrics,
    selection_order: Number(row.selection_order),
    status: row.status as CandidateStatus,
  };
}
