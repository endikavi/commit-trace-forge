# Security policy

## Threat model in one paragraph

commit-trace-forge installs and runs code from the repositories you point it at, and lets a model
drive a shell against that code. Containers run as a non-root user with every capability dropped,
no host mounts, resource limits and no network during the solve phase — see
[docs/security.md](docs/security.md). That is **configured isolation, not a guarantee**: container
escapes and kernel bugs exist. Mine untrusted repositories on a disposable host or VM.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability. Use GitHub's private vulnerability
reporting on this repository ("Security" → "Report a vulnerability") with:

- what an attacker controls (repository contents, model output, configuration, ...)
- what they can reach that they should not (host files, credentials, network, other runs)
- a minimal reproduction, if you have one

You will get an acknowledgement within a week. Fixes are released with a note in
[CHANGELOG.md](CHANGELOG.md) once users have had a reasonable chance to update.

## In scope

- Escaping the sandbox configuration the tool applies, or a way for repository contents to change
  it (for example, by being auto-discovered as agent configuration)
- Leaks of reserved evaluation data (target patches, hidden tests, reward specs) into the solver's
  environment, the policy-side RL tasks or the training messages
- Credential exposure: provider keys reaching the sandbox, logs or exported data

## Out of scope

- Vulnerabilities in the repositories being mined
- Resource exhaustion on a host that runs untrusted repositories without the documented limits
