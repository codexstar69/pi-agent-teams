# Stability Hardening Handoff

Branch: `codex/world-class-stability-hardening`
Date: 2026-03-12

## What changed

8 focused PRs landed on a single branch, all verified green:

| PR | Scope | Key files |
|----|-------|-----------|
| 1 | PID-aware locks + dependency cycle detection | `fs-lock.ts`, `task-store.ts` |
| 2 | Retry metadata/cooldowns + max-worker policy | `task-store.ts`, `worker.ts`, `max-workers-policy.ts` |
| 3 | Adaptive polling + mailbox pruning + debounced refresh | `adaptive-polling.ts`, `debounce.ts`, `mailbox.ts`, `leader.ts`, `worker.ts` |
| 4 | Task caching / memoization | `task-store.ts` |
| 5 | Heartbeats + task leases + stale-worker recovery | `heartbeat-lease.ts`, `worker.ts`, `leader.ts`, `teams-panel.ts` |
| 6 | RPC ready handshake + startup timeout | `teammate-rpc.ts` |
| 7 | Worktree cleanup + `/team doctor` diagnostics | `worktree.ts`, `cleanup.ts`, `doctor.ts`, `leader-lifecycle-commands.ts` |
| 8 | Structured event logs + task priority + UI visibility | `event-log.ts`, `task-store.ts`, `teams-panel.ts` |

## New files

- `extensions/teams/adaptive-polling.ts`
- `extensions/teams/debounce.ts`
- `extensions/teams/doctor.ts`
- `extensions/teams/event-log.ts`
- `extensions/teams/heartbeat-lease.ts`
- `extensions/teams/max-workers-policy.ts`
- `extensions/teams/worktree.ts`
- 8 integration test scripts under `scripts/`

## Feature flags

All new runtime behavior is opt-in behind environment variables:

| Flag | Default | Purpose |
|------|---------|---------|
| `PI_TEAMS_ADAPTIVE_POLLING` | off | Backoff-based polling for workers and leader |
| `PI_TEAMS_HEARTBEATS` | off | Worker heartbeat publishing |
| `PI_TEAMS_HEARTBEAT_INTERVAL_MS` | 5000 | Heartbeat frequency |
| `PI_TEAMS_HEARTBEAT_STALE_MS` | 30000 | Stale-worker threshold |
| `PI_TEAMS_TASK_LEASES` | off | Lease metadata on task claims |
| `PI_TEAMS_TASK_LEASE_DURATION_MS` | 20000 | Lease expiry window |
| `PI_TEAMS_TASK_LEASE_RECOVERY` | off | Auto-recover expired leased tasks |
| `PI_TEAMS_RPC_START_TIMEOUT_MS` | 30000 | Startup handshake timeout |
| `PI_TEAMS_WORKTREE_CLEANUP` | off | Git worktree removal during cleanup |
| `PI_TEAMS_MAILBOX_PRUNING` | off | Mailbox compaction after reads |
| `PI_TEAMS_RETRY_BASE_DELAY_MS` | 5000 | Retry cooldown base |
| `PI_TEAMS_RETRY_MAX_ATTEMPTS` | 3 | Max retry attempts before exhaustion |
| `PI_TEAMS_MAX_WORKERS` | unset | Worker spawn cap |

## Verification evidence

All logs captured in `.tmp/verification-logs/`.

- Fast gate: typecheck ✅, lint ✅, smoke ✅ (280 assertions, 0 failures)
- Focused proofs: 8/8 integration scripts green (adaptive, mailbox, heartbeat, RPC, cleanup, worktree, doctor)
- Regression flows: claim ✅, spawn-overrides ✅, hooks-remediation ✅, todo ✅
- Flag matrix: baseline ✅, adaptive-on ✅, RPC-timeout ✅, combined-hardened ✅
- e2e-rpc: skipped (requires live Pi process, not a regression)

## What's next

- Internal fork rename (separate workflow, not stability-related)
- Gradual flag enablement in real sessions
- Soak observation under production-like load
