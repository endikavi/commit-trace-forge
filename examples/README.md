# Examples

Real output of one end-to-end run, checked in so the formats can be inspected without running
anything. Nothing here was edited by hand.

## `xmltodict/` — teacher traces, RL tasks, rollouts and scoring

Produced with [`config/examples/xmltodict.yaml`](../config/examples/xmltodict.yaml) against
[martinblech/xmltodict](https://github.com/martinblech/xmltodict) pinned at `6e29fba`, real Docker
containers, and a **small self-hosted model** (an OpenAI-compatible endpoint serving a Qwen-family
"flash" model) in every role: teacher, policy, judge, task writer, reviewer and simulated user.

**Not a model-quality showcase.** It demonstrates the formats and the verification with a cheap
model. A stronger teacher produces better traces; the pipeline's guarantees do not depend on it.

```bash
export FORGE_MODEL=<provider>/<model>        # any pi model
pnpm forge run     --config config/examples/xmltodict.yaml
pnpm forge judge   --config config/examples/xmltodict.yaml
pnpm forge export  --config config/examples/xmltodict.yaml
pnpm forge rollout --config config/examples/xmltodict.yaml --rollouts 2
pnpm forge score   --config config/examples/xmltodict.yaml --trajectory t.json --json
```

### What the run did

40 commits since 2023 examined; 10 survived the deterministic filters and were drawn.

| Outcome | Count | Cause |
| --- | --- | --- |
| **accepted** | **3** | hidden tests passed, replay reproduced every tool call and the final tree, 2 clean test runs |
| rejected at `prepare` | 1 | `env_dependency_unresolvable_offline` — the commit changes dependency manifests |
| rejected at `grade` | 2 | `grade_gate_no_relevant_tests`, `grade_below_dimension_minimum` |
| rejected at `generate` | 2 | `taskgen_review_leak`, `taskgen_review_incoherent` — the independent reviewer caught a request that revealed the fix, and one whose acceptance criteria contradicted it |
| rejected at `solve` | 1 | `solve_no_attempt_succeeded` — the agent ran out of turns |
| rejected at `verify` | 1 | `verify_acceptance_not_met` — the agent's solution failed the hidden tests |

All three accepted tasks are bug fixes, solved by behaviour rather than byte-identical
reconstruction (`exact_tree_match: false`, `behavioral_checks_passed: true`):

| Task | Request (abridged) | Fail-to-pass | Judge |
| --- | --- | --- | --- |
| `sample_93018156077f8355` | `parse(..., disable_entities=True)` should fail closed on documents that use entities | 2 | 0.91 |
| `sample_77dab3f4075b7e60` | `unparse` should serialise `None` text and attributes as empty values, not `'None'` | 3 | 0.89 |
| `sample_f9a4cdc73190ca14` | namespace declaration dicts should be recognised with a custom `attr_prefix` | 2 | 0.96 |

Checked on the files below: no target SHA or commit subject appears in any training or
policy-side file; no user, tool or system message carries a training target; no host path appears
anywhere.

### `dataset/` — `forge export`

| File | Contents |
| --- | --- |
| `sft-openai.jsonl` | OpenAI chat format: exact system prompt, tool definitions, `weight: 1` on assistant turns, `judge_score` in metadata |
| `conversations.jsonl` | provenance-labelled messages with `train` masks |
| `samples.jsonl` | canonical records: every attempt, every event, every verification result |
| `rl-tasks.jsonl` | RL environments: prompt, tools, image, limits |
| `rl-reward-spec.jsonl` | **reserved**: hidden tests, acceptance criteria, reference tree |
| `evaluator-manifest.jsonl` | **reserved**: target SHAs, patches, grader output |
| `run-manifest.json` | prompt versions and hashes, sandbox backend and isolation notes, splits |

### `rollouts/` — `forge rollout --rollouts 2`

The same model as policy, two attempts per task from the same starting image:

```json
{ "tasks": 3, "rollouts": 6, "mean_reward": 0.8218, "pass_rate": 0.8333, "pass_at_k": 1, "k": 2, "preference_pairs": 1 }
```

| Task | Rollout | Hidden tests | Judge | Reward | Gates |
| --- | --- | --- | --- | --- | --- |
| `sample_93018156077f8355` | 0 | failed | 0.56 | **0** | `tests_failed`, `agent_did_not_complete` |
| `sample_93018156077f8355` | 1 | passed | 0.96 | 0.988 | |
| `sample_77dab3f4075b7e60` | 0 / 1 | passed / passed | 0.96 / 0.91 | 0.988 / 0.973 | |
| `sample_f9a4cdc73190ca14` | 0 / 1 | passed / passed | 0.98 / 0.96 | 0.994 / 0.988 | |

The first task shows the reward doing its job: the judge rated the failed attempt's process at
0.56, and the reward is still 0 — a judge cannot rescue a solution that fails the hidden tests.
That task yields the one preference pair (`preferences.jsonl`, TRL conversational DPO format).

Note that `advantage` is normalised within each task's group, as GRPO does: two passing rollouts
0.015 apart get advantages of about ±1. That is the standard behaviour, and a reason to use more
than two rollouts per task in real training.

### `scoring/` — `forge score`

The teacher trajectory of `sample_93018156077f8355`, exported as OpenAI messages and fed back in as
if an external agent had produced it:

| Input | Re-executed tool calls | Output mismatches | Hidden tests | Reward |
| --- | --- | --- | --- | --- |
| `score-teacher-trajectory.json` — unmodified | all, from a clean container | **0** | passed | 0.973 |
| `score-fabricated-output.json` — one test-run output replaced with `999 passed` | all | **1** (`content`) | passed | 0.967 |

forge never trusts supplied tool output: it re-executes every call and reports each result that
differs beyond timing noise. The reward reflects what the re-executed actions actually produce; the
mismatch list tells you the trajectory you were handed is not what those actions print.
