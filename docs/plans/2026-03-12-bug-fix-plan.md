# Bug Fix Plan — pi-agent-teams audit remediation

## Fixes (ordered by severity, then dependency)

### Fix 1: BUG-1 (Medium) — Blocked task claim bypass
**Files:** `extensions/teams/task-store.ts`, `extensions/teams/leader-teams-tool.ts`
**Change:**
- Add `isTaskBlocked` check inside `claimTask()` so ALL claim paths enforce dependency ordering
- Add blocked check in `task_assign` action before setting owner
**Test:** Smoke test: create task A blocked by task B, attempt direct claimTask — must fail

### Fix 2: BUG-4 (Medium) — Silent poll error swallowing
**Files:** `extensions/teams/worker.ts`
**Change:**
- Add consecutive error counter to poll loop
- After 5 consecutive failures, publish a heartbeat with error metadata and back off exponentially
- Reset counter on any successful poll iteration
**Test:** Smoke test: verify error counter increments and backoff engages

### Fix 3: BUG-5 (Low) — Empty lock file bypasses dead-owner detection
**Files:** `extensions/teams/fs-lock.ts`
**Change:**
- Wrap `writeFileSync` in try/catch after `openSync`
- On failure: close fd, unlink the empty lock file, re-throw
**Test:** Smoke test: simulate empty lock file, verify dead-owner reclaim still works

### Fix 4: BUG-2 (Low) — Unlocked event log appends
**Files:** `extensions/teams/event-log.ts`
**Change:**
- Use `withLock` around `appendFile` in `appendTeamEvent`
- Lock file: `${eventsLogPath}.lock`
**Test:** Existing smoke tests cover event log reads; verify no regression

### Fix 5: BUG-3 (Low) — TOCTOU in unassignTasksForAgent
**Files:** `extensions/teams/task-store.ts`
**Change:**
- After the unassign loop, do a second `listTasks` pass to catch any tasks assigned during the first pass
- Only re-check tasks owned by the target agent that weren't in the original list
**Test:** Smoke test: verify second-pass catch works

## Verification gate
- `bun run typecheck` ✅
- `bun run lint` ✅
- `bun run smoke-test` ✅ (must stay at 280+ passed, 0 failed)
- All existing integration tests green
