# Configuration reference

YAML, validated with Zod at load time. An unknown or malformed field stops the run before any
work happens. `config/example.yaml` is the annotated template; this page documents units and
interactions.

`schema_version` must equal `1`.

---

## Top level

| Field | Unit | Default | Notes |
| --- | --- | --- | --- |
| `seed` | integer or string | `42` | Seeds every sampling and tie-breaking decision. |
| `workspace` | path | `.forge` | SQLite database, artifacts, mirror clones, manifests, exports. Relative to the **config file**. |
| `repositories` | list | required | At least one. |

Filesystem paths in `repositories[].url` also resolve against the config file's directory, so a
configuration is portable and does not depend on the directory `forge` is invoked from.

### Reproducibility of the seed

The same seed reproduces the same draw **only over the same population**. Upstream history moves:
new commits appear, refs advance, a rebase rewrites SHAs. `forge mine` therefore always writes a
population manifest containing every examined commit, its eligibility verdict, its rejection cause
and the exact draw order. That manifest, not the seed alone, is what makes an earlier draw
repeatable.

---

## `repositories[]`

| Field | Unit | Default | Notes |
| --- | --- | --- | --- |
| `url` | URL or path | required | Mirror-cloned into the workspace. Never modified. |
| `ref` | ref | `HEAD` | Resolved to a fixed SHA once, when the run starts. |
| `max_samples` | count | unset | Cap on **accepted** samples from this repository. |
| `family` | string | repo name | Grouping key for splits and dedup. |
| `ecosystem` | enum | `auto` | `auto` \| `python` \| `node`. |
| `filters` | partial | unset | Merged **over** the global `filters` block. |
| `environment` | object | unset | Overrides the detected recipe. |
| `license` | SPDX id | unset | Skips detection. |

**Interaction with `sampling.target_samples`:** both are ceilings on accepted samples. Whichever
binds first wins. Setting `max_samples: 20` on each of three repositories with
`target_samples: 100` yields at most 60.

### `repositories[].environment`

| Field | Notes |
| --- | --- |
| `base_image` | Replaces the ecosystem default. |
| `setup_commands` | Replaces the detected install commands. Run with network, in the container, after the snapshot is placed. |
| `test_command` | argv of the full reference suite. **Required for JS/TS** projects whose `npm test` script is missing or unusable. |
| `test_selection_command` | argv template; `{tests}` is replaced with space-joined ids. Without it, per-test granularity is unavailable. |
| `workdir` | Default `/workspace`. |
| `env` | Merged over the recipe's environment. |

---

## `sampling`

| Field | Unit | Default |
| --- | --- | --- |
| `target_samples` | **accepted samples** | `100` |
| `target_scope` | `global` \| `per_repository` | `global` |
| `max_candidates` | commits | `2000` |
| `strategy` | see below | `uniform_by_repo_then_commit` |
| `without_replacement` | boolean | `true` |

**`target_samples` counts accepted samples, not commits inspected.** Most candidates die in
environment preparation, grading or verification. If the budget or the eligible population runs
out first, the run delivers the number reached and reports the reason for the shortfall; it never
pads the count.

`max_candidates` bounds the pool drawn from the eligible population. The pipeline consumes that
pool in draw order until `target_samples` accepted, so this is the ceiling on how much work a run
can attempt.

### Strategies

- **`uniform_by_repo_then_commit`** — pick a repository uniformly, then a commit uniformly inside
  it. A 50-commit repository and a 50 000-commit repository contribute comparably.
- **`uniform_over_eligible_commits`** — one flat draw over every eligible commit. Repositories
  with more eligible history contribute proportionally more.

---

## `filters`

Deterministic screening, before any model call.

### Size

| Field | Unit | Default |
| --- | --- | --- |
| `changed_lines` | added + deleted | `{min: 10, max: 300}` |
| `added_lines` | added only | unset |
| `deleted_lines` | deleted only | unset |
| `changed_files` | diff entries | `{min: 1, max: 8}` |
| `rename_counts_as` | `one_entry` \| `two_entries` | `one_entry` |
| `rename_similarity` | percent | `50` |

`added_lines` and `deleted_lines` apply **in addition to** `changed_lines`, not instead of it.

**Binary files contribute 0 lines** because git reports `-` for them. They are counted separately
in `metrics.raw.binary_files` and rejected by `exclude_binary_changes`, which runs **before** the
size checks so a binary change is never mistaken for a zero-line change.

