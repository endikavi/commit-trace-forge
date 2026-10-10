# Dataset schema and formats

Canonical schema version: **`commit-trace-forge/1`** (`schema_version` on every record).

Definitions live in `src/types/index.ts` as Zod schemas. Every exported record is validated
against them at write time, so a malformed sample fails the export rather than reaching a
training set.

## Files

| File | Contents | Safe to train on |
| --- | --- | --- |
| `samples.jsonl` | one canonical `Sample` per line | yes |
| `conversations.jsonl` | training view with messages, tool calls and masks | yes |
| `sft-openai.jsonl` | OpenAI chat format with system prompt, tools and per-message `weight` | yes |
| `rl-tasks.jsonl` | RL environments: prompt, tools, image, limits | policy-side |
| `rl-reward-spec.jsonl` | hidden tests, acceptance criteria, fact sheet, reference tree | **no — reserved** |
| `evaluator-manifest.jsonl` | target SHAs, target patches, hidden test ids, grader output | **no — reserved** |
| `run-manifest.json` | run identity, prompt versions, backend, split assignment | metadata |
| `README.md` | provenance, licensing and contamination notes | metadata |

The separation is structural, not a convention: the function that builds conversations takes a
`Sample` and never receives the manifest.

## Sample

```
schema_version      "commit-trace-forge/1"
sample_id, run_id, created_at

source              repository_url, repository_family, resolved_ref_sha,
                    license, license_source ("declared" | "detected" | "unknown"),
                    attribution_notice

metrics             raw and filtered line/file counts, plus per-file change records

task                task_type, user_prompt, acceptance_criteria, user_fact_sheet,
                    ambiguity_assessment, provenance
task_review         the independent reviewer's verdict

environment         recipe_id, image_ref, image_digest, recipe_hash, ecosystem, workdir

agent               harness, harness_version, adapter_version, model, thinking_level,
                    tool_names, execution_mode,
                    system_prompt, system_prompt_version, tool_schemas   (exactly what the agent saw)

attempts[]          EVERY attempt, including the failed ones, each with its own
                    events, usage, outcome and rejection cause
accepted_attempt_index
events[]            the ordered event stream of the accepted attempt

verification        exact_tree_match, normalized_tree_match, tree_diff_summary,
                    behavioral_checks_passed, behavioral, replay_passed, replay,
                    clean_runs_completed, acceptance_mode, accepted, rejection_cause

budget              usage (tokens, cost, cost_known), wall_clock_ms,
                    solved_on_first_attempt, solved_within_budget

split               "train" | "validation" | "test" | null
quality             ten independent boolean flags
dedup_keys          commit_identity, normalized_patch, repository_family, task_similarity
```

### Identity and provenance

`source` carries repository identity and licensing. The parent and target SHAs are **not** in the
sample: they live in the evaluator manifest.

### `execution_mode`

- `real_model` — a model produced the trajectory against a real sandbox
- `scripted_fixture` — a fixed script drove real tools; **no model was called**

Only `real_model` is exportable by default. `export.allow_fixture_provenance` opts in, and even
then the records stay labelled and the export README says how many there are. A scripted
trajectory is never presented as a verified model run.

### Cost

`cost_usd` is `null` whenever `cost_known` is `false`. A model with no published price yields an
unknown cost, and the pipeline says so rather than guessing. An explicitly declared price of zero
— a self-hosted OpenAI-compatible endpoint, say — is a *known* cost of zero, which is a different
thing.

## Events

Every event carries:

```
event_id        "event_0007"  — stable within the trajectory
seq             ordering index
role            user | assistant | tool | system
type            user_message | assistant_message | decision_summary | tool_call |
                tool_result | user_question | user_answer | annotation
origin          provenance (below)
timestamp
text            message text, when applicable
tool_call_id    correlates a tool_call with its tool_result, and a
                user_question with its user_answer
tool_name, tool_input, tool_output, tool_is_error
truncated               true when tool_output was shortened for the context window
full_output_artifact    sha256 of the complete payload whenever truncated is true
decision_summary        the validated structure, for decision_summary events
```

### Origins

| Origin | Meaning |
| --- | --- |
| `model_generated` | the model wrote it |
| `synthetic_user` | the simulated user wrote it |
| `executed_tool` | a real command produced it |
| `harness` | the agent harness answered a tool call **without executing it** (invalid arguments, unknown tool, output-token limit); replay skips these |
| `derived_metric` | computed by the pipeline from real results |
| `posthoc_annotation` | added after the fact, **not part of the original flow** |

