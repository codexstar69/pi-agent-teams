# World-Class Stability Roadmap for `@tmustier/pi-agent-teams`

## Purpose

This document turns the high-level hardening ideas into a staged implementation plan for `pi-agent-teams`. The goal is to make the extension materially more stable under real multi-agent load while preserving the current user-facing workflow and avoiding large, risky rewrites.

The strategy is deliberate:

1. fix correctness bugs first,
2. reduce contention and I/O next,
3. add self-healing runtime behavior,
4. tighten cleanup and operational safety,
5. then layer on world-class ergonomics and observability.

## Success criteria

The project is successful when the extension can reliably:

- coordinate 6-8 teammates for extended sessions without lock thrash,
- prevent dependency deadlocks,
- avoid unbounded mailbox/task-store growth,
- recover abandoned or stale tasks automatically,
- detect and surface stuck workers,
- clean up worktrees and team artifacts without leaving Git metadata behind,
- provide enough logs and diagnostics to debug failures without manual forensics.

## Guiding principles

- Treat this as an internal fork, not an upstream contribution.
- Prefer incremental upgrades over storage rewrites.
- Ship risky changes behind flags first.
- Keep agent-led operation as the default; humans should observe or override, not babysit.
- Preserve current task/mailbox formats where possible so upgrades are low risk.
- Add tests for every failure mode before enabling behavior by default.
- Delay broad surface-area renaming until the runtime is stable enough to rename safely in one coordinated pass.

## Workstreams

### Workstream A — Correctness hardening

Files:
- `extensions/teams/fs-lock.ts`
- `extensions/teams/task-store.ts`
- `extensions/teams/leader-task-commands.ts`
- `extensions/teams/leader-teams-tool.ts`
- `extensions/teams/team-config.ts`

Deliverables:
- PID-aware stale lock recovery using recorded PID metadata.
- Better lock timeout diagnostics.
- Dependency cycle detection in `addTaskDependency()`.
- Retry metadata on failed tasks, retry exhaustion, and cooldown-based rescheduling.
- Max-worker limits enforced at spawn/delegate time.

Acceptance checks:
- Dead processes no longer block active workers for the full stale timeout.
- A dependency cycle cannot be created.
- Failed tasks do not hot-loop forever.
- The leader cannot over-spawn teammates accidentally.

### Workstream B — Storage and polling efficiency

Files:
- `extensions/teams/worker.ts`
- `extensions/teams/leader.ts`
- `extensions/teams/mailbox.ts`
- `extensions/teams/task-store.ts`
- `extensions/teams/teams-widget.ts`
- `extensions/teams/teams-panel.ts`

Deliverables:
- Adaptive polling with idle backoff for leader and workers.
- Mailbox compaction/pruning with optional archive retention.
- Task-store caching or parsed-task memoization with safe invalidation.
- Debounced widget/panel refreshes.

Acceptance checks:
- Idle teams generate much less disk activity.
- Mailbox files stay bounded.
- Task refresh remains fast even with larger task lists.
- UI stays responsive without excessive rerender churn.

### Workstream C — Health, leases, and recovery

Files:
- `extensions/teams/worker.ts`
- `extensions/teams/leader.ts`
- `extensions/teams/task-store.ts`
- `extensions/teams/team-config.ts`
- `extensions/teams/teammate-rpc.ts`

Deliverables:
- Worker heartbeat reporting.
- Leader-side stale-worker detection.
- Task lease metadata and recovery for abandoned in-progress tasks.
- Explicit RPC-ready handshake instead of fixed startup sleep.
- Optional worker restart supervision with retry caps.

Acceptance checks:
- Hung workers become visible quickly.
- Abandoned tasks recover automatically.
- Child startup is robust on both fast and slow machines.

### Workstream D — Cleanup and operational safety

Files:
- `extensions/teams/worktree.ts`
- `extensions/teams/cleanup.ts`
- `extensions/teams/leader-lifecycle-commands.ts`
- `extensions/teams/leader-team-command.ts`

Deliverables:
- Proper `git worktree remove` cleanup before filesystem deletion.
- Better branch naming and collision handling.
- Doctor/repair style diagnostics for stale locks, worktrees, sessions, tasks, and mailboxes.

Acceptance checks:
- Cleanup does not orphan `.git/worktrees` metadata.
- Operators can diagnose stale team state quickly.

### Workstream E — World-class runtime polish

Files:
- `extensions/teams/task-store.ts`
- `extensions/teams/activity-tracker.ts`
- `extensions/teams/leader.ts`
- `extensions/teams/teams-widget.ts`
- `extensions/teams/teams-panel.ts`
- new logging helpers

