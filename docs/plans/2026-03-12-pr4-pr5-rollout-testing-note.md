# PR4 / PR5 Rollout and Testing Note

## Scope being planned

This note covers the next two runtime-hardening slices from `docs/plans/2026-03-12-world-class-stability-roadmap.md`:

- **PR4**: task-store cache / memoization, task refresh benchmarking, cache-safe integration coverage
- **PR5**: worker heartbeats, stale-worker detection, task lease metadata, recovery / requeue behavior

This is written for the **internal fork**. The priority is operational confidence, not upstream-facing polish. Keep current command names, labels, and on-disk paths stable while these runtime changes are still settling.

## Why PR4 and PR5 should be planned together

These two slices interact directly:
- PR4 changes **how quickly and how often state is observed**
- PR5 changes **what state means when a worker becomes stale**

That means a bad cache/invalidation strategy can hide the very stale-worker and lease-expiry events that PR5 depends on.

Recommended principle:
- **PR4 must preserve correctness before it improves performance**
- **PR5 should assume cached reads exist and prove recovery still works under cached refresh paths**

## Recommended feature flags

### PR4 flags

#### 1. `PI_TEAMS_TASK_CACHE`

Recommended meaning:
- `0` / unset: current behavior (re-read from disk through existing task-store paths)
- `1`: enable parsed-task memoization / task-list caching with explicit invalidation

What should be gated behind it:
- any in-memory task object cache
- any cached `listTasks()` or per-task file lookup behavior
- any watch-based or write-through invalidation helper

Recommended initial scope:
- keep cache limited to task-store reads
- do not fold mailbox caching into the same PR

#### 2. `PI_TEAMS_TASK_CACHE_TRACE` *(optional debug flag)*

Recommended meaning:
- off by default
- when enabled, surface cache hit/miss/invalidation counters in logs or debug output

Why it is useful:
- cache bugs are hard to reason about without visibility
- this gives us debugging leverage without permanently changing user-facing behavior

This flag is optional, but strongly recommended for internal rollout.

---

### PR5 flags

#### 3. `PI_TEAMS_HEARTBEATS`

Recommended meaning:
- `0` / unset: current behavior
- `1`: workers periodically publish heartbeat / liveness state, and the leader consumes it

What should be gated behind it:
- worker heartbeat writes
- leader stale-worker detection logic
- UI/config updates that expose stale/offline classification based on heartbeat freshness

#### 4. `PI_TEAMS_TASK_LEASES`

Recommended meaning:
- `0` / unset: current owner/status semantics only
- `1`: claimed tasks get renewable lease metadata, and expired leases can be recovered/requeued

What should be gated behind it:
- lease fields in task metadata
- lease extension on progress/heartbeat
- stale in-progress task recovery logic
- recovery notifications / metadata explaining why a task was requeued

Important recommendation:
- do **not** enable `PI_TEAMS_TASK_LEASES` by default before `PI_TEAMS_HEARTBEATS` has proven stable
- lease recovery without trustworthy heartbeat freshness is harder to reason about

## Existing verification surface

### 1. `scripts/smoke-test.mts` — primary deterministic home for cache and lease invariants

Current strengths:
- already covers task-store behavior directly
- already runs as required CI via `npm run smoke-test`
- best place for file-local invariants without real Pi child processes

Best PR4 uses:
- verify cache invalidates after task create/update/complete/unassign
- verify cached reads do not return stale task state after write-through updates
- verify repeated reads preserve current semantics under `PI_TEAMS_TASK_CACHE=1`

Best PR5 uses:
- verify lease metadata shape and expiry calculations deterministically
- verify stale/recovered task state transitions at the task-store layer
- verify recovery metadata is written clearly when a lease expires

What it should **not** try to do:
- prove real worker heartbeat loops or leader-side stale detection timing

**Conclusion:** `scripts/smoke-test.mts` should carry the deterministic correctness proof for both PR4 and PR5.

---

### 2. `scripts/integration-claim-test.mts` — best existing baseline for cache safety under real workers

Current strengths:
- real workers auto-claim and complete tasks
- already exercises the most important real task loop

Best PR4 use:
- confirm cached task reads do not break auto-claim / completion flow
- optionally run with more tasks/workers after cache is enabled

Best PR5 use:
- limited; it can help confirm normal workers still complete tasks when heartbeat/lease flags are on but healthy

What it does **not** prove well:
- stale-worker recovery
- explicit heartbeat timeout behavior
- abandoned-task requeue after lease expiry