**Rename policy:** `one_entry` matches git's own accounting (`R100 old new` is one entry).
`two_entries` counts a rename as a delete plus an add, which roughly doubles its contribution to
`changed_files`.

### Exclusions

`exclude_merges`, `exclude_root_commits`, `exclude_binary_changes`, `exclude_submodule_changes`,
`exclude_symlink_changes`, `exclude_generated_only`, `exclude_vendored_only`,
`exclude_formatting_only`, `exclude_lockfile_only`.

Root commits are always rejected regardless of the flag: there is no parent state to reconstruct.

**`exclude_lockfile_only` rejects commits whose changes are *only* lockfiles.** A lockfile touched
alongside real source changes is kept, because a dependency-changing task frequently requires
exactly that.

`exclude_formatting_only` compares added and removed lines after removing all whitespace; if the
multisets are identical the commit is pure reformatting.

### Classification

`generated_globs`, `vendored_globs`, `lockfile_globs` — minimatch patterns, `/`-separated.
A path matching none of them is source.

`exclude_path_globs` removes entries **before** the filtered metrics are computed. Raw metrics are
stored too, so a rejection can be explained against both views.

`include_path_globs` restricts eligibility to commits touching at least one matching path. Empty
means no restriction.

### Time and gitignore

`since` / `until` — inclusive ISO-8601 bounds, compared against the commit's **author** date.

`exclude_target_gitignored_paths` (default `true`) rejects a commit that adds a path the parent's
`.gitignore` would ignore. Such a path could never be staged by the solver, so a correct solution
would look wrong. The check runs on the evaluator side, against the mirror clone.

---

## `grading`

`min_score` is the weighted 0–100 threshold. The per-dimension minimums operate on the raw 0–5
scale, and a single dimension below its minimum rejects the candidate **regardless of the total**.

`weights` must sum to 1. The weighted sum of the six 0–5 scores is rescaled to 0–100 by the
pipeline; the model never computes a total.

Rejection gates — external context dependence, no relevant tests, irreproducible environment,
multiple unrelated intents — are evaluated **before** the score and reject independently of it.
Environment facts measured from real runs override the model's opinion: if no fail-to-pass
evidence was measured, the candidate is rejected even if the grader praised the test coverage.

---

## `generation`

| Field | Default | Notes |
| --- | --- | --- |
| `language` | `en` | Only English. Real tool output is never translated. |
| `task_variants` | `1` | Variants of one commit stay in the same split. |
| `max_solver_attempts` | `2` | Each attempt starts from a **clean** container. |
| `max_user_questions` | `2` | `0` disables the `ask_user` tool entirely. |
| `decision_summaries` | `true` | Short validated summaries, never chain-of-thought. |
| `max_agent_turns` | `60` | Exceeding it aborts the attempt. |

Retries never receive the target patch or hidden-test feedback. A guided modality would be a
different dataset and would have to be labelled as one.

---

## `verification`

| Field | Default | Notes |
| --- | --- | --- |
| `acceptance_mode` | `exact_tree` | `exact_tree` \| `behavioral` \| `either` |
| `replay_required` | `true` | |
| `clean_runs` | `2` | Independent runs, each in a fresh container. |
| `strict_baseline` | `true` | A parent with pre-existing failures rejects the candidate. |
| `require_fail_to_pass` | `true` | Refactors are exempt by construction. |

With `strict_baseline: false`, pre-existing failures are recorded and excluded from the regression
comparison instead of rejecting the candidate.

See [verification.md](verification.md) for what each result does and does not claim.

---

## `sandbox`

| Field | Unit | Default |
| --- | --- | --- |
| `backend` | `docker` \| `local` | `docker` |
| `docker_command` | argv | `["docker"]` |
| `network_during_solve` | boolean | `false` |
| `cpu_limit` | cores | `2` |
| `memory_mb` | MiB | `4096` |
| `pids_limit` | processes | `256` |
| `task_timeout_seconds` | seconds | `1200` |
| `command_timeout_seconds` | seconds | `300` |
| `run_as` | `uid:gid` | `1000:1000` |
| `provision_timeout_seconds` | seconds | `1800` |
| `dependency_policy` | see below | `reject_new` |

`docker_command` is an argv prefix, so a daemon reachable some other way still works — for
example `["wsl", "-d", "Ubuntu", "-e", "docker"]` on a Windows host.

