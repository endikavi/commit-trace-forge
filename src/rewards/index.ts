import type { RewardConfig } from "../config/schema.ts";
import type { BehavioralChecks, Judgment, RewardBreakdown, VerifiableOutcome } from "../types/index.ts";

/**
 * Reward composition.
 *
 * Verifiable evidence leads; the judge refines. When the hidden tests fail, the judge contributes
 * nothing — well-written prose around a wrong solution must not earn reward. Hard gates (deleted
 * tests, suspected reward hacking, unsupported claims) are applied last and listed in `gates`, so
 * every reward can be explained from the record alone.
 */

export function verifiableOutcome(
  behavioral: BehavioralChecks | null,
  options: { agentCompleted: boolean; exactTreeMatch: boolean | null; failToPassTotal: number },
): VerifiableOutcome {
  return {
    tests_passed: behavioral?.passed ?? false,
    fail_to_pass_satisfied: behavioral?.fail_to_pass_satisfied.length ?? 0,
    fail_to_pass_total: options.failToPassTotal,
    regressions: behavioral?.regressions.length ?? 0,
    visible_tests_tampered: behavioral?.visible_tests_tampered ?? false,
    visible_tests_deleted: behavioral?.tampered_paths.some((p) => p.endsWith("(deleted)")) ?? false,
    exact_tree_match: options.exactTreeMatch,
    agent_completed: options.agentCompleted,
  };
}

export function composeReward(
  outcome: VerifiableOutcome,
  judgment: Judgment | null,
  config: RewardConfig,
): RewardBreakdown {
  const gates: string[] = [];

  let verifiable = 0;
  if (outcome.tests_passed) {
    verifiable = 1;
  } else if (config.partial_credit && outcome.regressions === 0 && outcome.fail_to_pass_total > 0) {
    verifiable = 0.5 * (outcome.fail_to_pass_satisfied / outcome.fail_to_pass_total);
    gates.push("tests_failed_partial_credit");
  } else {
    gates.push("tests_failed");
  }

  const judgeComponent = judgment?.score ?? null;
  let reward: number;
  let formula: string;
  if (!outcome.tests_passed) {
    reward = config.verifiable_weight * verifiable;
    formula = `${config.verifiable_weight} * verifiable (judge ignored: hidden tests failed)`;
  } else if (judgeComponent === null) {
    reward = verifiable;
    formula = "verifiable (no judgment available)";
  } else {
    reward = config.verifiable_weight * verifiable + config.judge_weight * judgeComponent;
    formula = `${config.verifiable_weight} * verifiable + ${config.judge_weight} * judge`;
  }

  if (!outcome.agent_completed && config.zero_on_incomplete) {
    reward = 0;
    gates.push("agent_did_not_complete");
  }
  // Modifying a test file is often legitimate (adding cases) and cannot game the score — the hidden
  // copy is restored before evaluation — so it is left to the judge. Deleting one is not.
  if (outcome.visible_tests_deleted && config.zero_on_deleted_tests) {
    reward = 0;
    gates.push("visible_tests_deleted");
  }
  if (judgment?.verdict.flags.reward_hacking_suspected && config.zero_on_reward_hacking) {
    reward = 0;
    gates.push("judge_flagged_reward_hacking");
  }
  if (judgment?.verdict.flags.unsupported_claims && reward > config.cap_on_unsupported_claims) {
    reward = config.cap_on_unsupported_claims;
    gates.push(`judge_flagged_unsupported_claims (capped at ${config.cap_on_unsupported_claims})`);
  }

  return {
    reward: round(Math.min(1, Math.max(0, reward))),
    verifiable_component: round(verifiable),
    judge_component: judgeComponent,
    gates,
    formula,
  };
}

/** Group-relative advantages, (r - mean) / (std + eps), as used by GRPO-style trainers. */
export function groupAdvantages(rewards: readonly number[], eps = 1e-6): { mean: number; std: number; advantages: number[] } {
  if (rewards.length === 0) return { mean: 0, std: 0, advantages: [] };
  const mean = rewards.reduce((a, b) => a + b, 0) / rewards.length;
  const std = Math.sqrt(rewards.reduce((a, r) => a + (r - mean) ** 2, 0) / rewards.length);
  return { mean: round(mean), std: round(std), advantages: rewards.map((r) => round((r - mean) / (std + eps))) };
}

function round(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}
