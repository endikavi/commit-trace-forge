# Using the data: distillation, RL and evaluation

commit-trace-forge produces **verified tasks**: a starting repository state inside a container
image, a natural-language request, hidden tests that decide correctness, and at least one
trajectory — produced by a real agent, executed for real — that solves it. The same tasks serve
three purposes.

| Goal | Commands | Files you train or evaluate on |
| --- | --- | --- |
| Supervised fine-tuning / teacher → student distillation | `run`, `judge`, `export` | `sft-openai.jsonl` or `conversations.jsonl` |
| Reinforcement learning with verifiable rewards + an LLM judge | `run`, `export`, `rollout` or `score` | `rl-tasks.jsonl` + `rollouts.jsonl` / `preferences.jsonl` |
| Evaluating a model on held-out tasks | `rollout --split test` | `rollout-stats.json` |

```
                 ┌──────────── forge run ────────────┐
git history ──▶  mine ▶ prepare ▶ grade ▶ generate ▶ solve (teacher) ▶ verify ▶ export
                                                         │                       │
                                              verified tasks + teacher traces    │
                                                         │                       ▼
                         forge judge ◀───────────────────┤        sft-openai.jsonl, rl-tasks.jsonl
                         forge rollout (policy × N) ◀────┤
                         forge score (external agent) ◀──┘
                                    │
                                    ▼
             hidden tests (clean container) ▶ LLM judge ▶ reward ▶ rollouts.jsonl / preferences.jsonl
```

## 1. Teacher → student (SFT / distillation)

The **teacher** is `model.roles.solver` (or the top-level `model`). Use your strongest model there;
the other roles can be cheaper.

```yaml
model:
  provider: anthropic
  model: claude-sonnet-4-5        # grader, task generator, reviewer, user simulator
  roles:
    solver: { provider: anthropic, model: claude-opus-4-7 }   # the teacher
    judge:  { provider: openai, model: gpt-5 }                # a different family for judging
```

```bash
pnpm forge run    --config my.yaml   # verified tasks + teacher trajectories
pnpm forge judge  --config my.yaml   # optional: process-quality score per trajectory
pnpm forge export --config my.yaml   # re-export so the scores land in the SFT files
```

Every exported trajectory already passed the hidden tests and replayed deterministically. The
judge adds what tests cannot see — whether the agent verified its work, stayed in scope and
reported honestly — so you can keep only the best traces:

```bash
jq -c 'select(.metadata.split == "train" and (.metadata.judge_score // 0) >= 0.7)' \
  .forge/export/<run>/sft-openai.jsonl > train.jsonl
```

### `sft-openai.jsonl`

One record per trajectory, in the OpenAI fine-tuning chat format that TRL, Axolotl, LLaMA-Factory
and most hosted fine-tuning APIs accept:

```json
{
  "messages": [
    { "role": "system", "content": "You are a software engineer working in a checked-out repository..." },
    { "role": "user", "content": "percent_change blows up with ZeroDivisionError when ..." },
    { "role": "assistant", "content": "I'll run the tests first.", "weight": 1,
      "tool_calls": [{ "id": "call_1", "type": "function",
                       "function": { "name": "run_command", "arguments": "{\"command\":\"python -m pytest -q\"}" } }] },
    { "role": "tool", "tool_call_id": "call_1", "content": "$ sh -c python -m pytest -q\nexit: 1 ..." }
  ],
  "tools": [{ "type": "function", "function": { "name": "run_command", "description": "...", "parameters": { } } }],
  "metadata": { "sample_id": "...", "split": "train", "teacher_model": "...", "judge_score": 0.82, "...": "..." }
}
```

- The system prompt and tools are **exactly** what the teacher saw. A student trained on the trace
  must be run with the same prompt and tools to reproduce the behaviour.
- `weight: 1` marks the assistant turns: the only targets. User messages and tool outputs are
  context. Training on tool output teaches a model to hallucinate command results.
- Provider reasoning ("thinking") blocks are never recorded. What the student learns is the visible
  action stream plus the optional short decision summaries (`export.include_decision_summaries`).

## 2. Reinforcement learning with a judge

### Built-in rollouts

`forge rollout` runs the **policy** (`model.roles.policy`, defaulting to the solver) several times on
each verified task, from the same starting image, with the same tools and limits the teacher had:

```bash
pnpm forge rollout --config my.yaml --rollouts 8 --split train
```

Each rollout is scored in three steps:

1. **Hidden tests** run over a copy of the result in a clean container, with the target's test
   files written back in, so deleting or weakening a visible test cannot help.
