# Security Policy

## Supported versions

Security fixes are prioritized for the latest published release and the default branch.

| Version | Supported |
| --- | --- |
| latest npm release | ✅ |
| current default branch | ✅ |
| older releases | ⚠️ best effort |
| untagged forks | ❌ |

## Reporting a vulnerability

Please do **not** open a public GitHub issue for suspected security vulnerabilities.

Instead, report privately via one of these paths:

1. GitHub Security Advisories / private vulnerability reporting for this repository, if enabled.
2. Email the maintainer listed in `MAINTAINERS.md` with:
   - affected version
   - impact summary
   - reproduction steps
   - logs / screenshots / proof-of-concept if available

## What to include

Please include:

- package version (`npm view @codexstar/pi-agent-teams version` or local `package.json`)
- Pi version / environment
- operating system
- whether the issue affects leader mode, worker mode, hooks, worktrees, or CI
- minimal reproduction steps
- expected behavior vs actual behavior

## Response expectations

Targets are best effort:

- initial acknowledgement: within 3 business days
- triage decision: within 7 business days
- fix timeline: depends on severity and reproducibility

## Scope guidance

Relevant security areas for this project include:

- task and mailbox state handling
- hook execution and environment propagation
- process lifecycle and shutdown behavior
- worktree setup / cleanup safety
- path traversal or unsafe filesystem mutation
- privilege boundary assumptions in leader/worker coordination

Out of scope unless they produce a concrete exploit path:

- generic rate-limiting suggestions
- missing audit logs by themselves
- theoretical DoS without demonstrated amplification or meaningful business impact
