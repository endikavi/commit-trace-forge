import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeDb } from "../../src/storage/db.ts";
import { Store } from "../../src/storage/state.ts";
import { ArtifactStore } from "../../src/storage/artifacts.ts";
import type { CandidateIdentity, CommitMetrics, TokenUsage } from "../../src/types/index.ts";

/**
 * Persistence, resumption and budget accounting.
 *
 * The property that matters most here: a run interrupted mid-stage must not come back believing
 * that stage succeeded, and failed attempts must survive so the report can account for them.
 */

let workspace = "";
let db: ForgeDb;
let store: Store;

const identity: CandidateIdentity = {
  candidate_id: "cand_1",
  repository_url: "https://example.invalid/r.git",
  repository_family: "r",
  resolved_ref_sha: "a".repeat(40),
  target_sha: "b".repeat(40),
  parent_sha: "c".repeat(40),
  target_tree_sha: "d".repeat(40),
  parent_tree_sha: "e".repeat(40),
  author_date: "2024-01-01T00:00:00Z",
  committer_date: "2024-01-01T00:00:00Z",
  subject: "reserved subject",
};

const metrics: CommitMetrics = {
  raw: { added_lines: 10, deleted_lines: 2, changed_lines: 12, changed_files: 1, binary_files: 0, submodule_entries: 0 },
  filtered: { added_lines: 10, deleted_lines: 2, changed_lines: 12, changed_files: 1 },
  files: [],
};

const usage = (cost: number | null): TokenUsage => ({
  input_tokens: 100,
  output_tokens: 50,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cost_usd: cost,
  cost_known: cost !== null,
});

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "forge-state-"));
  db = ForgeDb.open({ workspaceDir: workspace });
  Store.createRun(db, "run_1", "confighash", { schema_version: 1 }, "42");
  store = new Store(db, "run_1");
  store.upsertCandidate({
    candidate_id: identity.candidate_id,
    repository_url: identity.repository_url,
    repository_family: identity.repository_family,
    target_sha: identity.target_sha,
    parent_sha: identity.parent_sha,
    identity,
    metrics,
    selection_order: 0,
    status: "selected",
  });
});

afterEach(async () => {
  db.close();
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
});

describe("stage caching", () => {
  it("returns a cached output only for a matching input hash", () => {
    const hash = store.stageInputHash("grade", { a: 1 });
    store.completeStage("cand_1", "grade", hash, { score: 91 });

    expect(store.getCachedStageOutput("cand_1", "grade", hash)).toEqual({ score: 91 });
    // A changed input, such as a bumped prompt version, invalidates it.
    expect(store.getCachedStageOutput("cand_1", "grade", store.stageInputHash("grade", { a: 2 }))).toBeUndefined();
  });

  it("never serves a cached output for a failed stage", () => {
    const hash = store.stageInputHash("grade", { a: 1 });
    store.failStage("cand_1", "grade", hash, "the model returned nonsense");
    expect(store.getCachedStageOutput("cand_1", "grade", hash)).toBeUndefined();
    expect(store.getStage("cand_1", "grade")?.error).toContain("nonsense");
  });

  it("counts attempts across retries", () => {
    const hash = store.stageInputHash("solve", { a: 1 });
    store.beginStage("cand_1", "solve", hash);
    store.beginStage("cand_1", "solve", hash);
    store.beginStage("cand_1", "solve", hash);
    expect(store.getStage("cand_1", "solve")?.attempts).toBe(3);
  });
});

describe("resumption", () => {
  it("does not treat an interrupted stage as done", () => {
    const hash = store.stageInputHash("solve", { a: 1 });
    store.beginStage("cand_1", "solve", hash);
    expect(store.getStage("cand_1", "solve")?.status).toBe("running");

    // Simulate the process dying here and a later `--resume`.
    const reset = store.resetStaleRunningStages();
    expect(reset).toBe(1);

    const after = store.getStage("cand_1", "solve");
    expect(after?.status).toBe("failed");
    expect(after?.error).toContain("interrupted");
    expect(store.getCachedStageOutput("cand_1", "solve", hash)).toBeUndefined();
  });

  it("keeps rejections and their causes across a reopen", () => {
    store.reject("cand_1", "verify", "verify_replay_divergence", "the final tree diverged");
    db.close();

    const reopened = ForgeDb.open({ workspaceDir: workspace });
    const store2 = new Store(reopened, "run_1");
    const counts = store2.rejectionCounts();
    expect(counts).toContainEqual({ stage: "verify", cause: "verify_replay_divergence", count: 1 });
    expect(store2.rejectionsFor("cand_1")[0]?.detail).toContain("diverged");
    reopened.close();
    db = ForgeDb.open({ workspaceDir: workspace });
  });

  it("finds the most recent run for a configuration", () => {
    expect(Store.latestRunId(db, "confighash")).toBe("run_1");
    expect(Store.latestRunId(db, "other")).toBeUndefined();
  });
});

