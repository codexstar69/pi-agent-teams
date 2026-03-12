# PR1 Baseline Verification Note

## Scope being verified

This note covers **PR1 from `docs/plans/2026-03-12-world-class-stability-roadmap.md`**:

- PID-aware locks
- better lock timeout diagnostics
- dependency cycle detection
- tests for the above

The goal is to document **what already exists**, **what partially covers PR1 today**, and **where new targeted coverage should land** so PR1 can ship with a clean verification story.

## Existing verification surface

### 1. `scripts/smoke-test.mts` — strongest current PR1 baseline

This is the main existing baseline for PR1.

Relevant coverage already present:
- `fs-lock.ts`
  - `withLock()` returns the callback result
  - lock file is cleaned up after success
  - stale lock file is removed by age
  - 20-way contention serializes correctly without throwing
- `task-store.ts`
  - dependency add/remove paths work
  - `isTaskBlocked()` works for a simple dependency
  - general task CRUD/claim/update flow remains healthy

Current gaps for PR1:
- no assertion that a lock owned by a **live PID** is preserved
- no assertion that a lock owned by a **dead PID** is reclaimed using PID-aware logic
- no assertion that lock timeout errors include useful owner/debug metadata
- no assertion that dependency cycles are rejected
- no assertion for indirect cycles like `A -> B -> C -> A`

**Conclusion:** `scripts/smoke-test.mts` should remain the primary home for deterministic PR1 verification.

---

### 2. `scripts/integration-claim-test.mts` — indirect concurrency signal

This script spawns real workers and validates task auto-claim/completion. It indirectly exercises:
- task claiming under contention
- per-task locking during claim/update
- end-to-end worker/task-store interaction

Current gap for PR1:
- it does **not** explicitly validate PID-aware stale-lock recovery
- it does **not** assert dependency graph correctness or cycle rejection
- it does **not** inspect lock diagnostics

**Conclusion:** useful as a regression guard after PR1, but not sufficient as the primary PR1 proof.

---

### 3. `scripts/integration-todo-test.mts` — indirect dependency signal

This script creates a realistic dependency graph across 15 tasks and 3 workers.

Relevant coverage already present:
- `addTaskDependency()` in a realistic graph
- `isTaskBlocked()` in a multi-worker workflow
- dependency-driven ordering in a real end-to-end run

Current gap for PR1:
- it only validates a valid DAG path
- it does **not** attempt to create cycles
- it does **not** assert cycle rejection messages or preserved graph integrity after rejection

**Conclusion:** strong regression coverage for “valid dependencies still work,” but cycle-specific verification should stay elsewhere.

---

### 4. Other current scripts

These are not meaningful PR1 coverage today:
- `scripts/integration-spawn-overrides-test.mts`
- `scripts/integration-hooks-remediation-test.mts`
- `scripts/e2e-rpc-test.mjs`

They should remain unchanged for PR1 unless lock/cycle work causes broad regressions.

## Recommended test placement for PR1

### A. Extend `scripts/smoke-test.mts`

This is the right place for **most PR1 checks** because the behavior is deterministic and file-system local.

Add a new subsection for **PID-aware lock recovery**:
- lock file with current process PID -> verify it is **not** treated as stale just because metadata exists
- lock file with obviously dead PID -> verify it is reclaimed quickly
- timeout path -> verify thrown error includes lock file path and owner metadata (PID / label / timestamp when available)

Add a new subsection for **dependency cycle rejection**:
- self-cycle rejection: `A -> A`
- simple cycle rejection: `A -> B`, then reject `B -> A`
- indirect cycle rejection: `A -> B`, `B -> C`, then reject `C -> A`
- verify graph remains unchanged after rejected insert

Why here:
- no Pi child processes required
- fast enough for required CI
- easiest place to get exact failure messages and invariant checks

---

### B. Keep `scripts/integration-claim-test.mts` as a PR1 regression guard

No mandatory new PR1 assertions are required here unless lock changes unexpectedly affect claim behavior.

Optional low-cost enhancement:
- run with slightly higher worker count and confirm no task is duplicated / lost after lock changes

This should be treated as **secondary confidence**, not the main PR1 proof.

---

### C. Extend `scripts/integration-todo-test.mts` only if we want a realistic DAG regression check

Optional addition:
- assert the existing dependency chain still completes after cycle-detection logic lands

Do **not** add cycle-creation attempts here. This test is expensive and should stay focused on realistic successful execution.

---

### D. If one more script is needed, create a narrow PR1-specific test script

If `smoke-test.mts` starts getting too large, the best new file would be:

- `scripts/integration-pr1-correctness-test.mts`

Use it only for:
- lock owner metadata / timeout diagnostics that are awkward in the main smoke file
- cross-module invariants around task-store + fs-lock under synthetic contention

At the moment, this should be considered **optional**. The default recommendation is still to extend `smoke-test.mts` first.

## CI and release baseline

Current CI already requires:
- `npm run check`
- `npm run smoke-test`
- `npm pack --dry-run`

That means the most valuable PR1 test additions are the ones that live in:
- `scripts/smoke-test.mts`

because they become required automatically on every PR.

The current optional/manual integration surface is still useful, but PR1 should not depend on optional workflows to prove correctness.

## Recommended PR1 verification checklist

Before PR1 merges, we should be able to point to:

1. **`scripts/smoke-test.mts`**
   - live PID lock not stolen
   - dead PID lock reclaimed
   - timeout diagnostics improved
   - self/simple/indirect cycle rejection
   - graph remains valid after rejected cycle insertion

2. **Existing regression scripts remain green**
   - `npm run integration-claim-test`
   - optionally `npm run integration-todo-test` for realistic dependency ordering confidence

3. **CI behavior stays simple**
   - no new required long-running workflows for PR1
   - keep PR1 proof in fast deterministic tests

## Bottom line

For PR1, the repo already has a good baseline, but it is mostly **partial**:
- `smoke-test.mts` already covers lock basics and dependency basics
- `integration-claim-test.mts` and `integration-todo-test.mts` provide useful regression confidence
- the missing targeted proof is specifically:
  - PID-aware lock behavior
  - lock diagnostics
  - dependency cycle rejection

The best place to add that missing proof is **`scripts/smoke-test.mts` first**, with optional follow-up regression assertions in the existing integration scripts if PR1 changes reveal broader runtime sensitivity.
