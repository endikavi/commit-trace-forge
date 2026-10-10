import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { eventsToOpenAI, toOpenAIChat, toRlRewardSpec, toRlTask } from "../../src/dataset/formats.ts";
import { importTrajectory } from "../../src/dataset/import.ts";
import { toConversation } from "../../src/dataset/export.ts";
import { composeReward, groupAdvantages } from "../../src/rewards/index.ts";
import { buildJudgePrompt, judgeScore } from "../../src/judging/index.ts";
import { applyEnvironmentOverrides, validateConfig } from "../../src/config/load.ts";
import { modelForRole } from "../../src/config/schema.ts";
import { PiHarness, pinSystemPrompt } from "../../src/harness/pi.ts";
import { TrajectoryRecorder } from "../../src/harness/recorder.ts";
import { createLogger } from "../../src/util/logger.ts";
import { compareSuppliedResult, maskVolatile } from "../../src/pipeline.ts";
import {
  EvaluatorManifest,
  JudgeVerdict,
  Sample,
  TrajectoryEvent,
  type Judgment,
  type VerifiableOutcome,
} from "../../src/types/index.ts";

const CONFIG = validateConfig({ schema_version: 1, repositories: [{ url: "x" }] });

const demo = (file: string) =>
  readFileSync(new URL(`../../examples/xmltodict/dataset/${file}`, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
const SAMPLES = demo("samples.jsonl").map((s) => Sample.parse(s));
const MANIFESTS = demo("evaluator-manifest.jsonl").map((m) => EvaluatorManifest.parse(m));

let seq = 0;
function ev(partial: Partial<TrajectoryEvent> & Pick<TrajectoryEvent, "role" | "type" | "origin">): TrajectoryEvent {
  const n = seq++;
  return TrajectoryEvent.parse({
    event_id: `event_${String(n).padStart(4, "0")}`,
    seq: n,
    timestamp: "2026-01-01T00:00:00Z",
    ...partial,
  });
}

const TRAJECTORY: TrajectoryEvent[] = [
  ev({ role: "user", type: "user_message", origin: "synthetic_user", text: "Fix the bug." }),
  ev({ role: "assistant", type: "assistant_message", origin: "model_generated", text: "Looking at the tests first." }),
  ev({ role: "assistant", type: "tool_call", origin: "model_generated", tool_call_id: "c1", tool_name: "run_command", tool_input: { command: "pytest -q" } }),
  ev({ role: "tool", type: "tool_result", origin: "executed_tool", tool_call_id: "c1", text: "1 failed" }),
  ev({ role: "assistant", type: "user_question", origin: "model_generated", tool_call_id: "q1", text: "ValueError or TypeError?" }),
  ev({ role: "user", type: "user_answer", origin: "synthetic_user", tool_call_id: "q1", text: "ValueError." }),
  ev({ role: "system", type: "annotation", origin: "posthoc_annotation", text: "internal note" }),
  ev({ role: "assistant", type: "tool_call", origin: "model_generated", tool_call_id: "c2", tool_name: "read_file", tool_input: { path: "a.py" } }),
];

describe("OpenAI chat view", () => {
  const { messages, droppedToolCalls } = eventsToOpenAI(TRAJECTORY, { systemPrompt: "SYS" }, { includeDecisionSummaries: true });

  it("starts with the exact system prompt and the user request", () => {
    expect(messages[0]).toEqual({ role: "system", content: "SYS" });
    expect(messages[1]).toEqual({ role: "user", content: "Fix the bug." });
  });

  it("merges assistant text with the tool call that follows it", () => {
    expect(messages[2]).toMatchObject({ role: "assistant", content: "Looking at the tests first.", weight: 1 });
    expect((messages[2] as { tool_calls: unknown[] }).tool_calls).toHaveLength(1);
  });

  it("returns ask_user answers as tool messages", () => {
    const ask = messages.find((m) => m.role === "assistant" && m.tool_calls?.[0]?.function.name === "ask_user");
    expect(ask).toBeDefined();
    expect(messages).toContainEqual({ role: "tool", tool_call_id: "q1", content: "ValueError." });
  });

  it("marks only assistant turns as targets and never includes post-hoc annotations", () => {
    for (const m of messages) {
      if (m.role === "assistant") expect(m.weight).toBe(1);
      else expect("weight" in m).toBe(false);
    }
    expect(JSON.stringify(messages)).not.toContain("internal note");
  });

  it("drops a tool call that has no recorded result instead of inventing one", () => {
    expect(droppedToolCalls).toEqual(["c2"]);
    expect(JSON.stringify(messages)).not.toContain('"c2"');
  });

  it("round-trips through the trajectory importer", () => {
    const imported = importTrajectory({ task_id: "t", messages });
    expect(imported.taskId).toBe("t");
    const again = eventsToOpenAI(imported.events, { systemPrompt: "SYS" }, { includeDecisionSummaries: true });
    expect(again.messages).toEqual(messages);
  });
});

describe("exports built from real samples", () => {
  it("carries the system prompt and tool definitions into the SFT view", () => {
    for (const sample of SAMPLES) {
      const record = toOpenAIChat(sample, { includeDecisionSummaries: true });
      expect(record.messages[0]?.role).toBe("system");
      expect(record.tools.map((t) => t.function.name)).toEqual(expect.arrayContaining(["read_file", "run_command"]));
      const conversation = toConversation(sample, CONFIG.export);
      expect(conversation.messages[0]).toMatchObject({ role: "system", train: false });
      expect(conversation.tools.length).toBeGreaterThan(0);
    }
  });

  it("uses the recorded prompt, and says so when it has to reconstruct one for an older record", () => {
    const recorded = toOpenAIChat(SAMPLES[0]!, { includeDecisionSummaries: true });
    expect(recorded.metadata.system_prompt_reconstructed).toBe(false);
    expect(recorded.messages[0]).toEqual({ role: "system", content: SAMPLES[0]!.agent.system_prompt });

    const older = structuredClone(SAMPLES[0]!);
    older.agent.system_prompt = null;
    older.agent.tool_schemas = [];
    const rebuilt = toOpenAIChat(older, { includeDecisionSummaries: true });
    expect(rebuilt.metadata.system_prompt_reconstructed).toBe(true);
    expect(rebuilt.tools.map((t) => t.function.name)).toEqual(expect.arrayContaining(older.agent.tool_names));
  });

  it("keeps every reserved fact out of the policy-side RL task", () => {
    SAMPLES.forEach((sample, i) => {
      const manifest = MANIFESTS[i]!;
      const task = JSON.stringify(
        toRlTask(sample, { max_turns: 40, max_user_questions: 2, command_timeout_seconds: 60, task_timeout_seconds: 600, network: false, run_as: "1000:1000" }),
      );
      expect(task).not.toContain(manifest.target_sha);
      expect(task).not.toContain(manifest.target_tree_sha);
      expect(task).not.toContain(manifest.commit_subject);
      for (const hidden of manifest.hidden_test_ids) expect(task).not.toContain(hidden);
      for (const criterion of sample.task.acceptance_criteria) expect(task).not.toContain(criterion);

      const spec = toRlRewardSpec(sample, manifest);
      expect(spec.target_tree_sha).toBe(manifest.target_tree_sha);
      expect(spec.hidden_test_paths).toEqual(manifest.hidden_test_ids);
    });
  });
});

// ---------------------------------------------------------------------------

const verdict = (overrides: Partial<JudgeVerdict["flags"]> = {}, score = 4): JudgeVerdict =>
  JudgeVerdict.parse({
    dimensions: Object.fromEntries(
      ["requirement_coverage", "solution_quality", "verification_discipline", "scope_discipline", "communication_honesty", "efficiency"].map(
        (k) => [k, { score, evidence: "event_0003" }],
      ),
    ),
    flags: { reward_hacking_suspected: false, unsupported_claims: false, ...overrides },
  });

const judgment = (v: JudgeVerdict): Judgment => ({
  verdict: v,
  score: judgeScore(v, CONFIG.judge.weights),
  judge_model: "m",
  prompt_version: "v1",
  prompt_hash: "sha256:x",
  saw_reference: false,
  usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null, cost_known: false },
  judged_at: "2026-01-01T00:00:00Z",
});

const outcome = (overrides: Partial<VerifiableOutcome> = {}): VerifiableOutcome => ({
  tests_passed: true,
  fail_to_pass_satisfied: 2,
  fail_to_pass_total: 2,
  regressions: 0,
  visible_tests_tampered: false,
  visible_tests_deleted: false,
  exact_tree_match: false,
  agent_completed: true,
  ...overrides,
});

describe("judge score", () => {
  it("is the weighted mean normalised to [0, 1]", () => {
    expect(judgeScore(verdict({}, 5), CONFIG.judge.weights)).toBe(1);
    expect(judgeScore(verdict({}, 0), CONFIG.judge.weights)).toBe(0);
    expect(judgeScore(verdict({}, 4), CONFIG.judge.weights)).toBeCloseTo(0.8);
  });

  it("tells the judge the measured facts and nothing about the reference unless asked", () => {
    const prompt = buildJudgePrompt({
      task: SAMPLES[0]!.task,
      events: TRAJECTORY,
      solutionPatch: "diff --git a/x b/x",
      verifiable: outcome({ tests_passed: false, fail_to_pass_satisfied: 1 }),
      failingChecks: ["test::t1"],
      referencePatch: null,
      config: CONFIG.judge,
    });
    expect(prompt).toContain("hidden tests passed: false");
    expect(prompt).toContain("still failing: test::t1");
    expect(prompt).toContain("[event_0002]");
    expect(prompt).not.toContain("Historical reference patch");
  });
});

describe("reward composition", () => {
  const cfg = CONFIG.reward;

  it("combines tests and judge when the tests pass", () => {
    const r = composeReward(outcome(), judgment(verdict({}, 5)), cfg);
    expect(r.reward).toBe(1);
    expect(r.gates).toEqual([]);
  });

  it("ignores the judge when the hidden tests fail", () => {
    const r = composeReward(outcome({ tests_passed: false }), judgment(verdict({}, 5)), cfg);
    expect(r.reward).toBe(0);
    expect(r.gates).toContain("tests_failed");
  });

  it("gives bounded partial credit only when enabled and without regressions", () => {
    const partial = { ...cfg, partial_credit: true };
    expect(composeReward(outcome({ tests_passed: false, fail_to_pass_satisfied: 1 }), null, partial).reward).toBeCloseTo(0.7 * 0.25);
    expect(composeReward(outcome({ tests_passed: false, fail_to_pass_satisfied: 1, regressions: 1 }), null, partial).reward).toBe(0);
  });

  it("zeroes deleted tests and suspected reward hacking, and caps unsupported claims", () => {
    expect(composeReward(outcome({ visible_tests_tampered: true, visible_tests_deleted: true }), null, cfg).reward).toBe(0);
    expect(composeReward(outcome(), judgment(verdict({ reward_hacking_suspected: true }, 5)), cfg).reward).toBe(0);
    const capped = composeReward(outcome(), judgment(verdict({ unsupported_claims: true }, 5)), cfg);
    expect(capped.reward).toBe(cfg.cap_on_unsupported_claims);
  });

  it("does not punish an agent for adding cases to an existing test file", () => {
    // The hidden copy is restored before evaluation, so a modification cannot game the result.
    const r = composeReward(outcome({ visible_tests_tampered: true }), null, cfg);
    expect(r.reward).toBe(1);
    expect(r.gates).toEqual([]);
  });

  it("falls back to verifiable evidence when no judgment exists", () => {
    expect(composeReward(outcome(), null, cfg).reward).toBe(1);
  });

  it("computes group-relative advantages", () => {
    const { mean, advantages } = groupAdvantages([1, 0, 1, 0]);
    expect(mean).toBe(0.5);
    expect(advantages[0]).toBeCloseTo(1, 3);
    expect(advantages[1]).toBeCloseTo(-1, 3);
    expect(groupAdvantages([1, 1]).advantages).toEqual([0, 0]);
  });
});

describe("configuration", () => {
  it("applies host overrides from the environment", () => {
    const config = validateConfig({ schema_version: 1, repositories: [{ url: "x" }] });
    const applied = applyEnvironmentOverrides(config, {
      FORGE_DOCKER_COMMAND: "wsl -d Ubuntu -e docker",
      FORGE_MODEL: "local/qwen-coder",
    });
    expect(applied).toHaveLength(2);
    expect(config.sandbox.docker_command).toEqual(["wsl", "-d", "Ubuntu", "-e", "docker"]);
    expect(modelForRole(config, "judge")).toMatchObject({ provider: "local", model: "qwen-coder" });
    expect(() => applyEnvironmentOverrides(config, { FORGE_MODEL: "no-slash" })).toThrow(/provider\/model/);
  });

  it("falls the policy back to the solver's override", () => {
    const config = validateConfig({
      schema_version: 1,
      repositories: [{ url: "x" }],
      model: { roles: { solver: { provider: "teacher", model: "big" } } },
    });
    expect(modelForRole(config, "policy")).toMatchObject({ provider: "teacher", model: "big" });
  });

  it("rejects reward weights that do not sum to one", () => {
    expect(() =>
      validateConfig({ schema_version: 1, repositories: [{ url: "x" }], reward: { verifiable_weight: 0.5, judge_weight: 0.3 } }),
    ).toThrow(/must equal 1/);
  });
});

describe("pi adapter", () => {
  it("records tool calls pi answered without executing as harness answers, not as executions", () => {
    const harness = new PiHarness({ logger: createLogger("test") });
    const recorder = new TrajectoryRecorder();
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0, cost_known: true };
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "apply_patch", arguments: { path: "a.py" } }] },
      { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "Tool call was not executed: output token limit" }] },
    ];
    (harness as unknown as { collectMessages: (...args: unknown[]) => void }).collectMessages(messages, recorder, usage, false, new Map());
    const result = recorder.all().find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ origin: "harness", tool_is_error: true, tool_output: { not_executed: true } });
    expect(recorder.all().some((e) => e.type === "annotation")).toBe(false);
  });

  it("replaces pi's assembled prompt, which appends the host working directory, with the exact prompt", () => {
    let handler: (() => unknown) | undefined;
    const fakePi = { on: (event: string, fn: () => unknown) => { if (event === "before_agent_start") handler = fn; } };
    void pinSystemPrompt("EXACT")(fakePi as never);
    expect(handler?.()).toEqual({ systemPrompt: "EXACT" });
  });
});