**Conclusion:** strong regression test, but not the main proof for recovery semantics.

---

### 3. `scripts/e2e-rpc-test.mjs` and `scripts/integration-spawn-overrides-test.mts` — useful leader/RPC harnesses

These already exercise leader-side RPC orchestration.

Potential PR5 use:
- if we want a leader-driven stale-worker scenario without introducing a brand new harness, one of these can be extended carefully

Risk:
- both scripts already have other responsibilities
- adding too much lease/heartbeat logic may reduce readability and make failures harder to localize

**Conclusion:** use only for narrow extensions; prefer a dedicated new script for stale-worker recovery if PR5 grows beyond a small scenario.

---

### 4. `scripts/integration-todo-test.mts` — best long-form regression / soak seed

Current strengths:
- realistic multi-task, dependency-heavy workflow
- already has a longer runtime profile

Best use:
- post-merge regression confidence for PR4 cache behavior
- later soak seed for PR5 heartbeat + lease logic under realistic work duration

**Conclusion:** not the first place for targeted PR4/PR5 proof, but very useful for soak and “real work still finishes” confidence.

## Recommended new coverage placement

### A. Extend `scripts/smoke-test.mts`

This should remain the first stop for both PR4 and PR5.

#### PR4 additions
- repeated `listTasks()` / `getTask()` behavior under cache-on mode
- invalidation after `createTask`, `updateTask`, `completeTask`, `unassignTasksForAgent`
- file-backed truth wins after writes; no stale cached subject/status/owner values
- optional debug assertions if cache counters are exposed under a trace flag

#### PR5 additions
- lease metadata write/read helpers
- deterministic lease expiry decision logic
- stale-recovery metadata written when a task is reclaimed/requeued
- healthy lease renewal does not incorrectly requeue a task

Why here:
- fast
- deterministic
- required by CI automatically

---

### B. Add one dedicated PR5 integration script if stale-worker recovery becomes non-trivial

Preferred new file name:
- `scripts/integration-heartbeat-recovery-test.mts`

Use it for:
- spawn a leader and at least one worker
- assign or auto-claim a task
- simulate a worker that stops heartbeating or exits mid-task
- verify the leader marks it stale/offline
- verify the in-progress task is recovered or requeued once the lease expires
- verify config/task artifacts remain consistent

This should be the main end-to-end proof for PR5 recovery behavior.

Why a dedicated script is worth it:
- stale detection and lease recovery are timing-sensitive
- isolating them keeps failures diagnosable
- it prevents existing spawn/claim tests from becoming overloaded

---

### C. Keep `scripts/integration-claim-test.mts` as the PR4 regression guard

Recommended PR4 extension:
- run under `PI_TEAMS_TASK_CACHE=1`
- optionally increase task count modestly
- confirm all tasks still complete and ownership remains coherent

This provides strong evidence that cache changes did not break the most important happy path.

---

### D. Use `scripts/integration-todo-test.mts` as a soak entry point, not the main proof

Recommended use after PR4 and PR5 both land behind flags:
- run with cache on
- run with heartbeats on
- later run with leases on once recovery semantics are stable

Do not make this the first-line required CI for PR4/PR5.

## Verification strategy

### Required before PR4 merges

1. `npm run check`
2. `npm run smoke-test`
3. `npm run integration-claim-test`

PR4 merge criteria:
- deterministic cache-invalidates-after-write proof exists
- normal real-worker claim/complete flow remains green with cache enabled
- no rename churn mixed into the PR

### Required before PR5 merges

1. `npm run check`
2. `npm run smoke-test`
3. `npm run integration-claim-test`
4. dedicated stale-worker / recovery integration coverage
   - preferably `scripts/integration-heartbeat-recovery-test.mts`

PR5 merge criteria:
- leader can distinguish healthy vs stale worker state
- stale in-progress task recovery is proven end-to-end
- recovery is visible in task/config metadata
- healthy workers are not spuriously reclaimed

### Recommended manual verification

For PR4:
- run a normal leader session with `PI_TEAMS_TASK_CACHE=1`
- create/update/complete tasks manually and confirm task list/widget stays accurate

For PR5:
- run leader + worker with `PI_TEAMS_HEARTBEATS=1`
- kill or suspend worker mid-task and confirm stale classification is understandable
- then enable `PI_TEAMS_TASK_LEASES=1` and confirm abandoned work becomes recoverable without manual cleanup

## Soak-test ideas

