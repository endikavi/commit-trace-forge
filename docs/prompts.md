# Prompts

One directory per role, one file per version:

```
prompts/
  grader/v1.md
  taskgen/v1.md
  taskreview/v1.md
  solver/v1.md
  user_simulator/v1.md
  judge/v1.md
```

The active version per role is declared in `src/storage/versions.ts` (`PROMPT_VERSIONS`).

## Why they are versioned and hashed

Both the version string and the SHA-256 of the file's contents feed the stage input hash. Editing
a prompt therefore invalidates exactly the cached artifacts that depended on it — a changed task
generator invalidates task generation and everything downstream — while leaving unrelated caches,
and any still-valid container image, untouched.

`run-manifest.json` in every export records the version and hash of each prompt, so a dataset can
always be traced back to the exact text that produced it.

## The roles

### `grader` — structured commit evaluation

Sees the parent state and the target diff; the only stage allowed to. Returns six 0–5 dimension
scores with evidence, plus independent rejection gates. It is explicitly told **not** to compute a
total: the pipeline applies the configured weights, so a model cannot move the threshold by
arithmetic.

Its output is schema-validated. A free-form comment is never accepted as an evaluation.

### `taskgen` — request generation

Sees the target diff. Writes what the *user wants*, never what the *patch does*.

Allowed: public API names, file paths and module names a real user would know. Forbidden:
transcribing the patch, naming a private helper the patch introduces, referring to "this commit"
or its SHA, and inventing a production incident, a ticket or a deadline as fact.

May decline, returning `{ "reject": true, "reason": "..." }`, when a commit bundles intents that
no single coherent request could describe. Stitching unrelated changes into one artificial request
is explicitly ruled out.

### `taskreview` — independent review

A separate call with its own prompt. Sees the request **and** the target diff, and decides whether
the request is sufficient, coherent and leak-free before any solve attempt is allowed to start.

It is not the only line of defence: a deterministic scan (`src/taskgen/leak.ts`) runs alongside
it, looking for commit SHAs, quoted subjects, private identifiers the patch introduces, and
verbatim patch lines. The deterministic finding can only tighten the verdict, never loosen it.

### `solver` — the agent

Sees the parent state and the request. Nothing else.

Tells the agent that tool results are evidence and must not be assumed, that existing tests must
not be deleted to make a failure go away, and that `ask_user` is for questions that would change
what gets built — not for narrating progress.

Defines the decision-summary format and its rules: 30–90 words, observations grounded in evidence
already obtained, no anticipating a command's result, no narrating deliberation, no summary after
every tool call. Length is explicitly not rewarded.

### `user_simulator` — the simulated user

The narrowest view in the system. Receives the original request, the reviewed `user_fact_sheet`,
the question, and the visible conversation. It never receives the patch, the target, or any
evaluator output — so it *cannot* steer the solver toward the historical implementation, because
it has never seen it.

Told to answer briefly, to admit not knowing, and never to invent a requirement that was not in
the request or the fact sheet.

## Adding a version

1. Write `prompts/<role>/v2.md`.
2. Bump the role in `PROMPT_VERSIONS`.
3. Run the pipeline. Stages depending on that prompt recompute; images and unrelated stages do not.

Old versions stay on disk, so a dataset produced with `v1` remains explicable.

## Language

Every synthetic text — the request, clarification answers, decision summaries — is English, and
each prompt states so. Real tool output, code and logs are kept in their original form and are
never translated.

### `judge` — trajectory evaluation

Sees the request, the acceptance criteria, the full trajectory with event ids, the diff of the
final workspace and the **measured** hidden-test results, which it is told are ground truth. It
scores six 0–5 dimensions — requirement coverage, solution quality, verification discipline, scope
discipline, communication honesty, efficiency — each with evidence that must cite event ids or diff
lines, and raises two flags: suspected reward hacking and unsupported claims.

Like the grader it does not compute a total; the pipeline applies `judge.weights`. It does not see
the historical patch unless `judge.show_reference_patch` is set. Its verdict feeds `forge judge`
(SFT filtering) and the reward in `forge rollout` / `forge score`; see [training.md](training.md).