describe("external trajectory scoring", () => {
  const supplied = (text: string, exit = 0) =>
    ev({ role: "tool", type: "tool_result", origin: "executed_tool", tool_call_id: "x", text: `$ sh -c pytest -q\nexit: ${exit}  duration: 900ms\n${text}` });
  const real = (text: string, exit = 0) => ({
    output: { exit_code: exit },
    text: `$ sh -c pytest -q\nexit: ${exit}  duration: 1342ms\n${text}`,
    isError: false,
  });

  it("ignores run-to-run timing and clock noise", () => {
    expect(compareSuppliedResult(supplied("127 passed in 0.58s"), real("127 passed in 0.63s"))).toBeNull();
    expect(maskVolatile("drwxr-xr-x 1 forge forge 4096 Oct 10 22:31 .git")).toBe(
      maskVolatile("drwxr-xr-x 1 forge forge 4096 Oct 11 09:02 .git"),
    );
  });

  it("catches a fabricated test summary", () => {
    expect(compareSuppliedResult(supplied("999 passed in 0.10s"), real("127 passed in 0.63s"))).toMatch(/^content/);
  });

  it("treats a different exit code as a hard mismatch", () => {
    expect(compareSuppliedResult(supplied("ok", 0), real("1 failed", 1))).toMatch(/^exit_code: supplied 0, re-execution 1/);
  });
});
