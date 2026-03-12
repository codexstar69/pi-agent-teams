# PR8 reconnaissance: structured logs, task priority scheduling, and UI visibility

This note scopes the next safe work for PR8 in the internal fork. It is reconnaissance only: no broad runtime edits, no naming churn, and no upstream-facing polish.

## Summary

PR8 should be split into three narrow tracks:

1. **Structured event logs**
2. **Task priority scheduling**
3. **UI visibility improvements**

These can share some metadata, but they should not land as one large change. The safest order is:

1. add event-log helper + append-only writes
2. add read-only priority parsing/sorting helper
3. expose priority/lease/retry state in task views and widget summaries
4. only then add user-facing mutation flows for priority

---

## 1. Structured logs: current landing zones

### Existing signals already available

The codebase already has several useful event sources:

- `extensions/teams/leader.ts`
  - teammate spawn success/failure
  - teammate stop/kill/shutdown flows
  - hook execution + hook remediation
- `extensions/teams/leader-inbox.ts`
  - idle notifications
  - shutdown approved/rejected
  - plan approval requests
  - peer DM notifications
- `extensions/teams/task-store.ts`
  - task create/update/claim/complete/unassign/retry/recover
- `extensions/teams/activity-tracker.ts`
  - per-worker tool usage, turns, token counts

### Existing log precedent

There is already a pattern for persisted logs:

- hook logs under `<teamDir>/hook-logs/*.json`
- some integration tests already use `<teamDir>/logs`

That means PR8 should **not invent a second root location**. The most natural new target is:

- `<teamDir>/logs/events.jsonl`

### Recommended first slice

Create a new helper:

- `extensions/teams/event-log.ts`

Suggested API:

```ts
appendTeamEvent(teamDir, event)
readRecentTeamEvents(teamDir, opts?)
```

Suggested event envelope:

```ts
{
  ts: string,
  kind: string,
  teamId?: string,
  taskListId?: string,
  member?: string,
  taskId?: string,
  data?: Record<string, unknown>
}
```

### Best first event kinds

Start with the highest-value, lowest-risk events:

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

### Risk notes

Do **not** try to log every message update or every tool delta first. That will create noisy logs and unnecessary disk churn. Keep PR8 logs at the level of operator-significant state transitions.

---

## 2. Task priority scheduling: current landing zones

### Where scheduling happens today

The current scheduler path is:

- `extensions/teams/task-store.ts`
  - `claimNextAvailableTask()`
  - `isTaskClaimableNow()`
  - `isTaskBlocked()`

Right now task selection is effectively:

- first pending
- unowned
- unblocked
- not cooling down / not exhausted
- in list order

That means priority can be added **without changing task-store public semantics** by adjusting the iteration order inside `claimNextAvailableTask()`.

### Lowest-risk representation

Do **not** add a top-level `priority` field to `TeamTask` first.

Lowest-risk first slice:

- store priority in `task.metadata.priority`
- parse through a helper in `task-store.ts`

Suggested helper shape:

```ts
type TaskPriority = "low" | "normal" | "high" | "urgent";
getTaskPriority(task): TaskPriority;
compareTaskPriority(a, b): number;
```

Default should be:

- `normal`

### Recommended scheduling order

Inside `claimNextAvailableTask()` sort by:

1. claimable status (already filtered)
2. priority (`urgent > high > normal > low`)
3. created/ID order for stable tie-break

That gives deterministic behavior while keeping the current task model intact.

### Where mutation flows should eventually land

Once read-only scheduling logic is proven, priority mutation should be added in:

- `extensions/teams/leader-task-commands.ts`
  - likely `/team task priority <id> <level>`
- `extensions/teams/leader-teams-tool.ts`
  - likely `task_set_priority`

But this should be a follow-up PR after read-only scheduling lands.

### Risk notes

Avoid mixing priority with dependency logic or lease recovery in the same change. Priority should only affect **ordering among already-claimable tasks**.

---

