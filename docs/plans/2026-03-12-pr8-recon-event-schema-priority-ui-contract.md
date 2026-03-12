# PR8 follow-up reconnaissance: event schema, priority metadata contract, and UI surfacing matrix

This note continues PR8 reconnaissance with a narrower goal than the earlier roadmap note: define the **smallest concrete contracts** needed before implementation begins.

This is still reconnaissance only. No broad runtime changes are proposed here.

---

## Goal

Prepare three implementation-ready contracts for PR8:

1. a structured event-log envelope and initial event taxonomy,
2. a low-risk task priority metadata contract,
3. a UI surfacing matrix that keeps the widget compact and pushes detail to task-show / panel.

These contracts are designed to fit the current code layout with minimal churn.

---

# 1. Structured event logs contract

## Recommended file and storage location

New helper:

- `extensions/teams/event-log.ts`

Storage target:

- `<teamDir>/logs/events.jsonl`

This matches the existing repo precedent:

- hook logs already live under `<teamDir>/hook-logs`
- some integration flows already inspect `<teamDir>/logs`

Do not create a second unrelated root or global log path.

---

## Event envelope

Recommended base event shape:

```ts
type TeamEvent = {
  ts: string;
  kind: TeamEventKind;
  teamId?: string;
  taskListId?: string;
  member?: string;
  taskId?: string;
  data?: Record<string, unknown>;
};
```

Recommended helper surface:

```ts
appendTeamEvent(teamDir: string, event: TeamEvent): Promise<void>
readRecentTeamEvents(teamDir: string, opts?: { limit?: number }): Promise<TeamEvent[]>
```

Behavior recommendations:

- append-only writes
- JSONL one event per line
- helper failures should not fail task operations
- callers may ignore append failures or optionally surface a warning

---

## First event taxonomy

Start with operator-relevant state changes only.

Recommended initial kinds:

### Member lifecycle

- `member_spawn_requested`
- `member_spawned`
- `member_spawn_failed`
- `member_shutdown_requested`
- `member_shutdown_approved`
- `member_shutdown_rejected`
- `member_killed`
- `member_stopped`

### Task lifecycle

- `task_created`
- `task_assigned`
- `task_unassigned`
- `task_claimed`
- `task_started`
- `task_completed`
- `task_retryable_failure`
- `task_recovered`
- `task_dependency_added`
- `task_dependency_removed`

### Governance / planning

- `plan_approval_requested`
- `plan_approved`
- `plan_rejected`

### Hooks / remediation

- `hook_failed`
- `hook_passed`
- `hook_followup_created`
- `hook_task_reopened`

### Messaging (optional later)

- `message_dm_sent`
- `message_broadcast_sent`

Do not start with transcript-level or tool-delta logging.

---

## Best first call sites

### `leader.ts`

Best for:

- spawn success/failure
- stop/kill
- hook remediation results

### `leader-inbox.ts`

Best for:

- plan approval requests
- shutdown approval/rejection
- idle completion/failure notifications

### `task-store.ts`

Best for:

- task-created / claimed / completed / retry / recovered

Recommendation:

- first implementation may log from leader-facing orchestration layers only, then expand into task-store if needed
- this avoids touching too many hot paths at once

---

# 2. Task priority metadata contract

## Representation

Use metadata first, not a top-level field.

Recommended storage:

```ts
task.metadata.priority
```

Allowed values:

```ts
type TaskPriority = "low" | "normal" | "high" | "urgent";
```

Default:

- `normal`

Why metadata first:

- keeps the public `TeamTask` shape stable
- requires fewer changes to task parsing / compatibility logic
- lets older tasks continue to work unchanged

---

## Helper surface

Recommended helpers in `task-store.ts` or a tiny `task-priority.ts` helper:

```ts
getTaskPriority(task: TeamTask): TaskPriority
compareTaskPriority(a: TeamTask, b: TeamTask): number
formatTaskPriority(priority: TaskPriority): string
```

Suggested ranking:

- `urgent = 3`
- `high = 2`
- `normal = 1`
- `low = 0`

Comparator recommendation:

1. higher priority first
2. lower task id / older task first as tie-break

This keeps order deterministic.

---

## Scheduling change boundary

The only runtime behavior change for the first priority slice should be inside:

- `claimNextAvailableTask()` in `task-store.ts`

Current flow already filters:

- pending
- unowned
- unblocked
- not cooling down / not exhausted

Priority should affect **only the order of already-claimable tasks**.

It should not:

- bypass blocked tasks
- bypass retry cooldown
- override explicit owner logic
- interact with lease recovery in the same PR

