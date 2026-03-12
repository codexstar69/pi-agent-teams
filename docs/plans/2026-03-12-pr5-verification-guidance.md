# PR5 Verification Guidance

## Scope

This note focuses specifically on **PR5** runtime verification:

- heartbeat freshness
- lease metadata shape and lifecycle
- stale-worker recovery sequencing

It is intentionally narrower than the broader PR4/PR5 rollout note. The goal is to make PR5 easy to reason about during implementation and rollout in our **internal fork**.

## Current baseline we already have

There is already a good PR5 scaffold in the repo:

- `extensions/teams/heartbeat-lease.ts`
- `scripts/integration-heartbeat-lease-scaffold-test.mts`

That scaffold already covers:
- heartbeat config parsing
- heartbeat freshness classification (`fresh`, `stale`, `missing`, `invalid`)
- lease creation and refresh
- lease metadata round-trip
- lease recovery decisions for:
  - active lease
  - expired lease with fresh owner
  - expired lease with stale owner
  - no lease metadata

This means PR5 is **not** starting from zero. The main remaining work is to connect those primitives to real worker/leader behavior and verify the sequencing between freshness, lease expiry, and task recovery.

## Verification model for PR5

PR5 should be verified in **three layers**.

### Layer 1 — deterministic helper correctness

Purpose:
- prove the math and metadata rules are correct before wiring them into runtime loops

Primary coverage home:
- `scripts/integration-heartbeat-lease-scaffold-test.mts`
- `scripts/smoke-test.mts` for task-store/config-level invariants if lease fields touch existing task paths

This layer should answer:
- when is a heartbeat considered fresh vs stale?
- what lease timestamps are created and refreshed?
- when should a leased task be considered recoverable?
- what recovery reason should be recorded?

This layer should stay:
- fast
- deterministic
- free from live Pi timing variability

---

### Layer 2 — artifact-level integration correctness

Purpose:
- prove leader/worker artifact writes are coherent once heartbeat and lease helpers are wired in

Primary coverage home:
- `scripts/smoke-test.mts`
- optionally extend `scripts/integration-claim-test.mts` for healthy-worker regression only

This layer should answer:
- do worker/config updates write `lastSeenAt` consistently?
- does task metadata include stable lease shape?
- do heartbeat-driven updates preserve task ownership/state when the worker is healthy?
- do healthy workers avoid false recovery?

This is still mostly deterministic, but now includes artifact consistency across:
- `config.json`
- task JSON files
- leader task refresh paths

---

### Layer 3 — end-to-end stale-worker recovery

Purpose:
- prove stale-worker detection and abandoned-task recovery behave correctly under timing and process failure

Primary coverage home:
- a focused integration script, preferably:
  - `scripts/integration-heartbeat-recovery-test.mts`

This layer should answer:
- does the leader classify a worker as stale only after heartbeat freshness is lost?
- does recovery wait for both stale freshness and lease expiry rules as designed?
- does a stale in-progress task requeue exactly once?
- do healthy workers avoid being reclaimed?
- does task/config metadata clearly explain what happened?

This is the only layer that should depend heavily on real process timing.

## Recommended sequencing for PR5 verification

### Stage 1 — heartbeat freshness first

Before automatic recovery is enabled, verify only freshness.

Flags:
- `PI_TEAMS_HEARTBEATS=1`
- `PI_TEAMS_TASK_LEASES=0`

What to prove first:
- workers update `lastSeenAt` at the expected cadence
- stale classification occurs only after the intended threshold
- short pauses or slow turns do not trigger false stale classification
- UI/config visibility is understandable before any recovery action happens

This stage is about **visibility**, not recovery.

Merge confidence for this stage:
- helper/scaffold test passes
- healthy-worker integration regression stays green
- one manual run confirms no false stale churn

---

### Stage 2 — lease metadata second

Once heartbeat freshness is trusted, wire lease metadata without auto-recovery surprises.

Flags:
- `PI_TEAMS_HEARTBEATS=1`
- `PI_TEAMS_TASK_LEASES=1`

But in initial verification, recovery logic should be inspected carefully rather than promoted quickly.

What to prove:
- claimed tasks get lease metadata in a stable shape
- lease refresh extends `expiresAt` when the owner remains healthy
- lease token/owner data stays coherent across refreshes
- a healthy worker with a fresh heartbeat is **not** recovered even if the task is long-running

This stage is about **metadata trustworthiness**.

---

### Stage 3 — stale-worker recovery last

Only after freshness and lease metadata are trusted should the team rely on automatic recovery.

What to prove:
- stale worker + expired lease => recovery
- stale worker + active lease => no premature recovery
- expired lease + fresh worker => no recovery
- missing/invalid owner heartbeat => conservative recovery behavior matches documented reason
- recovered task returns to a recoverable scheduler state without duplicate claims

