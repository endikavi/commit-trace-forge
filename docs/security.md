# Isolation and information control

Two separate problems, deliberately kept separate:

1. **Containment** — the repositories under test are untrusted code. Their build scripts, test
   suites and conftest files execute.
2. **Information isolation** — the solver must not be able to recover the historical solution, by
   any route.

## 1. Containment

### What the docker backend configures

| Control | Setting |
| --- | --- |
| User | `--user <run_as>`, a non-root uid:gid. Never 0. |
| Capabilities | `--cap-drop ALL`. Nothing is added back. |
| Privilege escalation | `--security-opt no-new-privileges` |
| Privileged mode | Never used |
| CPU | `--cpus <cpu_limit>` |
| Memory | `--memory <memory_mb>m --memory-swap <memory_mb>m` (swap disabled) |
| Processes | `--pids-limit <pids_limit>` |
| Network during solve | `--network none` by default |
| Host filesystem | **No bind mounts at all** |

No host path is mounted. Not the docker socket, not `~/.pi`, not a shared package cache, not the
workspace. Files move in and out over tar streams on the container CLI's stdin/stdout, so a
container cannot write to the host even by accident, and two tasks cannot reach each other's
state through a shared writable cache.

### Why there is no `chown` step

The workspace arrives as a `git archive` tar, which records owner 0. The container runtime
preserves the tar's uid/gid on extraction, so the files would land root-owned while every task
command runs unprivileged. Rather than run `chown` as root inside the container — which would
require adding `CAP_CHOWN` back after dropping all capabilities — the archive's ownership headers
are rewritten on the host before the copy (`retarWithOwner`). No process ever runs as root inside
a task container.

### Provisioning versus solving

Dependency installation needs the network. Solving and verification must not have it. These are
separated by freezing the provisioned container into an image:

```
container (network: bridge)   ->   install dependencies   ->   docker commit   ->   task image
task image  ->  container (network: none)  ->  solve / verify / replay
```

`sandbox.network_during_solve: true` re-enables network for the solve phase; the choice is
recorded on every sample produced under it.

### What this is not

The container provides **configured isolation, not a guarantee**. Container escapes, kernel
vulnerabilities, and resource-exhaustion attacks against the host remain possible. Run untrusted
repositories on a disposable machine. `forge doctor` prints these caveats verbatim and the run
manifest copies them into the export.

### The `local` backend

`sandbox.backend: local` runs commands as ordinary subprocesses on the host. It provides **no
isolation whatsoever**: no user separation, no resource limits, and `network_during_solve: false`
is not enforced. It exists so the pipeline can be exercised where no container runtime is
available. `forge doctor` reports it as a warning, and the backend name is recorded in the run
manifest of any export produced with it.

## 2. Information isolation

### What the solver receives

- a snapshot of the parent state
- the synthetic user request
- the six authorised tools
- minimal environment metadata (the workdir, the test command)

### What the solver does not receive

- the target diff, or any part of it
- the target commit message, subject, or SHA
- any branch, ref or git object that would reach the target
- the environment recipe or the preparation logs
- the hidden tests
- the grader's output or any evaluator note

### How the git route is closed

Checking out the parent inside a clone leaves every future object reachable: `git log --all`,
`git cat-file`, the reflog and the packfiles all still contain the answer. That is never done.

Instead, the parent state is exported with `git archive`, which emits **file contents and modes
and no git objects at all**, and a brand-new repository is initialised over it inside the
container:

```
git init
git add -A --force      # on the pristine archive, before any install step
git commit -m "initial state"
```

The resulting repository holds exactly one commit, no remotes, and no object that did not come
from the parent tree.

`--force` on that first `add` matters: a repository sometimes tracks a file its own `.gitignore`
would exclude. Force-adding on the pristine archive makes the workspace tree byte-identical to
the source tree, and makes those files tracked, so later modifications to them are still picked
up by a plain `git add -A`.

### The isolation audit

Before the solver is handed the container, `auditIsolation` checks, inside the container:

- `git rev-list --all --count` is exactly 1
- `git remote` is empty
- the only ref is `refs/heads/main`
- `git cat-file -e <target_sha>^{commit}` fails — the object is not there
- `grep -rI <target_sha> .` finds nothing in the working tree

Any finding aborts the candidate with cause `grade_gate_isolation`. `test/integration/isolation.test.ts`
asserts this against the fixture.

### Snapshot fidelity

The tree hash git computes for the placed snapshot is compared against the parent's tree hash from
the source repository. A mismatch means the workspace does not faithfully represent the parent
state, and the candidate is rejected with `env_snapshot_fidelity_mismatch` rather than measured
against a state it was never actually in.

### Install-time pollution

Installing dependencies can drop artefacts into the worktree (`*.egg-info`, `node_modules`,
caches). Untracked artefacts are added to `.git/info/exclude`, which lives inside `.git` — so it
is invisible to a solver listing the workspace and is not part of repository content. A tracked
file that an install step *rewrote* is reported instead of hidden: excluding it silently would let
a real solver edit disappear from the exactness check. If the tree cannot be restored to the
parent's hash, the candidate is rejected.

### Hidden tests

Hidden tests are the test files as they exist at the **target** commit. They never enter the solve
container. Verification runs in a separate container, over a *copy* of the solver's result, and
writes the hidden tests in after the copy is in place. A solver that deleted or weakened a visible
test therefore cannot avoid evaluation; the tampering is also detected and recorded on the sample
(`behavioral.visible_tests_tampered`).

### The agent harness

Pi is configured with every discovery mechanism disabled:

```ts
new DefaultResourceLoader({
  noExtensions: true,      // no ~/.pi/agent/extensions, no .pi/extensions
  noSkills: true,          // no .agents/skills, no .pi/skills
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,    // no AGENTS.md / CLAUDE.md from the repository under test
  systemPromptOverride: () => solverPrompt,
})
```

plus `noTools: "all"` with an explicit allowlist of the six forge tools, an in-memory session
manager and in-memory settings. A file inside the repository under test is **task data**; it
cannot change the supervisor's rules.

### Credentials

The model runtime lives in the forge process. The provider credential is never placed in the
container's environment and is never reachable from the shell the solver drives. The solver's
`run_command` executes inside a container that, by default, has no network at all.

### Evaluator artifacts

The evaluator manifest — target SHA, target patch, hidden test ids, grader output, environment
logs — is stored separately from the sample and exported to `evaluator-manifest.jsonl`. The
conversation builder that produces training messages reads only the sample and never the
manifest.

## Reporting a problem

If you find a route from the solve container back to the target commit, that is a bug in this
tool. The integration tests under `test/integration/` are the place to add a regression for it.
