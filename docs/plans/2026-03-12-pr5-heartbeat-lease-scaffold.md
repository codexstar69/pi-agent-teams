# PR5 heartbeat + task lease scaffold

This note defines the low-risk integration path for worker heartbeats and task leases.

## Goal

Add recovery primitives without changing task lifecycle semantics yet.

## What landed in scaffold

New helper module:
- `extensions/teams/heartbeat-lease.ts`

Pure helpers only:
- heartbeat config parsing
- worker heartbeat freshness assessment
- task lease creation / refresh
- task lease metadata encode/decode
- leader-side recovery decision helper

No runtime wiring was added yet. This keeps the first step easy to review and safe to ship.

## Intended integration points

### Worker

`extensions/teams/worker.ts`
- start periodic heartbeat loop after `session_start`
- update `TeamMember.lastSeenAt`
- write `meta.heartbeatAt`, `meta.heartbeatPhase`, `meta.currentTaskId`
- when task is claimed or started, create a lease and persist it on task metadata
- refresh lease alongside worker heartbeat while task is active

### Task store

`extensions/teams/task-store.ts`
- on claim/start: attach lease metadata
- on complete/unassign/retry failure: clear or replace lease metadata
- optionally add narrow helpers later:
  - `attachTaskLease(...)`
  - `refreshTaskLease(...)`
  - `clearTaskLease(...)`

### Leader

`extensions/teams/leader.ts`
- during periodic refresh, assess each worker's freshness from `lastSeenAt`
- for `in_progress` tasks with expired leases, use `shouldRecoverLeasedTask(...)`
- only auto-recover when:
  - lease expired
  - owner heartbeat is stale/unknown/invalid
- then requeue task and annotate metadata with recovery reason/time

## Recommended rollout order

1. add worker heartbeat writes only
2. add lease metadata on claim/start only
3. add lease refresh while task active
4. add leader read-only diagnostics for stale workers / expired leases
5. add automatic task recovery behind a flag

## Suggested flags

- `PI_TEAMS_HEARTBEAT_INTERVAL_MS`
- `PI_TEAMS_HEARTBEAT_STALE_MS`
- `PI_TEAMS_TASK_LEASE_DURATION_MS`
- later: `PI_TEAMS_TASK_LEASE_RECOVERY=1`

## Safety rules

- heartbeat freshness alone should not recover tasks without an expired lease
- expired lease should not recover if owner heartbeat is still fresh
- recovery should be leader-owned, never worker-owned
- lease metadata should be additive inside `task.metadata`

## Next implementation slice

The next safe code step is:
- add a worker heartbeat timer
- update `setMemberStatus(... lastSeenAt/meta ...)`
- do not change claim/recovery semantics yet

That gives observability first, then recovery later.
