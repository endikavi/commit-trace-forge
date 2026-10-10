# commit-trace-forge

[![ci](https://github.com/endikavi/commit-trace-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/endikavi/commit-trace-forge/actions/workflows/ci.yml)
![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![node >= 22.19](https://img.shields.io/badge/node-%3E%3D22.19-339933.svg)

**Turn real git history into verified agentic coding tasks** — teacher trajectories for supervised
fine-tuning and distillation, and reward-scored environments for reinforcement learning with an
LLM judge.

Every task starts from a real commit's parent, inside a container. An agent works on a natural
request written from the change, and everything it does — every command, file read, patch and
test run — **actually executes**. A trajectory is kept only if hidden tests pass in a clean
container and a replay of its recorded actions reproduces the same result.

```
git history ─▶ mine ─▶ prepare ─▶ grade ─▶ generate ─▶ solve ─▶ verify ─▶ export
                │         │          │          │          │         │         │
          deterministic  container  LLM rubric  request +  teacher   hidden   SFT + RL
          filters        image +    on the      independent agent    tests,   formats
                         baseline   commit      leak review  run     replay
                         tests
                                                                      ┌─▶ forge judge    LLM judge on teacher traces
                                              verified tasks ─────────┼─▶ forge rollout  policy × N, verify, judge, reward
                                                                      └─▶ forge score    reward any external trajectory
```

## Why

Agent training data usually fails in one of two ways: it is **synthetic all the way down** (a model
imagines the terminal output, so a student learns to hallucinate command results), or it is
**unverifiable** (nobody checked that the trajectory actually solved anything). This tool takes the
opposite position:

| | Origin |
| --- | --- |
| User request, clarification answers, decision summaries | **synthetic** — written by a model, labelled `origin` on every event |
| Tool results, file changes, test outcomes, exit codes | **real execution** — never written by a model |
| Correctness | **hidden tests** in a container the agent never touched, plus deterministic replay |
| Process quality | **LLM judge** with a versioned rubric — refines rewards, never overrides tests |

Nothing fabricates terminal output, a passing test or a replay result. Discards, failures and costs
are recorded with machine-readable causes and reported next to the successes.

## Two uses, one pipeline

**Distillation / SFT.** Run a strong model as the *teacher* (`model.roles.solver`). Export
`sft-openai.jsonl`: OpenAI chat format with the exact system prompt, the tool definitions and
`weight: 1` on assistant turns only. Optionally `forge judge` the traces and keep the best.

**Reinforcement learning.** Export `rl-tasks.jsonl` (prompt, tools, container image, limits) and
roll out a *policy* with `forge rollout` — N attempts per task, each verified against hidden tests,
judged, and rewarded — or run your own trainer and call `forge score` as the reward function. You
get `rollouts.jsonl` with group-relative advantages (GRPO-style), `preferences.jsonl` for DPO, and
pass@k for evaluation.

Full guide: **[docs/training.md](docs/training.md)**.

## Quick start

Requirements: Node.js ≥ 22.19, pnpm, git, Docker, and a model reachable through
[pi](https://github.com/earendil-works/pi) — a provider API key, or any OpenAI-compatible endpoint
(vLLM, SGLang, Ollama, ...) declared in `~/.pi/agent/models.json` ([how](docs/pi-adapter.md)).

```bash
pnpm install

# Optional host settings, so config files stay portable:
export FORGE_MODEL="anthropic/claude-sonnet-4-5"       # any pi provider/model
# export FORGE_DOCKER_COMMAND="wsl -d Ubuntu -e docker" # Windows, docker inside WSL

pnpm forge doctor  --config config/examples/xmltodict.yaml   # runs a real container and a real model call
pnpm forge run     --config config/examples/xmltodict.yaml   # verified tasks + teacher traces
pnpm forge judge   --config config/examples/xmltodict.yaml   # LLM judge on the teacher traces
pnpm forge export  --config config/examples/xmltodict.yaml   # SFT + RL files
pnpm forge rollout --config config/examples/xmltodict.yaml --rollouts 4   # policy rollouts with rewards
```

### Example configurations

Real, pinned repositories chosen to be interesting and cheap to reproduce — pure Python, static
build metadata, fast pytest suites, no services:

| Config | Repository | Why it is a good task source |
| --- | --- | --- |
| [`xmltodict.yaml`](config/examples/xmltodict.yaml) | [martinblech/xmltodict](https://github.com/martinblech/xmltodict) | One module; small parsing/unparsing fixes, each with a regression test |
| [`sqlparse.yaml`](config/examples/sqlparse.yaml) | [andialbrecht/sqlparse](https://github.com/andialbrecht/sqlparse) | Lexer and grouping fixes that require reading an unfamiliar token pipeline |
| [`tomli.yaml`](config/examples/tomli.yaml) | [hukkin/tomli](https://github.com/hukkin/tomli) | Spec-driven changes with unambiguous tests |
| [`python-starter.yaml`](config/examples/python-starter.yaml) | all three | Splits fall along repository lines; a first teacher → student or RL experiment |

`config/fixture.yaml` runs against a deterministic, locally generated repository whose history
contains usable commits **and one instance of every rejection class** (`pnpm fixture` builds it).

## Commands

```text
forge doctor                                   runtime, git, containers, model provider, limits
forge init     [--dir DIR]                     write a commented starter configuration
forge run      --config FILE [--resume]        the whole pipeline
forge mine | prepare | grade | generate | solve | verify | export   --config FILE   one stage at a time
forge replay   --sample ID --config FILE       re-execute one trajectory in a clean environment
forge report   --config FILE                   candidates, rejections by cause, cost, distributions
forge judge    --config FILE                   LLM judge on accepted teacher trajectories
forge rollout  --config FILE [--rollouts N] [--split S]   policy rollouts, verified, judged, rewarded
forge score    --config FILE --trajectory FILE --task ID   reward an external agent's trajectory
forge clean    --config FILE [--orphans]       remove the containers, images and mirrors it created
```

Every stage is resumable and memoised: `--resume` continues the latest run for a configuration;
stages whose inputs did not change are reused, and stages an earlier exit left mid-flight are
retried, never treated as done.

## Output

```
<workspace>/export/<run>/
  sft-openai.jsonl           OpenAI chat format: system prompt, tools, weight on assistant turns
  conversations.jsonl        provenance-labelled messages with per-message `train` masks
  samples.jsonl              canonical records: every attempt, every event, every verification result
  rl-tasks.jsonl             RL environments: prompt, tools, image, limits — nothing reserved
  rl-reward-spec.jsonl       RESERVED: hidden tests, acceptance criteria, reference tree
  evaluator-manifest.jsonl   RESERVED: target SHAs, target patches, grader output
  run-manifest.json          prompt versions and hashes, backend, isolation notes, splits
  README.md                  provenance, licensing and contamination notes

<workspace>/rollouts/<run>/
  rollouts.jsonl             messages, reward breakdown, judgment, group advantage
  preferences.jsonl          best-vs-worst pairs per task (TRL conversational DPO format)
  rollout-stats.json         pass rate, pass@k, mean reward
```

Reserved files are written by separate code paths from the training and policy views; the builders
of those views never receive them. Tests assert that no target SHA, commit subject, hidden test or
acceptance criterion reaches a policy-side record. A sample of real output is in
[`examples/`](examples/).

## What makes a sample acceptable

All of these, independently: a verified environment (parent installs, baseline green, target
installs, target green); a task the independent reviewer found sufficient and coherent; no solution
leak, by the reviewer **and** by a deterministic scan; tools that actually ran; relevant
fail-to-pass tests; the configured acceptance modality (`exact_tree`, `behavioral` or `either`); the
configured number of clean test runs; and, when required, a replay that reproduces every tool
result and the final tree. **An LLM score never substitutes for any of these.**

[docs/verification.md](docs/verification.md) explains the three verification results and why none
implies another.

## How the agent is kept from the answer

The parent state leaves the repository through `git archive` — contents and modes, no git objects —
and a brand-new single-commit repository is initialised over it inside the container. Before the
agent starts, an audit asserts there is no route to the target: one commit, no remotes, no
reflog, no dangling objects, no occurrence of the target SHA. The solve phase runs with no network
as a non-root user with all capabilities dropped.

The agent loop is [pi](https://github.com/earendil-works/pi), used only as a loop: every
auto-discovery mechanism is off, its built-in tools are disabled, and the agent gets exactly six
forge tools (`read_file`, `list_files`, `search`, `apply_patch`, `run_command`, `ask_user`), all
executing inside the container. A file in the repository under test is task data; it cannot change
the agent's instructions. The `AgentHarness` interface keeps pi swappable.

Details and limits: [docs/security.md](docs/security.md).

## Configuration

[`config/example.yaml`](config/example.yaml) is annotated field by field and
[docs/config.md](docs/config.md) documents units and interactions. Worth knowing up front:

- **`sampling.target_samples` counts accepted samples**, not commits inspected. Most candidates die
  in preparation, grading or verification; a shortfall is reported with its reason.
- **`budgets.max_total_cost_usd` only constrains calls with a known price.** Unknown prices are
  recorded as unknown (`cost_usd: null`), never guessed.
- **Images are reclaimed by default** (`cleanup`). Set `cleanup.task_images: never` to keep
  `replay`, `rollout` and `score` instant; otherwise `forge prepare` rebuilds what they need.

## Supported ecosystems

Python with pytest, and JavaScript/TypeScript with a declared test command. Anything else is
rejected with `env_recipe_undetected` rather than processed on a guess: a repository without an
automated test suite cannot produce a verifiable task.

## Development

```bash
pnpm check              # typecheck + unit tests (no containers, no model)
pnpm test:integration   # real containers: isolation, verification and replay properties
pnpm smoke:pi           # one real model call through the adapter
```

The integration tests assert the properties that matter, including the negative ones: the agent
cannot recover the target; a fabricated JUnit report does not satisfy the verifier; deleting tests
does not let a wrong solution pass; a functionally equivalent but different solution does not pass
as exact; a divergent replay is rejected.

```
src/
  sources/ mining/        repository acquisition, git plumbing, filters, sampling
  environments/ sandbox/  recipes, images, test running, docker and local backends
  grading/ taskgen/       commit rubric, request generation, review, deterministic leak scan
  harness/ user-simulator/  agent interface, pi adapter, the six tools, simulated user
  verification/           exact tree, behavioural checks, replay
  judging/ rewards/ rl/   LLM judge, reward composition, rollouts and external scoring
  dataset/ storage/ cli/  exports, dedup, splits, secret scan, SQLite state, commands
prompts/<role>/<version>.md   versioned, hashed prompts (grader, taskgen, taskreview, solver, user_simulator, judge)
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

## Limits, stated plainly

- Container isolation is **configured, not guaranteed**. Mine untrusted repositories on a
  disposable host.
- The judge is a model: noisy, and potentially biased towards its own family. Keep its weight
  modest, prefer a different family from the policy, and read the evidence it cites.
- A benchmark exclusion list removes only what it names; it is not proof of no contamination.
- An unidentified license is flagged pending review, not assumed permissive. Respect the licenses
  of the repositories you mine.
- Secret scanning uses pattern detectors; a clean scan means those detectors found nothing.
- Replay is deterministic because it replays actions. A second model run is not, and is never
  reported as a replay.

[docs/validation.md](docs/validation.md) records what has actually been executed end to end, and
what has not.

## License

[MIT](LICENSE).