`run_as` must not be `0:0`. Memory swap is pinned to the same value as `memory_mb`, so a container
cannot exceed its memory budget by swapping.

**`backend: local` provides no isolation at all.** See [security.md](security.md).

### `dependency_policy`

What to do when reaching the target requires dependencies the parent does not declare:

- **`reject_new`** — discard with `env_dependency_unresolvable_offline`. The strict default.
- **`offline_store`** — **not implemented.** The value is accepted by the schema and rejected at
  run time with `env_dependency_unresolvable_offline` and a message that says so. Silently
  carrying on would provision from the *parent's* manifests and then run the solver with no
  network, so a candidate that genuinely needs a new dependency would fail for a reason the record
  would attribute to the agent.
- **`allow_network_during_solve`** — let the solver reach the network for that candidate. Recorded
  on the sample, so the relaxed isolation is visible in the dataset.

---

## `model`

`provider` and `model` are resolved by pi, so custom OpenAI-compatible providers declared in
`~/.pi/agent/models.json` work. `agent_dir` overrides where `auth.json` and `models.json` are read
from.

`thinking: "off"` keeps provider reasoning blocks out of the pipeline entirely.

`roles` overrides any of the seven roles individually; anything omitted falls back to the
top-level block.

| Role | Does |
| --- | --- |
| `grader` | scores candidate commits (sees the diff) |
| `taskgen`, `taskreview` | write the user request, then review it independently for sufficiency and leaks |
| `solver` | **the teacher**: produces the trajectories the dataset is built from |
| `user_simulator` | answers the agent's `ask_user` questions from the task's fact sheet |
| `judge` | scores trajectories against `prompts/judge/v1.md` (`forge judge`, `forge rollout`, `forge score`) |
| `policy` | the model under training or evaluation in `forge rollout`; falls back to `solver` |

A common setup is a strong solver, cheap generation roles, and a judge from a different model
family than the policy.

### Environment overrides

Host-specific settings do not belong in a shared config file. Two environment variables override
it at load time, before the config is hashed (so a different model is a different run identity):

| Variable | Effect |
| --- | --- |
| `FORGE_MODEL=provider/model` | sets `model.provider` and `model.model` (per-role overrides still win) |
| `FORGE_DOCKER_COMMAND="wsl -d Ubuntu -e docker"` | sets `sandbox.docker_command` |

---

## `budgets`

| Field | Unit | Default |
| --- | --- | --- |
| `max_total_tokens` | tokens | `2000000` |
| `max_total_cost_usd` | USD | `100` |
| `max_parallel_tasks` | concurrent candidates | `2` |
| `max_prepared_candidates` | candidates | unset |
| `max_wall_clock_seconds` | seconds | `0` (disabled) |

**The cost limit only constrains calls whose model has a published price.** A model with no price
produces `cost_known: false` and `cost_usd: null`; those calls are counted and reported but cannot
be charged against a dollar limit without inventing a number. The token, candidate and wall-clock
limits carry the load for them, and `forge report` says how many unpriced calls there were.

An explicitly declared price of zero — a self-hosted endpoint — is a *known* cost of zero, which
is different from an unknown price.

Budgets are checked before each candidate and before each solve attempt. Exhaustion stops the run
cleanly, records the cause, and reports the shortfall.

---

## `export`

| Field | Default | Notes |
| --- | --- | --- |
| `formats` | all four | `jsonl`, `conversations`, `openai_chat`, `rl_tasks`; see [training.md](training.md). |
| `split_by` | `repository_family` | `repository_family` \| `repository` \| `none` |
| `splits` | `{0.8, 0.1, 0.1}` | Must sum to 1. |
| `include_decision_summaries` | `true` | As assistant targets. |
| `include_posthoc_annotations` | `false` | Never targets either way. |
| `benchmark_exclusion_list` | `[]` | URLs or families. |
| `allowed_licenses` | `[]` | Empty allows anything positively detected. |
| `unknown_license_policy` | `pending_review` | `exclude` \| `pending_review` |
| `secret_policy` | `exclude` | `exclude` \| `redact` |
| `allow_fixture_provenance` | `false` | |

**Splits are assigned per group, never per sample**, so a task's variant cannot land in train while
the task lands in test. With few large groups the realised fractions will differ from the targets;
`run-manifest.json` records the real numbers.

`benchmark_exclusion_list` removes only what it names. It is **not** a guarantee that the dataset
is free of evaluation contamination, and the export README says so.

