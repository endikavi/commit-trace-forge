import { describe, expect, it } from "vitest";
import { buildDedupKeys, findDuplicates, normalizePatch, taskSimilarityKey } from "../../src/dataset/dedupe.ts";
import { assignSplits, crossSplitLeaks } from "../../src/dataset/splits.ts";
import { scanText, redactText } from "../../src/dataset/secrets.ts";
import { toConversation } from "../../src/dataset/export.ts";
import { validateConfig } from "../../src/config/load.ts";
import { extractDecisionSummaries } from "../../src/harness/recorder.ts";
import { extractJsonObject } from "../../src/util/json.ts";
import { detectLeaks } from "../../src/taskgen/leak.ts";
import type { Sample, TaskSpec } from "../../src/types/index.ts";

const EXPORT_CONFIG = validateConfig({ schema_version: 1, repositories: [{ url: "x" }] }).export;

describe("patch normalisation and dedup", () => {
  const original = `diff --git a/src/a.py b/src/a.py
index 1111111..2222222 100644
--- a/src/a.py
+++ b/src/a.py
@@ -10,7 +10,7 @@ def f():
     context line
-    return a / b
+    return safe_div(a, b)
     more context
`;
  // The same change after a rebase: different hunk offsets, different blob ids, same edit.
  const rebased = original.replace("index 1111111..2222222", "index 3333333..4444444").replace("@@ -10,7 +10,7 @@ def f():", "@@ -42,7 +42,7 @@ def f():");

  it("hashes a cherry-picked patch identically", () => {
    expect(normalizePatch(original)).toBe(normalizePatch(rebased));
  });

  it("does not collapse a genuinely different change", () => {
    const different = original.replace("return safe_div(a, b)", "return a // b");
    expect(normalizePatch(original)).not.toBe(normalizePatch(different));
  });

  it("flags the second occurrence, keeping the first", () => {
    const keys = (patch: string, prompt: string) =>
      buildDedupKeys({
        repositoryUrl: "https://example.invalid/r.git",
        targetSha: patch === original ? "aaa" : "bbb",
        repositoryFamily: "r",
        patch,
        userPrompt: prompt,
        acceptanceCriteria: ["criterion"],
      });

    const found = findDuplicates([
      { sampleId: "first", keys: keys(original, "Please guard division by zero in the helper") },
      { sampleId: "second", keys: keys(rebased, "Something completely unrelated about parsing") },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ sampleId: "second", duplicateOf: "first", reason: "normalized_patch" });
  });

  it("collapses re-phrasings of the same request", () => {
    const a = taskSimilarityKey("Please make percent_change reject a zero baseline", ["raises ValueError"]);
    const b = taskSimilarityKey("percent_change should reject a baseline of zero, please", ["ValueError raised"]);
    expect(a).toBe(b);
  });

  it("keeps genuinely different requests apart", () => {
    const a = taskSimilarityKey("percent_change should reject a zero baseline", ["raises ValueError"]);
    const b = taskSimilarityKey("median should handle even-length sequences", ["returns the midpoint"]);
    expect(a).not.toBe(b);
  });
});

describe("splits", () => {
  const samples = [
    ...Array.from({ length: 8 }, (_, i) => ({ sampleId: `a${i}`, repositoryFamily: "alpha", repositoryUrl: "u/alpha" })),
    ...Array.from({ length: 3 }, (_, i) => ({ sampleId: `b${i}`, repositoryFamily: "beta", repositoryUrl: "u/beta" })),
    ...Array.from({ length: 2 }, (_, i) => ({ sampleId: `c${i}`, repositoryFamily: "gamma", repositoryUrl: "u/gamma" })),
  ];

  it("never splits a repository family across splits", () => {
    const summary = assignSplits(samples, EXPORT_CONFIG, 42);
    expect(crossSplitLeaks(summary.assignments)).toEqual([]);
  });

  it("keeps every variant of one family together", () => {
    const summary = assignSplits(samples, EXPORT_CONFIG, 42);
    const alphaSplits = new Set(summary.assignments.filter((a) => a.group === "alpha").map((a) => a.split));
    expect(alphaSplits.size).toBe(1);
  });

  it("is deterministic", () => {
    expect(assignSplits(samples, EXPORT_CONFIG, 42).assignments).toEqual(
      assignSplits(samples, EXPORT_CONFIG, 42).assignments,
    );
  });

  it("assigns every sample", () => {
    const summary = assignSplits(samples, EXPORT_CONFIG, 42);
    expect(summary.assignments).toHaveLength(samples.length);
    expect(summary.counts.train + summary.counts.validation + summary.counts.test).toBe(samples.length);
  });
});