2. **The LLM judge** reads the request, the acceptance criteria, the full trajectory, the diff and
   the measured test results, and returns a validated verdict (rubric in `prompts/judge/v1.md`).
3. **The reward** is composed deterministically (`reward` config block):

```
tests failed                     reward = verifiable_weight × verifiable   (judge ignored)
tests passed                     reward = verifiable_weight × 1 + judge_weight × judge_score
agent errored / timed out        reward = 0
visible test file deleted        reward = 0
judge flags reward hacking       reward = 0
judge flags unsupported claims   reward = min(reward, cap_on_unsupported_claims)
```

Defaults: `verifiable_weight: 0.7`, `judge_weight: 0.3`, no partial credit. The judge can refine a
passing solution's reward but can never rescue a failing one. Every gate that fired is listed in
`reward.gates`, so any reward can be explained from the record.

Outputs in `<workspace>/rollouts/<run>/`:

| File | Use |
| --- | --- |
| `rollouts.jsonl` | One record per rollout: OpenAI `messages` + `tools`, `reward` breakdown, `verifiable` outcome, `judgment`, `group_id`, `group_reward_mean/std` and `advantage` = (r − mean) / std within the task's group, as GRPO computes it. |
| `preferences.jsonl` | Best vs worst rollout of a task, in TRL's conversational DPO format (`prompt`, `chosen`, `rejected`), only when the best one passed the hidden tests and the gap is at least `rl.preference_margin`. |
| `rollout-stats.json` | Pass rate, pass@k, mean reward, number of preference pairs. |

These support offline RL (rejection sampling / filtered SFT on high-reward rollouts, DPO on the
pairs) and iterated online loops: train, point `model.roles.policy` at the new checkpoint (any
OpenAI-compatible endpoint declared in pi's `models.json`), roll out again.

### Your own RL trainer: `rl-tasks.jsonl` + `forge score`

To run the policy inside your own framework (verl, OpenRLHF, TRL, a custom loop), export the tasks
and use forge only as the reward function.

`rl-tasks.jsonl` holds what the policy may see — nothing that identifies the historical solution:

```json
{
  "task_id": "sample_fba96f4c193972e8",
  "split": "train",
  "prompt": { "system": "...", "user": "..." },
  "tools": [ ... ],
  "environment": { "image_ref": "forge-task:...", "workdir": "/workspace", "ecosystem": "python", "...": "..." },
  "limits": { "max_turns": 40, "command_timeout_seconds": 180, "network": false, "run_as": "1000:1000", "...": "..." }
}
```

Your harness starts a container from `environment.image_ref` (a local image built by
`forge prepare`; move it with `docker save`/`docker load`), implements the tools with the given
schemas, and lets the policy work. Then score the trajectory:

```bash
pnpm forge score --config my.yaml --task sample_fba96f4c193972e8 \
  --trajectory rollout.json --policy-name my-policy-step-1200 --json
```

`--trajectory` takes either `{"messages": [...]}` (OpenAI chat, as above) or `{"events": [...]}`
(forge's own event stream). forge does **not** trust the supplied tool results: it re-executes every
tool call from the task's starting state, scores the workspace that re-execution produced, and
reports each supplied result that differs as an `output_mismatch` — a cheap, deterministic
detector for a policy (or a harness) that fabricates tool output.

`rl-reward-spec.jsonl` is **reserved**, like `evaluator-manifest.jsonl`: hidden test ids, acceptance
criteria, the simulated user's fact sheet and the reference tree. Keep it on the reward side.

## 3. Evaluation

Splits are assigned per repository family by `forge export`, so a test task never shares a
repository with a training task. To evaluate a student on held-out work:

```yaml
model:
  roles:
    policy: { provider: my-endpoint, model: student-v2 }
```

```bash
pnpm forge rollout --config my.yaml --split test --rollouts 4
cat .forge/rollouts/<run>/rollout-stats.json
```

```json
{ "tasks": 12, "rollouts": 48, "mean_reward": 0.61, "pass_rate": 0.58, "pass_at_k": 0.75, "k": 4, "preference_pairs": 7 }
```

## The judge, honestly

- **It is a model.** Its scores are noisy and can be biased towards its own family's style. Use a
  judge from a different family than the policy, keep `judge_weight` modest, and look at the
  evidence it cites (every dimension must cite event ids or diff lines).
- **It does not see the reference by default** (`judge.show_reference_patch: false`): correctness
  is already measured by the hidden tests, and a judge anchored on one solution penalises valid
  alternatives.
- **A judge failure never invents a score.** If the response is malformed or the call fails, the
  reward falls back to the verifiable component and `judge_component` is `null`.
- **It never replaces verification.** No judge score turns a failing test into a reward.
