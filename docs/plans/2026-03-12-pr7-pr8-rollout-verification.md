# PR7 / PR8 rollout and verification note

## Scope

This note covers the next two runtime-hardening tracks for the internal fork:

- **PR7**: worktree cleanup safety checks and doctor / repair strategy
- **PR8**: structured logs, task priority scheduling, and UI visibility additions

This is intentionally operational, not upstream-facing. The goal is to stage the work so operators gain confidence and visibility **before** we enable more automation or destructive repair paths.

---

## Core principle

For PR7 and PR8, the safest order is:

1. **detect and report**
2. **log and explain**
3. **offer read-only diagnostics**
4. **only then add repair / mutation / automation**

Applied concretely:

- for PR7: diagnostics before destructive cleanup
- for PR8: observability before scheduling changes, scheduling before mutation APIs

---

# PR7 — worktree cleanup and doctor strategy

## Current repo baseline

### Cleanup safety already present

`extensions/teams/cleanup.ts` already gives us a good base:

- cleanup is constrained to paths inside the teams root
- path traversal / outside-root deletion is blocked
- the current cleanup path is filesystem-safe

`docs/plans/2026-03-12-pr7-worktree-cleanup-doctor-scaffold.md` already defines the existing scaffold:

- validated managed worktree paths
- a reusable cleanup plan concept
- no destructive git worktree removal yet

### What is still missing

For real operational safety, PR7 still needs:

- git-aware worktree removal (`git worktree remove <path>`) before deleting directories
- a read-only doctor surface that classifies stale or inconsistent state
- explicit repair boundaries so operators know what will be changed and what will not

---

## Recommended PR7 rollout sequence

### Stage 7A — read-only diagnostics only

Add pure helpers first. No cleanup behavior change yet.

Suggested helper scope:

- inspect managed worktree paths under `<teamDir>/worktrees`
- detect whether each path is:
  - present on disk
  - registered in git worktree metadata
  - safe to remove
  - already orphaned
- inspect stale lock files
- inspect stale workers / stale leases / in-progress tasks
- inspect missing session files or inconsistent config members

Recommended landing zones:

- `extensions/teams/worktree.ts`
- `extensions/teams/cleanup.ts`
- new `extensions/teams/doctor.ts`

Suggested output model:

```ts
{
  warnings: DoctorIssue[],
  repairable: DoctorIssue[],
  destructive: DoctorIssue[]
}
```

That classification matters because not all problems should be treated the same:

- warning-only: stale heartbeat, missing optional session file
- repairable: orphaned worktree path, stale task lease
- destructive: remove a registered worktree or force cleanup with in-progress tasks

### Stage 7B — surface doctor output without repair

Only after helper output is stable, expose it through a command path.

Recommended command shape:

- `/team doctor`

What it should do first:

- show issues grouped by severity
- show exactly which paths / team ids / worker names are involved
- suggest the next operator action

What it should **not** do yet:

- mutate anything automatically
- run `git worktree remove`
- delete locks or rewrite tasks

### Stage 7C — git-aware cleanup, still conservative

Once diagnostics are trusted, add best-effort cleanup helpers:

- attempt `git worktree remove <path>` for managed worktrees
- if removal succeeds, continue filesystem cleanup
- if removal fails, surface a clear warning and stop unless explicit force/repair policy allows continuing

Important rule:

- do not silently fall back from git-aware cleanup to raw deletion for a registered worktree without explicit policy

### Stage 7D — optional repair flow

Only after the doctor output is easy to trust should repair exist.

Recommended command shape:

- `/team cleanup --repair`

First repair actions should stay narrow:

- stale lock cleanup
- orphaned worktree path cleanup when safe
- stale member/session metadata cleanup

Later repair actions can include:

- requeue stale leased tasks
- prune stale workers

But those should remain separate from destructive repo cleanup.

---

## PR7 verification model

### Helper-level verification

Add deterministic tests for:

- worktree path is inside `<teamDir>/worktrees`
- cleanup plan refuses unsafe paths
- doctor classification distinguishes:
  - warning
  - repairable
  - destructive

### Integration verification

Recommended integration script:

- `scripts/integration-worktree-cleanup-test.mts`

Suggested assertions:

1. create temp git repo
2. create managed teammate worktree
3. verify doctor sees it as managed and clean
4. invoke cleanup helper / flow
5. verify git no longer lists the worktree
6. verify team directory deletion stays inside teams root
7. verify repeat cleanup is safe and idempotent

### Regression / soak checks

After PR7 lands, run broad regression with:

- normal shared-workspace flow
- normal worktree-backed flow
- cleanup after all workers stopped
- cleanup refusal while unsafe state exists

---

# PR8 — logs, priorities, and UI visibility

## Current repo baseline

The codebase already has good visibility building blocks:

- `leader.ts` emits hook logs and UI notifications
- `leader-inbox.ts` processes high-value lifecycle messages
- `task-store.ts` now carries retry / lease / recovery metadata
- `teams-widget.ts` already shows:
  - stale worker heartbeats
  - quality gate failures
  - worker activity / token totals
- `teams-panel.ts` already has richer per-worker/task visibility than the footer widget

That means PR8 should **not** start with broad runtime behavior changes. It should start by turning existing state into durable operator-visible signals.

---

## Recommended PR8 rollout sequence