describe("secret and personal data scanning", () => {
  it("finds real-looking credentials", () => {
    expect(scanText("AKIAIOSFODNN7EXAMPLE", "$.x").length).toBeGreaterThan(0);
    expect(scanText("token: ghp_0123456789abcdefghijklmnopqrstuvwxyz", "$.x").length).toBeGreaterThan(0);
    expect(scanText("-----BEGIN RSA PRIVATE KEY-----", "$.x").length).toBeGreaterThan(0);
  });

  it("does not fire on documentation placeholders", () => {
    expect(scanText('api_key = "your-api-key-here"', "$.x")).toEqual([]);
    expect(scanText('password = "changeme-please-now"', "$.x")).toEqual([]);
  });

  it("ignores the authorship addresses this material always contains", () => {
    expect(scanText("author@example.com", "$.x")).toEqual([]);
    expect(scanText("12345+user@users.noreply.github.com", "$.x")).toEqual([]);
  });

  it("masks rather than repeating the value in a finding", () => {
    const [finding] = scanText("AKIAIOSFODNN7EXAMPLE", "$.x");
    expect(finding?.excerpt).not.toContain("IOSFODNN7");
    expect(finding?.excerpt).toContain("*");
  });

  it("reports how many redactions a rewrite would make", () => {
    const { text, redactions } = redactText("key AKIAIOSFODNN7EXAMPLE here");
    expect(redactions).toBe(1);
    expect(text).toContain("[REDACTED:aws_access_key_id]");
  });
});

describe("decision summaries", () => {
  const valid = {
    kind: "decision_summary",
    language: "en",
    observation:
      "The reference suite passes at the current state and percent_change divides by the baseline without guarding it.",
    action: "Add an explicit guard that raises ValueError when the baseline argument is zero.",
    verification: "Re-run the full pytest suite and confirm every test passes.",
    evidence_event_ids: ["event_0001"],
  };
  const block = (o: unknown) => "```decision_summary\n" + JSON.stringify(o, null, 2) + "\n```";

  it("accepts a well-formed summary citing evidence that exists", () => {
    const result = extractDecisionSummaries(block(valid), new Set(["event_0001"]));
    expect(result.summaries).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it("rejects a summary citing evidence that does not exist", () => {
    const result = extractDecisionSummaries(block(valid), new Set(["event_0002"]));
    expect(result.summaries).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/does not exist/);
  });

  it("rejects a summary outside the word budget", () => {
    const tooShort = { ...valid, observation: "Short.", action: "Go.", verification: "Check." };
    const result = extractDecisionSummaries(block(tooShort), new Set(["event_0001"]));
    expect(result.summaries).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/outside the 30-90 range/);
  });

  it("keeps surrounding prose as the remainder", () => {
    const result = extractDecisionSummaries(`Before.\n${block(valid)}\nAfter.`, new Set(["event_0001"]));
    expect(result.summaries).toHaveLength(1);
    expect(result.remainder).toContain("Before.");
    expect(result.remainder).toContain("After.");
  });
});