## 3. UI visibility: current landing zones

### Existing UI already shows

From `teams-widget.ts` and `teams-panel.ts`, the UI already surfaces:

- worker online/offline/streaming state
- pending/completed counts per worker
- token totals
- active tool activity
- quality gate failures
- stale worker heartbeats
- selected worker transcript summaries

### Highest-value missing visibility

The next visibility wins are task-state-oriented, not worker-state-oriented:

1. **priority badges**
2. **retry cooldown / exhausted state**
3. **lease presence / stale lease recovery reason**
4. **recent event log snippets**

### Best landing zones

#### Widget (`extensions/teams/teams-widget.ts`)

Add only aggregate signals here, for example:

- count of urgent tasks
- count of retry-exhausted tasks
- count of leased in-progress tasks
- count of recovered tasks with recent `leaseRecoveryReason`

The widget should stay compact.

#### Panel (`extensions/teams/teams-panel.ts`)

This is the best place for richer visibility:

- show selected worker’s active task priority
- show task lease status in task view
- show cooldownUntil / retryCount / retryExhausted in task detail view
- add a lightweight “recent events” section fed by `events.jsonl`

#### Shared formatting helpers (`extensions/teams/teams-ui-shared.ts`)

Add helpers for:

- `formatTaskPriority(task)`
- `formatRetryState(task)`
- `formatLeaseState(task)`

This avoids duplicating string logic in widget/panel/task commands.

#### Task detail command (`extensions/teams/leader-task-commands.ts`)

`/team task show <id>` is the best read-only diagnostic surface for new metadata. It should eventually include:

- priority
- retry state
- cooldownUntil
- task lease owner/token/expiry (or a redacted summary)
- lease recovery reason if present

### Risk notes

Keep the persistent widget compact and stable. Put most new detail in panel/task-show rather than widening the footer widget too aggressively.

---

## Recommended PR8 slicing

### PR8A — structured logs only

Files:

- new `extensions/teams/event-log.ts`
- `leader.ts`
- `leader-inbox.ts`
- maybe narrow hooks in `task-store.ts`

Goal:

- append-only JSONL logs for important state transitions
- no scheduling changes
- no UI change yet

### PR8B — read-only priority scheduling

Files:

- `task-store.ts`
- smoke coverage

Goal:

- parse `metadata.priority`
- stable comparator in `claimNextAvailableTask()`
- no commands/tool mutations yet

### PR8C — visibility only

Files:

- `teams-widget.ts`
- `teams-panel.ts`
- `teams-ui-shared.ts`
- `leader-task-commands.ts`

Goal:

- surface priority/retry/lease/event visibility
- still no broad runtime policy changes

### PR8D — priority mutation API

Files:

- `leader-task-commands.ts`
- `leader-teams-tool.ts`
- docs/help text

Goal:

- set/update task priority explicitly

---

## Suggested smoke/integration coverage later

### Structured logs

Smoke-level:

- append two events
- read back JSONL lines
- ensure valid JSON and stable fields

Integration-level:

- spawn worker
- create/claim/complete task
- confirm expected event kinds appear in order

### Priority scheduling

Smoke-level:

- create `low`, `normal`, `urgent` unblocked tasks
- confirm `claimNextAvailableTask()` picks urgent first
- confirm tie-break remains stable by ID/order

Integration-level:

- seed a small task list with mixed priorities
- confirm workers claim highest-priority claimable tasks first

### UI visibility

Prefer snapshot-style helper tests rather than broad TUI e2e first.

Good first target:

- helper functions in `teams-ui-shared.ts`
- `/team task show <id>` output contains priority/retry/lease lines when metadata exists

---

## Bottom line

The safest PR8 path is:

- **events first** for observability,
- **priority sorting second** inside `task-store.ts`,
- **UI visibility third** in panel/task-show,
- **priority mutation last**.

That sequence keeps runtime risk low while making operator understanding much better before more autonomous behavior is layered on top.