### Stage 8A — structured logs first

Start with append-only structured logs before changing scheduling.

Recommended file:

- `extensions/teams/event-log.ts`

Recommended storage:

- `<teamDir>/logs/events.jsonl`

Recommended first event kinds only:

- `member_spawned`
- `member_spawn_failed`
- `member_stopped`
- `task_created`
- `task_claimed`
- `task_completed`
- `task_retryable_failure`
- `task_recovered`
- `hook_failed`
- `hook_followup_created`

These are high-value, low-volume, operator-relevant events.

What to avoid in first slice:

- logging every token delta
- logging every transcript line
- logging every tool execution update

That belongs in a later analytics layer, not the runtime-hardening layer.

### Stage 8B — read-only priority scheduling

After logs exist, add priority-aware scheduling in the smallest possible surface:

- store priority as `task.metadata.priority`
- default to `normal`
- sort only within already-claimable tasks inside `claimNextAvailableTask()`

Recommended order among claimable tasks:

1. `urgent`
2. `high`
3. `normal`
4. `low`
5. stable tie-break by task id / created order

Important boundary:

- priority should not bypass dependency blocking
- priority should not override retry cooldown/exhaustion rules
- priority should not be mixed with lease recovery changes in the same PR

### Stage 8C — UI visibility next

Only after logs and read-only priority scheduling are stable should visibility expand.

Recommended UI rollout:

#### Widget

Keep compact, add only aggregates:

- urgent task count
- retry-exhausted task count
- leased in-progress task count
- recovered-task count / recent recovery warning

#### Panel

Use panel for richer state:

- selected task priority
- retry count / cooldownUntil / exhausted state
- lease owner / lease expiry summary
- recent event log snippets

#### `/team task show`

This is the safest read-only operator diagnostic surface for metadata. Add:

- priority
- retry state
- cooldownUntil
- lease summary
- lease recovery reason

### Stage 8D — priority mutation last

Only after read-only priority scheduling is proven should mutation APIs land.

Recommended command/tool additions later:

- `/team task priority <id> <level>`
- `teams` tool action like `task_set_priority`

This should be the last PR8 slice, not the first.

---

## How to keep PR8 from destabilizing runtime behavior

### 1. Keep logs append-only and non-blocking

If event logging fails:

- do not fail task operations
- do not block scheduling
- surface warning only if needed

### 2. Keep priority logic local to claim ordering

Do not spread priority conditionals across:

- worker polling
n- inbox handling
- UI state derivation
- cleanup / recovery logic

Keep it centered in task-store helper logic.

### 3. Keep widget changes summary-only

The persistent widget should remain small and readable. Put richer state into:

- the panel
- `/team task show`
- recent event views later

### 4. Do not combine logs + priority + doctor + repair in one PR

The debugging cost would spike if those land together.

---

## Recommended flags / gating

PR7 and PR8 do not need every slice flagged, but the risky parts should be gated.

### PR7

Recommended flags:

- `PI_TEAMS_WORKTREE_CLEANUP=1`
  - enables git-aware cleanup
- `PI_TEAMS_DOCTOR=1`
  - enables doctor/diagnostic command path if needed internally

### PR8

Recommended flags:

- `PI_TEAMS_EVENT_LOGS=1`
  - enables append-only JSONL logging
- `PI_TEAMS_TASK_PRIORITY=1`
  - enables priority-aware claim ordering

UI visibility alone usually does not need a flag unless it materially changes layout density.

---

## Suggested verification plan

## PR7 verification

### Smoke-level

- cleanup path safety helpers
- doctor classification helpers
- managed worktree path validation

### Integration-level

- real git repo + worktree create/remove flow
- cleanup refusal while unsafe state exists
- repeat cleanup idempotence

### Operational checks

- stale lock reported with path + owner info
- stale worker / stale lease visible in doctor output
- operator can understand what would be repaired before enabling repair

## PR8 verification

### Structured logs

Smoke-level:

- append events
- read back JSONL lines
- validate stable envelope fields

Integration-level:

- spawn / claim / complete flow writes expected events in expected order

### Priority scheduling

Smoke-level:

- seed low/normal/high/urgent tasks
- confirm claim order respects priority among claimable tasks
- confirm stable tie-break remains deterministic

Integration-level:

- mixed-priority, dependency-aware task set
- workers still obey block/cooldown semantics while urgent tasks win among available work

### UI visibility

Prefer helper and output assertions over full TUI automation first:

- formatting helpers in `teams-ui-shared.ts`
- `/team task show <id>` output contains priority/retry/lease info
- widget aggregate line only when relevant metadata exists

---

## Recommended execution order

### Immediate next order

1. **PR7A** doctor helper + cleanup diagnostics
2. **PR7B** git-aware worktree cleanup integration
3. **PR8A** structured event logs
4. **PR8B** read-only priority scheduling
5. **PR8C** panel/task-show visibility
6. **PR8D** priority mutation API
7. **PR7C** optional repair flows, once doctor output is trusted in practice

That order keeps the system observable first and only gradually makes it more autonomous.

---

## Bottom line

The right PR7/PR8 strategy is:

- **PR7:** diagnose first, clean up second, repair last
- **PR8:** log first, schedule second, visualize third, mutate last

If we follow that order, operators gain more confidence at each step instead of losing debuggability while the runtime is still changing.