### Soak 1 — cache stability under normal load

Duration:
- 20–30 minutes

Flags:
- `PI_TEAMS_TASK_CACHE=1`
- heartbeats/leases off

Scenario:
- 4 workers
- 40–60 tasks
- normal claim/complete flow
- repeated leader refreshes and task list reads

What to watch:
- stale UI/task-list state
- tasks disappearing or duplicating
- any cache/debug counters that suggest invalidation gaps

### Soak 2 — heartbeat stability without recovery enabled

Duration:
- 20–30 minutes

Flags:
- `PI_TEAMS_HEARTBEATS=1`
- `PI_TEAMS_TASK_LEASES=0`
- cache optional

Scenario:
- 3–4 workers
- mixed idle and busy periods
- some workers paused briefly but not killed

What to watch:
- false stale detections
- excessive config churn or heartbeat write load
- UI flicker caused by over-eager liveness updates

### Soak 3 — lease recovery under controlled failure

Duration:
- 30–45 minutes

Flags:
- `PI_TEAMS_HEARTBEATS=1`
- `PI_TEAMS_TASK_LEASES=1`
- cache optional after PR4 is stable

Scenario:
- 3–4 workers
- periodically kill one worker mid-task
- allow leader to recover abandoned tasks

What to watch:
- recovered tasks requeue only once
- healthy workers are not affected
- no repeated reclaim loops
- config/task metadata tells a clear story after recovery

### Soak 4 — combined runtime confidence

Duration:
- 45–60 minutes

Flags:
- `PI_TEAMS_TASK_CACHE=1`
- `PI_TEAMS_HEARTBEATS=1`
- `PI_TEAMS_TASK_LEASES=1`

Scenario:
- 4–6 workers
- 50–100 tasks
- mixed task durations
- dependency-heavy flow (seed from `integration-todo-test.mts` pattern)
- occasional worker interruption

What to watch:
- cache hiding stale-worker updates
- double-recovery or duplicate claims
- task lists drifting from on-disk truth

## Sequencing risks and recommendations

### Risk 1 — cache before invalidation discipline

If PR4 lands with weak invalidation, PR5 will be much harder to trust.

Recommendation:
- keep PR4 narrowly scoped to explicit write-through invalidation first
- avoid “smart” background watch logic unless the basic cache is already proven correct

### Risk 2 — enabling leases before heartbeats are trustworthy

Lease recovery without stable heartbeat freshness can produce false requeues.

Recommendation:
- prove `PI_TEAMS_HEARTBEATS=1` in isolation first
- only then enable `PI_TEAMS_TASK_LEASES=1` in targeted sessions

### Risk 3 — cache obscures stale-worker transitions

A task or member cache can make the leader think a worker is still healthy or a task is still leased.

Recommendation:
- treat PR5 state transitions as cache invalidation events by default
- if needed, bypass cache for liveness-critical reads until confidence is high

### Risk 4 — mixing PR4 and PR5 too aggressively

If cache, heartbeat, and lease changes all land at once, debugging regressions becomes slow.

Recommendation:
- merge PR4 first and soak it on its own
- merge PR5 with heartbeats first
- turn on leases only after heartbeat stability is demonstrated

### Risk 5 — overloading existing broad integration scripts

It is tempting to stuff all recovery behavior into `integration-claim-test.mts` or `integration-todo-test.mts`.

Recommendation:
- keep broad scripts as regression/soak tools
- create one focused PR5 recovery integration script if recovery logic becomes timing-sensitive

## Recommended promotion order

1. `PI_TEAMS_TASK_CACHE` — opt-in only, then default-on after cache invalidation confidence
2. `PI_TEAMS_HEARTBEATS` — opt-in, soak in internal sessions, then promote
3. `PI_TEAMS_TASK_LEASES` — last of the three, only after heartbeats are stable

If only one PR5 feature becomes mature enough to promote early, it should be **heartbeats visibility** rather than automatic lease recovery.

## Bottom line

The safest path is:
- **PR4:** prove cache correctness first, not just speed
- **PR5:** prove liveness visibility before automatic recovery
- keep both behind flags first
- use `scripts/smoke-test.mts` for deterministic invariants
- use `scripts/integration-claim-test.mts` as the cache regression guard
- create a focused `scripts/integration-heartbeat-recovery-test.mts` if PR5 needs a clean end-to-end recovery proof

That keeps the runtime hardening understandable and gives us a clean path to soak each behavior before promoting it more broadly.