---

## Mutation surfaces for later PR

Do not implement first, but prepare for them.

### Command layer

In `leader-task-commands.ts`, likely future command:

- `/team task priority <id> <low|normal|high|urgent>`

### Tool layer

In `leader-teams-tool.ts`, likely future action:

- `task_set_priority`

Payload sketch:

```json
{ "action": "task_set_priority", "taskId": "12", "priority": "urgent" }
```

### Read-only first surfaces

Before mutation lands, `leader-task-commands.ts` and `teams-panel.ts` should be able to display priority if metadata already exists.

---

# 3. UI surfacing matrix

The current UI already has a good split between compact and rich surfaces:

- `teams-widget.ts` = compact persistent status
- `teams-panel.ts` = detailed interactive view
- `leader-task-commands.ts` = read-only task diagnostics via `/team task show`

PR8 should preserve that split.

---

## Widget: add only aggregates

### Good candidates

- urgent task count
- retry-exhausted task count
- recovered-task count
- active leased-task count

### Avoid in widget

- per-task priority labels for many rows
- long event log lines
- full retry/cooldown text
- lease token/expiry detail

Reason:

The widget is already near its density ceiling.

---

## Panel: best place for detailed visibility

The panel currently already has:

- overview rows per worker
- selected worker summary
- session transcript view
- task list / reassignment flows

Best additions for PR8 panel work:

### Overview mode

For selected worker summary:

- show active task priority
- show retry state if active task is in a degraded state
- optionally show recent event summary if event log helper exists

### Task list / task view

For selected task:

- priority
- retry count
- retry exhausted flag
- cooldownUntil if present
- lease summary (owner / expiresAt or short badge)
- leaseRecoveryReason if present
- quality gate summary already exists and should remain

### Session mode

Optional later:

- a compact “recent events” block separate from transcript

Do not mix JSONL raw lines into the transcript feed.

---

## `/team task show` expansion matrix

This is the safest first read-only diagnostic surface.

Current output already includes:

- status
- blocked state
- owner
- deps / blocks
- description
- result
- quality gate summary

Recommended future additions, in order:

1. `priority: <level>`
2. `retry: <count>/<limit>` or `retry: exhausted`
3. `cooldownUntil: <iso>` when present
4. `lease: owner=<name> expiresAt=<iso>`
5. `leaseRecoveryReason: <reason>`

This requires no TUI-specific changes and is easy to test.

---

# 4. Helper-level preparation opportunities

If we want code prep without broad runtime edits, these are the best narrow helpers to add first.

## A. `event-log.ts`

Pure append/read helpers only.

No call sites required in the same PR if we want a tiny scaffolding slice.

## B. priority helpers

In `task-store.ts` or a new helper module:

- `getTaskPriority()`
- `compareTaskPriority()`

No scheduling behavior change required in the same PR if we want only prep.

## C. UI formatting helpers

In `teams-ui-shared.ts`:

- `formatTaskPriority(task)`
- `formatRetrySummary(task)`
- `formatLeaseSummary(task)`

These can be added before any widget/panel changes and unit-smoke tested via simple string expectations.

---

# 5. Suggested implementation-ready slices

## Slice A — helper prep only

Safe files:

- new `event-log.ts`
- `teams-ui-shared.ts`
- maybe `task-store.ts` helper additions only

No runtime change required.

## Slice B — read-only diagnostics

Safe files:

- `leader-task-commands.ts`
- `teams-panel.ts`

Show metadata if present, but do not change scheduling or task mutation yet.

## Slice C — scheduling only

Files:

- `task-store.ts`
- smoke coverage

Only change `claimNextAvailableTask()` ordering.

## Slice D — mutation APIs

Files:

- `leader-task-commands.ts`
- `leader-teams-tool.ts`
- docs/help text

Last, not first.

---

# 6. Test prep recommendations

## Structured logs

Smoke-level helper assertions are enough for the first slice:

- append one event
- append second event
- read back both
- validate JSONL envelope fields

## Priority helpers

Smoke-level:

- metadata absent => `normal`
- `urgent` outranks `high`
- tie-break by task id stable

## UI helper formatting

Smoke-level:

- task with no metadata formats cleanly
- retry-exhausted task returns stable summary string
- leased task returns compact summary string

These can all land before broad runtime changes.

---

## Bottom line

The best continued PR8 path is:

1. define event and priority contracts,
2. add helper-only prep if useful,
3. expose read-only diagnostics,
4. only then change scheduling,
5. only then add mutation APIs.

That keeps the runtime stable while making implementation of the next slice much more mechanical.