An unidentified license is flagged pending review rather than assumed permissive: a public
repository does not by itself authorise any particular use.

`secret_policy: redact` rewrites real tool output, which means the record stops being a faithful
account of what the commands produced. Such samples are therefore excluded anyway, with that
reason recorded, rather than shipped as if still verifiable.

The dataset is written locally. **Nothing is published or uploaded.**

---

## `judge`

| Field | Default | Notes |
| --- | --- | --- |
| `show_reference_patch` | `false` | Off: the tests establish correctness, and a judge anchored on one solution penalises valid alternatives. |
| `max_trajectory_chars` | `60000` | Rendered trajectory budget; the middle is elided, and says so, beyond it. |
| `max_diff_chars` | `30000` | Per diff. |
| `weights` | coverage 0.3, quality 0.25, verification 0.15, scope 0.1, honesty 0.1, efficiency 0.1 | Must sum to 1. |

The judge's verdict is schema-validated and the weighted score is computed by the pipeline. A
malformed verdict or a failed call never produces a score: the reward falls back to the verifiable
component.

## `reward`

| Field | Default | Notes |
| --- | --- | --- |
| `verifiable_weight` | `0.7` | Weight of the hidden-test result. |
| `judge_weight` | `0.3` | Only applied when the hidden tests pass. Must sum to 1 with the above. |
| `partial_credit` | `false` | Up to 0.5 of the verifiable component for a share of fail-to-pass checks, only with no regressions. |
| `zero_on_incomplete` | `true` | An agent loop that errored or timed out earns nothing. |
| `zero_on_deleted_tests` | `true` | Deleting a test file the hidden suite relies on earns nothing. Modifications (often legitimate: added cases) are reported and left to the judge. |
| `zero_on_reward_hacking` | `true` | When the judge flags special-casing, hard-coded outputs or weakened checks. |
| `cap_on_unsupported_claims` | `0.5` | Upper bound when the judge finds claims no tool output supports. |

## `rl`

| Field | Default | Notes |
| --- | --- | --- |
| `rollouts_per_task` | `4` | Overridden by `forge rollout --rollouts N`. Several per task give group advantages and pass@k. |
| `splits` | `[]` | Only roll out tasks in these splits; empty means all. Splits are assigned by `forge export`. |
| `judge_rollouts` | `true` | Off makes the reward purely verifiable. |
| `preference_margin` | `0.3` | Minimum best-minus-worst reward gap for a preference pair. |

---

## `cleanup`

A run creates one container per phase and one committed image per (repository, parent revision).
Nothing reclaims them automatically, so a hundred candidates leaves a hundred
multi-hundred-megabyte images for repositories that will never be touched again.

| Field | Default | Options |
| --- | --- | --- |
| `task_images` | `after_repository` | `after_repository` \| `after_run` \| `never` |
| `runtime_images` | `after_run` | `after_run` \| `never` |
| `repository_mirrors` | `after_run` | `after_repository` \| `after_run` \| `never` |
| `solution_snapshots` | `after_export` | `after_export` \| `never` |
| `containers` | `always` | `always` \| `never` |
| `base_images` | `never` | `after_run` \| `never` |

The defaults keep exactly the dataset and the evidence for it:

- the exported JSONL and the run manifest
- the run database: population manifest, rejections with causes, usage ledger
- command logs, test reports and patches in the artifact store

Everything reconstructible goes: task images, runtime images, mirror clones, and the full
workspace snapshots. The solution **patch** is always kept, so each change stays inspectable even
after its snapshot is pruned.

**What is never touched:** images are removed only when this run recorded building them, and
containers only when they carry this tool's own label. An unrelated image or container on the same
daemon is safe.

### Trade-off

With `task_images: after_repository`, `forge replay --sample` cannot start immediately: the image
it would start from is gone. The command says so explicitly and points at `forge prepare`, which
rebuilds it — the stage cache notices the missing image and redoes the work. Set the field to
`never` to keep replay instant, at the cost of disk.

### Orphans

A run killed before it could record an image, or one whose workspace was deleted, leaves images
nothing else will ever reclaim. Every cleanup reports how many such orphans it found.
`forge clean --orphans` removes them. It is opt-in because a concurrent run sharing the same
daemon would have its images pulled out from under it.

```bash
forge clean --config config/example.yaml            # what this workspace recorded
forge clean --config config/example.yaml --orphans  # plus anything else tagged forge-*
```