describe("budget ledger", () => {
  it("sums tokens across every call, successful or not", () => {
    store.recordUsage("cand_1", "grader", "p/m", usage(0.01), 100);
    store.recordUsage("cand_1", "solver", "p/m", usage(0.02), 100);
    const totals = store.totals();
    expect(totals.total_tokens).toBe(300);
    expect(totals.calls).toBe(2);
    expect(totals.cost_usd).toBeCloseTo(0.03, 6);
  });

  it("does not charge calls whose price is unknown, and counts them", () => {
    store.recordUsage("cand_1", "grader", "priced/m", usage(0.05), 100);
    store.recordUsage("cand_1", "solver", "unpriced/m", usage(null), 100);

    const totals = store.totals();
    // The unknown-price call contributes tokens but never a guessed dollar amount.
    expect(totals.total_tokens).toBe(300);
    expect(totals.cost_usd).toBeCloseTo(0.05, 6);
    expect(totals.calls_with_unknown_cost).toBe(1);
  });

  it("breaks usage down by role", () => {
    store.recordUsage("cand_1", "solver", "p/m", usage(0.02), 100);
    store.recordUsage("cand_1", "solver", "p/m", usage(0.02), 100);
    store.recordUsage("cand_1", "grader", "p/m", usage(0.01), 100);
    const byRole = store.usageByRole();
    expect(byRole.find((r) => r.role === "solver")?.calls).toBe(2);
    expect(byRole.find((r) => r.role === "grader")?.calls).toBe(1);
  });
});

describe("image bookkeeping for cleanup", () => {
  it("tracks images per repository so only that repository's images are reclaimed", () => {
    store.recordRunImage("forge-task:aaa", "task", "https://example.invalid/a.git");
    store.recordRunImage("forge-task:bbb", "task", "https://example.invalid/b.git");
    store.recordRunImage("forge-runtime:shared", "runtime", null);

    expect(store.listRunImages("task", "https://example.invalid/a.git")).toEqual(["forge-task:aaa"]);
    expect(store.listRunImages("task").sort()).toEqual(["forge-task:aaa", "forge-task:bbb"]);
    expect(store.listRunImages("runtime")).toEqual(["forge-runtime:shared"]);
  });

  it("forgets an image once it has been removed", () => {
    store.recordRunImage("forge-task:aaa", "task", "u");
    store.forgetRunImage("forge-task:aaa");
    expect(store.listRunImages("task")).toEqual([]);
  });

  it("finds the solution snapshots a run stored", () => {
    const hash = store.stageInputHash("solve", {});
    store.completeStage("cand_1", "solve", hash, {
      solutionArchiveArtifact: "sha256:" + "a".repeat(64),
      attempts: [],
    });
    expect(store.listSolutionSnapshots()).toEqual(["sha256:" + "a".repeat(64)]);
  });

  it("remembers where a mirror clone lives", () => {
    store.recordMirrorDir("https://example.invalid/r.git", "/workspace/repos/r-abc");
    expect(store.mirrorDirFor("https://example.invalid/r.git")).toBe("/workspace/repos/r-abc");
    expect(store.mirrorDirFor("https://example.invalid/unknown.git")).toBeNull();
  });
});

describe("artifact store", () => {
  it("is content-addressed and idempotent", async () => {
    const artifacts = new ArtifactStore(workspace);
    const a = await artifacts.put("identical content");
    const b = await artifacts.put("identical content");
    expect(a).toBe(b);
    expect(await artifacts.getText(a)).toBe("identical content");
  });

  it("rejects an id that is not a sha256", async () => {
    const artifacts = new ArtifactStore(workspace);
    await expect(artifacts.get("not-a-hash")).rejects.toThrow(/not a sha256/);
  });
});

describe("candidates across runs", () => {
  it("moves a commit drawn again by a later run into that run, keeping its stage cache", () => {
    const hash = store.stageInputHash("prepare", { a: 1 });
    store.completeStage("cand_1", "prepare", hash, { ok: true });
    store.setCandidateStatus("cand_1", "accepted");

    Store.createRun(db, "run_2", "confighash", { schema_version: 1 }, "42");
    const second = new Store(db, "run_2");
    second.upsertCandidate({
      candidate_id: identity.candidate_id,
      repository_url: identity.repository_url,
      repository_family: identity.repository_family,
      target_sha: identity.target_sha,
      parent_sha: identity.parent_sha,
      identity,
      metrics,
      selection_order: 3,
      status: "selected",
    });

    const drawn = second.listCandidates(["selected"]);
    expect(drawn.map((c) => c.candidate_id)).toEqual(["cand_1"]);
    expect(drawn[0]?.selection_order).toBe(3);
    expect(second.getCachedStageOutput("cand_1", "prepare", hash)).toEqual({ ok: true });
  });
});