Post-hoc annotations are excluded from the conversation view unless
`export.include_posthoc_annotations` is set, and are never training targets.

### Truncation

A tool result too large for the context window is shortened for the model, but the complete
payload is always stored in the artifact store and referenced by hash. `truncated: true` without a
`full_output_artifact` is a bug, not a permitted state.

## Decision summaries

```json
{
  "kind": "decision_summary",
  "language": "en",
  "observation": "Brief statement grounded in available evidence.",
  "action": "The next concrete action.",
  "verification": "How the result will be checked.",
  "evidence_event_ids": ["event_0012"]
}
```

Validated at record time. A block is accepted only when it parses, satisfies the schema, totals
**30–90 words** across the three prose fields, and cites `evidence_event_ids` that already exist.

A block failing any of these is **not** repaired and **not** dropped: the model's raw text is kept
as an ordinary assistant message, and a `posthoc_annotation` records why the block was rejected.

These are not chain-of-thought. Provider `thinking` blocks are discarded and never enter the
dataset.

## Conversation view

```json
{
  "sample_id": "...",
  "split": "train",
  "task_type": "bugfix",
  "messages": [
    { "role": "user",      "content": "...",  "origin": "synthetic_user", "train": false },
    { "role": "assistant", "content": null,
      "tool_calls": [{ "id": "...", "name": "run_command", "arguments": {...} }],
      "origin": "model_generated", "train": true },
    { "role": "tool", "content": "...", "tool_call_id": "...",
      "origin": "executed_tool", "train": false }
  ],
  "metadata": { ... }
}
```

### Training masks

`train: true` marks a message as a target the model should learn to produce. Assistant text,
assistant tool calls and (optionally) decision summaries are targets.

`train: false` marks context. **User messages and tool outputs are never targets**: training on a
tool output teaches the model to hallucinate command output, which is the exact failure mode this
tool exists to avoid.

`export.include_decision_summaries` controls whether summaries appear as targets, so the same run
can produce an actions-only dataset and an actions-plus-summaries dataset.

## Rollout

Written by `forge rollout` and `forge score`, stored in the workspace database and exported to
`rollouts.jsonl` (with OpenAI `messages` in place of `events`). Formats and usage:
[training.md](training.md).

```
rollout_id, task_id (= sample_id), group_id, index, run_id, split
source              "policy" (forge rollout) | "external" (forge score)
policy_model, outcome, result_tree_sha, solution_patch_artifact, usage, wall_clock_ms
events[]            the rollout's trajectory, same event schema as samples
verifiable          tests_passed, fail_to_pass_satisfied/total, regressions,
                    visible_tests_tampered, exact_tree_match, agent_completed
behavioral          the full hidden-test results
judgment            verdict (six 0-5 dimensions with evidence, two flags), score in [0,1],
                    judge_model, prompt_version, prompt_hash, saw_reference, usage
reward              reward in [0,1], verifiable_component, judge_component, gates[], formula
output_mismatches   external only: supplied tool results that differed from re-execution
```

In `rollouts.jsonl` each record also carries `group_reward_mean`, `group_reward_std` and
`advantage` = (reward − mean) / std over the rollouts of the same task.

## Artifacts

Large payloads never live inside a record:

```
<workspace>/artifacts/<aa>/<bb>/<sha256>
```

Content-addressed, referenced as `sha256:<hex>`. Stored: full tool outputs, complete test logs,
image build logs, target patches, solution patches, solution snapshots, isolation audits and
population manifests.

## Dedup keys

| Key | Catches |
| --- | --- |
| `commit_identity` | the same commit drawn twice |
| `normalized_patch` | cherry-picks, rebases, forks of one change |
| `repository_family` | grouping for splits (not a duplicate signal by itself) |
| `task_similarity` | different commits that produce near-identical requests |

`normalized_patch` strips index lines, hunk offsets, trailing whitespace and context, so the same
change applied at a different offset hashes identically.

## Splits

Assigned at **group** level — the repository family by default — never per sample. Forks,
cherry-picks, task variants and repeated attempts therefore always land in the same split.
`crossSplitLeaks` asserts this after assignment and fails the export if it is ever violated.

Groups are placed largest-first into whichever split is furthest below its target share, so the
realised fractions stay close to the configured ones without ever splitting a group. Realised
fractions are written to `run-manifest.json`; with few large groups they will differ from the
targets, and the manifest shows the real numbers.