describe("leak detection", () => {
  const base: TaskSpec = {
    task_type: "bugfix",
    user_prompt: "percent_change crashes when the baseline is zero. It should raise a clear error instead.",
    acceptance_criteria: ["percent_change(0, 10) raises ValueError"],
    user_fact_sheet: [],
    ambiguity_assessment: { is_ambiguous: false, likely_questions: [], notes: "" },
    provenance: {
      generator_prompt_version: "v1",
      generator_model: "test",
      generated_at: new Date().toISOString(),
      synthetic_fixture: true,
    },
  };
  const patch = [
    "--- a/src/calcstats/stats.py",
    "+++ b/src/calcstats/stats.py",
    "@@",
    "+def _require_non_zero_baseline(value):",
    '+    raise ValueError("percent_change() requires a non-zero baseline")',
  ].join("\n");
  const scan = (task: TaskSpec) =>
    detectLeaks({
      task,
      targetSha: "0123456789abcdef0123456789abcdef01234567",
      parentSha: "fedcba9876543210fedcba9876543210fedcba98",
      commitMessage: "Reject a zero baseline in percent_change",
      patch,
      parentPaths: ["src/calcstats/stats.py"],
    });

  it("passes a clean request that names only public API", () => {
    expect(scan(base)).toEqual([]);
  });

  it("catches a commit SHA", () => {
    const leaky = { ...base, user_prompt: `${base.user_prompt} See 0123456789abcdef.` };
    expect(scan(leaky).join(" ")).toMatch(/commit SHA/);
  });

  it("catches a reference to the commit itself", () => {
    const leaky = { ...base, user_prompt: "Please reproduce this commit's behaviour change." };
    expect(scan(leaky).join(" ")).toMatch(/history rather than the desired behaviour/);
  });

  it("catches a private helper only the patch introduces", () => {
    const leaky = { ...base, user_prompt: `${base.user_prompt} Add _require_non_zero_baseline for it.` };
    expect(scan(leaky).join(" ")).toMatch(/private identifier/);
  });

  it("catches a verbatim line from the patch", () => {
    const leaky = {
      ...base,
      acceptance_criteria: ['raise ValueError("percent_change() requires a non-zero baseline")'],
    };
    expect(scan(leaky).join(" ")).toMatch(/literal line from the patch/);
  });
});

describe("training masks", () => {
  const sample = {
    sample_id: "s1",
    split: "train",
    task: { task_type: "bugfix" },
    source: { repository_family: "f" },
    agent: { model: "m", execution_mode: "real_model" },
    verification: { exact_tree_match: true, behavioral_checks_passed: true, replay_passed: true },
    events: [
      { type: "user_message", origin: "synthetic_user", text: "do the thing", seq: 0 },
      { type: "assistant_message", origin: "model_generated", text: "on it", seq: 1 },
      { type: "tool_call", origin: "model_generated", tool_call_id: "t1", tool_name: "run_command", tool_input: {}, seq: 2 },
      { type: "tool_result", origin: "executed_tool", tool_call_id: "t1", text: "exit 0", seq: 3 },
      { type: "annotation", origin: "posthoc_annotation", text: "a note", seq: 4 },
    ],
  } as unknown as Sample;

  it("never marks a tool output as a training target", () => {
    const conversation = toConversation(sample, EXPORT_CONFIG);
    const toolMessages = conversation.messages.filter((m) => m.role === "tool");
    expect(toolMessages.length).toBeGreaterThan(0);
    for (const message of toolMessages) expect(message.train).toBe(false);
  });

  it("never marks a user message as a training target", () => {
    const conversation = toConversation(sample, EXPORT_CONFIG);
    for (const message of conversation.messages.filter((m) => m.role === "user")) {
      expect(message.train).toBe(false);
    }
  });

  it("marks assistant actions as targets", () => {
    const conversation = toConversation(sample, EXPORT_CONFIG);
    const assistant = conversation.messages.filter((m) => m.role === "assistant");
    expect(assistant.length).toBeGreaterThan(0);
    for (const message of assistant) expect(message.train).toBe(true);
  });

  it("excludes post-hoc annotations unless asked for", () => {
    const without = toConversation(sample, EXPORT_CONFIG);
    expect(without.messages.some((m) => m.origin === "posthoc_annotation")).toBe(false);

    const withAnnotations = toConversation(sample, { ...EXPORT_CONFIG, include_posthoc_annotations: true });
    const annotation = withAnnotations.messages.find((m) => m.origin === "posthoc_annotation");
    expect(annotation).toBeDefined();
    expect(annotation?.train).toBe(false);
  });
});

describe("model response parsing", () => {
  it("reads a bare object", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it("reads an object wrapped in a fence", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("reads an object surrounded by prose", () => {
    expect(extractJsonObject('Here you go:\n{"a":{"b":"}"}}\nHope that helps.')).toEqual({ a: { b: "}" } });
  });

  it("fails loudly rather than guessing", () => {
    expect(() => extractJsonObject("no json at all")).toThrow(/does not contain a JSON object/);
    expect(() => extractJsonObject("")).toThrow(/empty response/);
  });
});