This stage is about **recovery correctness under failure**.

## Recommended environment knobs to verify explicitly

PR5 has three timing knobs that should be treated as part of the contract:

### `PI_TEAMS_HEARTBEAT_INTERVAL_MS`
What it controls:
- how often workers report liveness

Verify:
- invalid values fall back safely
- a shorter interval does not cause excessive churn
- a longer interval still works with stale thresholds chosen appropriately

### `PI_TEAMS_HEARTBEAT_STALE_MS`
What it controls:
- when the leader should consider a worker stale

Verify:
- stale threshold is greater than heartbeat interval by a safe margin
- the chosen threshold avoids false positives during normal slow turns
- stale classification timing matches docs and logs

### `PI_TEAMS_TASK_LEASE_DURATION_MS`
What it controls:
- how long a task lease stays active before it is eligible for recovery logic

Verify:
- default derives sensibly from heartbeat interval
- shorter durations do not reclaim active work incorrectly
- longer durations do not leave abandoned tasks stuck too long

## Where new coverage should live

### 1. Keep and use `scripts/integration-heartbeat-lease-scaffold-test.mts`

This file is already the best targeted home for:
- heartbeat freshness helper behavior
- lease metadata helper behavior
- recovery decision helper behavior

It should remain the first-line proof for PR5 helper logic.

### 2. Extend `scripts/smoke-test.mts` only for artifact-level invariants

Good uses:
- lease metadata written into task JSON in the expected shape
- config `lastSeenAt` interactions remain sane
- task-store behavior remains coherent when lease metadata is present

Do **not** turn `smoke-test.mts` into the main timing-sensitive stale-worker recovery harness.

### 3. Add a focused runtime recovery test if needed

Preferred file:
- `scripts/integration-heartbeat-recovery-test.mts`

This should cover:
- real leader + real worker
- task claim
- worker death / stalled heartbeats
- stale detection
- lease expiry
- recovery / requeue

This focused script is preferable to overloading:
- `integration-claim-test.mts`
- `integration-todo-test.mts`
- `e2e-rpc-test.mjs`

## Manual verification guidance

### Manual pass A — freshness only

Flags:
- `PI_TEAMS_HEARTBEATS=1`
- `PI_TEAMS_TASK_LEASES=0`

Exercise:
- start leader + 1 worker
- let worker idle, then work on a task
- pause briefly and resume
- inspect `config.json` and UI behavior

Expected:
- `lastSeenAt` moves forward predictably
- no false stale classification during normal operation

### Manual pass B — lease metadata visibility

Flags:
- `PI_TEAMS_HEARTBEATS=1`
- `PI_TEAMS_TASK_LEASES=1`

Exercise:
- claim a task
- inspect task file after claim and after a subsequent refresh

Expected:
- lease metadata is present and coherent
- `expiresAt` advances when the worker remains healthy
- no spontaneous recovery occurs while the worker is still fresh

### Manual pass C — controlled stale-worker recovery

Flags:
- `PI_TEAMS_HEARTBEATS=1`
- `PI_TEAMS_TASK_LEASES=1`

Exercise:
- let worker start a task
- kill or suspend worker
- wait beyond stale and lease thresholds
- inspect task + config artifacts

Expected:
- worker becomes stale/offline in a way that is understandable
- task is recovered once the recovery rule is satisfied
- recovery metadata explains why it happened
- no duplicate claims or oscillation

## Soak priorities for PR5

### Soak 1 — freshness stability

Run first.

Flags:
- heartbeats on
- leases off

Goal:
- prove freshness classification is stable before recovery is allowed to act on it

### Soak 2 — lease stability without aggressive failures

Run second.

Flags:
- heartbeats on
- leases on

Goal:
- prove long-running healthy work does not get reclaimed accidentally

### Soak 3 — controlled recovery

Run third.

Flags:
- heartbeats on
- leases on

Goal:
- prove abandoned work becomes recoverable exactly once and returns cleanly to the queue

## Main sequencing rule

**Do not promote stale-worker recovery until heartbeat freshness is boring.**

If freshness classification is noisy, lease recovery will be noisy too. The safest PR5 sequence is:

1. helper freshness correctness
2. runtime freshness visibility
3. lease metadata correctness
4. stale-worker recovery
5. broader soak

## Bottom line

PR5 verification should be staged around one simple rule:

- first trust the **freshness signal**
- then trust the **lease metadata**
- only then trust **automatic recovery**

The repo already has a useful scaffold (`heartbeat-lease.ts` + `integration-heartbeat-lease-scaffold-test.mts`). The next step is to preserve that clean separation and avoid mixing timing-sensitive stale-worker recovery into broad existing scripts too early.
