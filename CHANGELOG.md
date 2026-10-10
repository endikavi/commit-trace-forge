# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/).

## [0.2.0] — 2026-10-11

### Added

- **Training exports.** `sft-openai.jsonl`: trajectories in OpenAI chat format with the exact system
  prompt, the tool definitions and `weight: 1` on assistant turns only, ready for SFT or
  teacher → student distillation. `conversations.jsonl` now carries the system prompt and tools too.
- **RL exports.** `rl-tasks.jsonl` (prompt, tools, container image, limits — nothing reserved) and
  `rl-reward-spec.jsonl` (hidden tests, acceptance criteria, reference tree — reserved).
- **LLM judge.** `forge judge` scores accepted trajectories against a versioned rubric
  (`prompts/judge/v1.md`): requirement coverage, solution quality, verification discipline, scope
  discipline, communication honesty and efficiency, plus reward-hacking and unsupported-claim
  flags. Scores land in the SFT exports for filtering.
- **Rollouts.** `forge rollout` runs a policy model N times per verified task, verifies each result
  against the hidden tests, judges it and computes a reward. Writes `rollouts.jsonl` with
  group-relative advantages, `preferences.jsonl` (best-vs-worst pairs, TRL conversational DPO
  format) and `rollout-stats.json` (pass rate, pass@k, mean reward).
- **External scoring.** `forge score` re-executes an external agent's trajectory (OpenAI messages or
  forge events) from the task's starting state and returns its reward, reporting any supplied tool
  result that differs from re-execution.
- **Reward composition** (`reward` config block): hidden tests lead, the judge only contributes when
  they pass, and tampered tests, suspected reward hacking and unsupported claims are gated.
- `model.roles.judge` and `model.roles.policy`.
- `FORGE_MODEL` and `FORGE_DOCKER_COMMAND` environment overrides for host-specific settings.
- Example configurations for real repositories: `config/examples/{xmltodict,sqlparse,tomli,python-starter}.yaml`.
- LICENSE (MIT), CI, contribution and security guides.

### Fixed

- **The host working directory leaked into the agent's system prompt.** pi appends
  `Current working directory: <cwd>` to custom prompts; that cwd was a temporary directory on the
  host, so the agent saw (and tried to `cd` into) a host path that does not exist inside the
  container, and the path — including the host user name — ended up in trajectories. The adapter
  now pins the exact prompt through pi's `before_agent_start` hook.
- **Tool calls of one turn ran in parallel.** pi executes the tool calls of an assistant turn
  concurrently by default, while the trajectory records — and replay re-executes — them in order.
  A test run could race a file edit and record output no sequential re-execution reproduces. Every
  forge tool now declares `executionMode: "sequential"`.
- **Tool calls pi answered itself were lost.** When pi refuses a call without executing it (invalid
  arguments, unknown tool, or arguments cut off by the output-token limit) the model sees an error,
  but the trajectory recorded nothing and replay then *executed* the call, diverging. These answers
  are now recorded with the new `harness` origin, and replay and `forge score` skip them.
- **A second run in the same workspace processed no candidates.** Candidate ids are content-derived
  so stage caches carry across runs, but a re-drawn candidate stayed attached to the earlier run.
  It now moves to the run that drew it, keeping its cached stages.
- `forge run` without `--resume` reused the latest run for the same configuration and mined into it
  again, double-counting mining rejections. It now starts a new run.
- Read-only commands (`report`, `export`, `replay`, ...) re-registered the run and flipped a finished
  run's status back to `running`. They no longer register runs, and they fall back to the latest
  run with accepted samples when the configuration changed since.
- `quality.tools_executed` counted any tool result; it now counts only sandbox executions.
- `run-manifest.json` recorded the absolute path of the configuration file; it is now relative.

## [0.1.0] — 2026-09-13

Initial version: mining, environment preparation, grading, task generation, solving with pi,
exact/behavioural/replay verification, dedup, secret scanning, splits and export.
