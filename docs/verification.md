# Verification

Three independent results are computed and stored **separately**. None implies another.

| Field | Question it answers |
| --- | --- |
| `exact_tree_match` | Did the solver reconstruct the target's versioned tree byte for byte? |
| `behavioral_checks_passed` | Does the solution satisfy the relevant checks without regressing? |
| `replay_passed` | Does re-executing the recorded actions from a clean start reproduce the result? |

`acceptance_mode` decides which of the first two must hold. `replay_required` decides whether the
third is mandatory. A sample is accepted only when the configured modality holds **and** the clean
runs completed **and** replay passed (when required).

---

## A. Exact reconstruction

### What is compared

The **git tree hash** of the solver's workspace against the git tree hash of the target commit.

A git tree hash covers, by construction:

- file contents, byte for byte
- the executable bit — `100644` and `100755` are different modes and produce different trees
- symlinks — mode `120000`, with the link target stored as the blob content
- the exact set of paths, so both additions and deletions are covered

So a single hash comparison settles the whole question. When the hashes differ, the trees are
enumerated and a per-path difference list is produced (`missing`, `unexpected`, `content_differs`,
`mode_differs`, `type_differs`) for the report.

### What is NOT required

**Commit SHA equality.** The solver's commit has different metadata, a different parent, a
different author and a different timestamp. None of that says anything about the files. Requiring
it would reject every correct solution.

### What is NOT allowed

**No normalisation.** Whitespace, trailing newlines and line endings are compared as-is. A
solution that differs only in formatting is *not* an exact reconstruction.

A whitespace-insensitive comparison is computed separately and stored as
`normalized_tree_match`. It is a **diagnostic**: it tells a reader "this differs only in
formatting" and it can never turn a non-exact result into an exact one.

**No repair.** The target patch is never copied into the solver's workspace, and the solver's
result is never touched with information from the target.

### The one thing that would break this

`git add -A` respects `.gitignore`. If the target commit adds a path that the parent's
`.gitignore` would exclude, the solver could never stage it, and a correct solution would look
wrong. That case is screened out at mining time with cause `target_path_gitignored`, on the
evaluator side, against the mirror clone — nothing leaks into the sandbox.

---

## B. Functional equivalence

Runs in a container the solver never touched, over a **copy** of the solver's result.

### Bugs and features

At least one check must **fail at the parent and pass at the target**. That evidence is
established during preparation, by running the target's test files against the parent's source
in an already-provisioned container:

```
parent code + parent tests   ->  baseline (must be green in strict mode)
target code + target tests   ->  objective (must be green)
parent code + target tests   ->  the tests that fail here are the fail-to-pass set
```

Because the container is provisioned before the probe runs, **an installation failure cannot be
mistaken for behavioural evidence**. A test that errors on import because a dependency is missing
is not a fail-to-pass test.

A solution is then required to make those same tests pass, identified by the same test ids.

### Refactors

A refactor has no fail-to-pass test by construction, and demanding one would be manufacturing
evidence the change was never meant to provide. Refactors are judged on:

- **behaviour preservation** — the full reference suite stays green
- **a structural objective** — the workspace actually changed relative to the parent

### Regressions

Tests that passed at both the parent and the target must still pass. Failures that already existed
at the parent (`preexisting_failures`) are excluded from this comparison, so a candidate is never
blamed for breakage it inherited. In strict mode such candidates are discarded anyway.

### Hidden tests and tampering

Hidden tests are the test files **as they exist at the target commit**. They are written into the
verification container *after* the solution copy is in place, so:

- the solver never saw them
- the solver cannot modify them
- deleting or weakening a visible test does not avoid evaluation

Tampering is separately detected by comparing the solver's copy of each test path against the
parent's version, and recorded as `visible_tests_tampered` with the affected paths.

### The label

A passing result is labelled `behaviorally_verified`. That is a claim about the checks that ran.
It is **not** a claim of universal equivalence, and it is **not** a claim of exact reconstruction.

---

## C. Replay

From a clean environment:

1. restore the parent state and the prepared image
2. re-execute the recorded tool calls, in order
3. reuse the recorded synthetic-user answers
4. compare preconditions and stable results
5. verify the final tree and re-run the suite

### What replay is not

- Copying the final patch into the workspace.
- Replaying stored logs.

Every command runs again for real, against a real container.

### What may vary

Timestamps and durations. `duration_ms` is excluded from comparison by explicit policy.

### What may not vary

Anything that changes what happened:

| Divergence | Meaning |
| --- | --- |
| `precondition_mismatch` | the starting state could not be restored |
| `exit_code_mismatch` | a command exited differently |
| `tool_result_mismatch` | a tool produced a different structural result, or errored differently |
| `missing_event` | a recorded call has no result, or a tool is unavailable |
| `final_tree_mismatch` | the replayed workspace does not hash to the original result |
| `test_result_mismatch` | the final suite verdict changed |

Any divergence sets `replay_passed: false`.

### What "structural result" means, precisely

The comparison runs over each tool's structured output, minus `duration_ms`. For `read_file`,
`list_files`, `search` and `apply_patch` that is the content itself. For `run_command` it is
`exit_code` and `timed_out`: **stdout and stderr text is not compared**, because legitimate
programs print timings, addresses and measurements that differ on every run. A command that prints
different text but exits the same way does not diverge; the final tree hash and the final suite
verdict still have to match. `forge score` applies a stricter content comparison to external
trajectories, with run-to-run noise masked (see [training.md](training.md)).

### Execution order

The agent loop executes tool calls **sequentially, in the order the model issued them** — the
order the trajectory records and replay re-executes. pi's default is to run the calls of one turn
in parallel; the adapter overrides that per tool, so a test run can never race a file edit and
record a result no sequential re-execution could reproduce.

### Replay is not re-solving

Replay re-executes **recorded actions**. It does not ask the model again.

A second autonomous run with the same seed is a different thing, and this is stated explicitly
because it is easy to conflate: **a seed does not make a provider's generation identical.** Model
sampling, server-side batching and model updates all move. Replay is deterministic because it
replays actions; re-solving is not, and is never reported as replay.

In replay, the synthetic user returns the **recorded** answers, matched by question text. A
question whose wording does not match any recorded question is itself recorded as a divergence,
rather than being silently answered with something plausible.

---

## Clean runs

`verification.clean_runs` independent runs of the reference suite over the solution, each in a
fresh container. A suite that only passes sometimes is not evidence. The number that actually
completed is stored as `clean_runs_completed`, and acceptance requires it to equal the configured
count.

---

## What a score does not do

`grading.min_score` selects candidates worth spending compute on. It is an LLM's opinion about a
commit.

It never establishes that the produced trajectory is correct. Acceptance requires the environment
to have been verified, the tools to have actually executed, the relevant tests to exist, the
acceptance modality to be satisfied, and replay to pass. **No score substitutes for any of
these.**
