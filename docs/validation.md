# What has actually been executed

An account of what has run for real against this code, and what has not. Every number below comes
from a command that was executed and whose output was read. Nothing is a projection.

Last updated for **v0.2.0**.

## Environment

| | |
| --- | --- |
| Host | Windows 11, Node.js 24.13, pnpm 12.4, git 2.44 |
| Containers | Docker 29.3 inside WSL2 (`FORGE_DOCKER_COMMAND="wsl -d Ubuntu -e docker"`) |
| Agent loop | `@earendil-works/pi-coding-agent` 0.85.1, pinned in `pnpm-lock.yaml` |
| Model | one small self-hosted model (a Qwen-family "flash" model behind an OpenAI-compatible endpoint) in **every** role: teacher, policy, judge, grader, task writer, reviewer, simulated user |

## Automated tests

```
pnpm test:unit          116 passed    no containers, no model
pnpm test:integration    25 passed    real containers, scripted harness, no model
```

The integration tests assert the properties that matter, including the negative ones: the
workspace holds one commit and no remotes; `git log --all`, `reflog`, `fsck --lost-found` and
`rev-list --all` leak nothing; neither the target SHA nor the commit subject is readable by the
agent; commands run as uid 1000 with no network and no host mounts; a functionally equivalent but
different solution, or a whitespace-only difference, does not pass as exact; a planted JUnit report
does not satisfy the verifier; deleting the visible tests does not let a wrong solution pass; a
replay with a divergent tree, start state or exit code is rejected.

## End to end: `config/examples/xmltodict.yaml`

The full pipeline against the real repository, real containers and the model above. Output in
[`examples/xmltodict/`](../examples/xmltodict/), with a per-candidate account in its README.

| Step | Result |
| --- | --- |
| `forge run` | 40 commits examined, 10 drawn, **3 accepted** (all by behaviour, all replayed, 2 clean runs each); 7 rejected, each with a cause |
| `forge judge` | 3 verdicts, all schema-valid, every dimension citing event ids or diff lines; scores 0.89–0.96 |
| `forge export` | all six files; 0 reserved strings in training or policy-side files; 0 non-assistant training targets; 0 host paths |
| `forge rollout --rollouts 2` | 6 rollouts: pass rate 83%, pass@2 100%, mean reward 0.82, 1 preference pair; the failing rollout got reward 0 despite a 0.56 judge score |
| `forge score`, unmodified teacher trajectory | every tool call re-executed from a clean container: **0** output mismatches, reward 0.973 |
| `forge score`, one tool output fabricated | **1** mismatch reported, exactly the fabricated one |

## Environment preparation: the other example configurations

`forge mine` + `forge prepare` (no model involved): image build, parent and target installs,
baseline and target test suites, fail-to-pass probe.

| Config | Drawn | Environments verified | Rejected |
| --- | --- | --- | --- |
| `sqlparse.yaml` | 19 | 17 | 2 × `env_dependency_unresolvable_offline` (commits that change dependency manifests) |
| `tomli.yaml` | 9 | 9 | 0 |

These two have **not** been run through grading, solving and verification yet.

## Defects found by running for real

Running against real repositories and a real model found defects that reading the code had not.
All are fixed and, where a unit test can express them, covered.

1. **The host's temporary directory leaked into the agent's prompt.** pi appends
   `Current working directory: <cwd>` to custom system prompts; the cwd was a host temp directory,
   so the agent tried to `cd` into a Windows path that does not exist in the container, and the
   path — including the host user name — landed in the trajectories.
2. **Tool calls of one turn ran in parallel**, while the trajectory records and replay re-executes
   them in order. Found by `forge score`: a doctest reported a different line number on
   re-execution because, originally, it had raced a file edit.
3. **Tool calls pi answered without executing them were lost** (arguments cut off by the output
   token limit, in this case). The model saw an error, the trajectory recorded nothing, and replay
   then *executed* the call and diverged.
4. **Snapshot files were dated 1970.** Rewriting tar ownership dropped the modification time, and
   zip-based Python build backends (flit, hatchling) refuse dates before 1980: every tomli
   candidate failed `pip install -e .` with `env_parent_install_failed`.
5. **A second run in the same workspace processed no candidates**, because content-derived
   candidate ids stayed attached to the earlier run.
6. **`forge run` re-mined into the previous run** with the same configuration, double-counting
   mining rejections; read-only commands flipped finished runs back to `running`.
7. **Modifying an existing test file zeroed the reward**, although adding cases is legitimate and
   the hidden copy is restored before evaluation. Only deletion is now gated.
8. **Comparing re-executed output verbatim flagged timing noise** (`127 passed in 0.58s` vs
   `0.63s`, `ls` dates). Comparison now masks volatile tokens and treats exit-code differences as
   the hard signal.

Defects found while the tool was first built (v0.1.0) included `apply_patch` reporting success
without applying anything, tool events ordered before the assistant messages that issued them,
snapshots extracted over a populated workspace, replay starting from a different state than the
solver, and root-owned files breaking `pip install` for the unprivileged user.

## What has NOT been verified

Stated plainly, because these are gaps and not features:

- **Only one model family has been exercised**, and a small one, in every role at once. The
  adapter resolves any pi provider and `forge doctor` checks credentials, but no Anthropic or OpenAI
  model has run a full pipeline here. Judge scores from a small model are lenient; use a stronger
  judge from a different family than the policy.
- **Only Python/pytest has run end to end.** The JS/TS recipe is implemented and requires a
  declared test command, but no JS/TS repository has been taken through a run.
- **`sqlparse.yaml`, `tomli.yaml` and `python-starter.yaml`** have been validated through
  environment preparation (the first two) or configuration loading (the last), not through solving.
- **No real multi-repository run.** Balancing, per-repository caps and family-level splits are
  unit-tested only. With a single repository every sample lands in one split.
- **`forge score` with a trajectory from a different agent harness.** It has been exercised with
  trajectories exported by forge itself (OpenAI messages), real and tampered.
- **No training run.** The SFT, DPO and rollout files follow the formats TRL and the OpenAI
  fine-tuning API document, but no model has been trained on them here.
- **The local sandbox backend** (no isolation) has not been exercised end to end.
- **`dependency_policy: offline_store` is not implemented.** It is accepted by the schema and
  rejected at run time with an explicit cause.
- **Scale.** The largest runs here are tens of candidates. Behaviour at thousands is bounded by the
  budget machinery, which is unit-tested, but has not been measured.