Deliverables:
- Task priority scheduling.
- Structured JSONL event logs.
- Stuck-task alerts and retry visibility.
- Better teammate cost/activity visibility.

Acceptance checks:
- Operators can understand what the team is doing and why.
- Higher-priority tasks are scheduled predictably.

## Internal fork and rename strategy

This project will remain an internal fork. We do not need to preserve upstream package identity or optimize for an external PR workflow.

Practical implications:

- We can rename the package, commands, team terminology, docs, and environment variables on our timeline.
- We should still avoid renaming too early; stability work should land first so failures remain easy to compare against the original implementation.
- The recommended rename order is:
  1. package metadata and docs,
  2. session/widget labels and style defaults,
  3. command aliases and user-facing terminology,
  4. environment variables and on-disk paths, with compatibility shims during migration,
  5. final cleanup removing legacy names only after soak testing.
- If internal branding needs a different root directory than `~/.pi/agent/teams`, add migration helpers and a one-time compatibility lookup before cutting over.

## Rollout plan

### Release 1 — Safe under concurrency
Default-off feature flags:
- `PI_TEAMS_PID_LOCKS`
- `PI_TEAMS_TASK_RETRY_POLICY`
- `PI_TEAMS_MAX_WORKERS`

Scope:
- PID-aware locks
- dependency cycle detection
- retry metadata/cooldowns
- worker-cap enforcement

### Release 2 — Efficient at scale
Default-off feature flags:
- `PI_TEAMS_ADAPTIVE_POLLING`
- `PI_TEAMS_MAILBOX_PRUNING`
- `PI_TEAMS_TASK_CACHE`
- `PI_TEAMS_DEBOUNCED_WIDGET`

Scope:
- adaptive polling
- mailbox pruning
- task caching
- debounced refresh/render

### Release 3 — Self-healing runtime
Default-off feature flags:
- `PI_TEAMS_HEARTBEATS`
- `PI_TEAMS_TASK_LEASES`
- `PI_TEAMS_RPC_READY_HANDSHAKE`
- `PI_TEAMS_RPC_SUPERVISOR`

Scope:
- heartbeats
- stale worker detection
- task leases and requeue
- ready handshake
- optional restart supervision

### Release 4 — Operational cleanup and default-on promotion
Scope:
- worktree cleanup
- diagnostics/doctor commands
- structured event logs
- priority scheduling
- gradual promotion of proven flags to default-on

## PR slicing

### PR 1
- PID-aware locks
- lock diagnostics
- cycle detection
- tests

### PR 2
- retry metadata
- retry cooldown / exhaustion behavior
- max-worker policy
- tests

### PR 3
- mailbox pruning
- adaptive worker polling
- adaptive leader polling
- widget debouncing
- tests/benchmarks

### PR 4
- task cache / memoization
- task refresh benchmarking
- integration tests

### PR 5
- heartbeats
- stale-worker detection
- task leases
- recovery behavior
- tests

### PR 6
- RPC ready handshake
- optional restart supervision
- crash/restart integration tests

### PR 7
- worktree cleanup
- doctor/repair commands
- cleanup tests

### PR 8
- structured logs
- task priorities
- UI visibility improvements

## Verification strategy

### Unit tests
Add or extend tests for:
- lock reclaim behavior,
- dependency-cycle rejection,
- retry policy and cooldown calculations,
- mailbox compaction,
- cache invalidation,
- lease expiry,
- worktree cleanup,
- priority ordering.

### Integration tests
Add scripted flows for:
- many workers claiming many tasks,
- worker crash mid-task,
- worker hang / stale heartbeat,
- hook-failure reopen flows,
- mailbox growth and compaction,
- startup handshake on slow child boot,
- cleanup of worktree-backed teammates.

### Soak tests
Run repeated longer scenarios:
- 4-8 workers,
- 50-100 tasks,
- mixed task durations,
- DM bursts,
- hook failures,
- periodic team attach/detach,
- dirty and clean Git repos.

## Immediate execution order

1. PR 1: locks + dependency cycles
2. PR 2: retries + max workers
3. PR 3: polling + mailbox pruning + debounced UI
4. PR 4: task cache
5. PR 5: heartbeats + leases
6. PR 6: RPC handshake/supervision
7. PR 7: worktree cleanup + doctor
8. PR 8: logs + priorities + UI visibility

## Notes

Do not start by rewriting the task or mailbox store into a database. The current file-based design can be made significantly more robust with lock correctness, bounded files, caching, and leases. That path is far safer, easier to review, and more aligned with the existing architecture.
