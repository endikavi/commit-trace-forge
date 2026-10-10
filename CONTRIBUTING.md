# Contributing

Thanks for helping. The bar for changes here is the same one the tool applies to its data: if a
claim cannot be checked, it does not go in.

## Setup

```bash
pnpm install
pnpm check              # typecheck + unit tests, no containers, no model
pnpm test:integration   # real containers; skipped loudly when docker is unavailable
```

Node.js >= 22.19, pnpm and git are required. Integration tests need a working container runtime;
on Windows with docker inside WSL, set `FORGE_DOCKER_COMMAND="wsl -d Ubuntu -e docker"`.

## Ground rules

- **Never fabricate execution.** Tool output, test results, exit codes and replay outcomes come
  from real commands. A stage that cannot run reports itself as pending; it does not produce a
  plausible answer.
- **Nothing reserved reaches the policy or the training messages.** Target SHAs, target patches,
  hidden tests and reward specs live in their own files, written by their own code paths. If you
  add a field to a policy-facing record, add a test that proves it carries nothing reserved
  (see `test/unit/training.test.ts`).
- **Every discard has a cause.** New rejection paths add a value to `REJECTION_CAUSES` in
  `src/util/errors.ts` and show up in `forge report`.
- **Prompts are versioned.** Editing `prompts/<role>/vN.md` in place silently changes past
  results; add `vN+1.md` and bump `PROMPT_VERSIONS` in `src/storage/versions.ts`.
- **Stage behaviour changes bump `IMPL_VERSIONS`**, so cached results that no longer apply are
  recomputed rather than reused.

## Pull requests

- Keep each PR to one concern, with tests for the behaviour it adds or fixes.
- Run `pnpm check` before pushing; CI runs it plus the container integration tests.
- Describe what you verified and how. If something could not be verified (no GPU, no API key,
  no container runtime), say so in the PR rather than leaving it implied.

## Adding an ecosystem

Ecosystems are recipes in `src/environments/recipe.ts`. A new one needs: manifest detection, an
image setup that installs only the runtime and test runner, install commands that run with
network during provisioning, a test command that emits a machine-readable report (JUnit XML
preferred), and integration coverage against a small deterministic repository.
