# PR2 Rollout and Testing Note

## Scope being planned

This note covers **PR2 from `docs/plans/2026-03-12-world-class-stability-roadmap.md`**:

- retry metadata on failed tasks
- retry cooldown / retry exhaustion behavior
- max-worker policy at spawn/delegate time
- tests and rollout guidance for the above

This is written for the **internal fork**. The goal is not upstream PR polish; the goal is to land the runtime hardening in a way that is easy for us to verify, operate, and extend. During PR2, **keep current names and user-facing terminology stable** so comparisons against current behavior stay simple.

## Recommended PR2 feature flags

PR2 should still ship behind flags first.

### 1. `PI_TEAMS_TASK_RETRY_POLICY`

Recommended meaning:
- `0` / unset: current behavior (no new retry policy enforcement)
- `1`: enable retry metadata, cooldown handling, retry exhaustion, and scheduler-side skip behavior for exhausted/cooling tasks

What should be gated behind it:
- writing retry metadata into task `metadata`
- cooldown timestamps / retry backoff logic
- retry exhaustion handling
- any new scheduling rule that skips tasks in cooldown or exhausted state

### 2. `PI_TEAMS_MAX_WORKERS`

Recommended meaning:
- unset: preserve current behavior for the first implementation pass, or default to a conservative internal default only after soak confidence
- set to integer `N`: cap spawned teammates for both `/team spawn` and tool-driven `delegate` / `member_spawn`

What should be gated behind it:
- direct spawn refusal when at cap
- delegate/tool auto-spawn refusal or warning once cap is reached
- any surfaced notification text explaining why a spawn did not occur

## Existing verification surface

### 1. `scripts/smoke-test.mts` — best deterministic home for retry logic

Current relevant baseline:
- covers core `task-store.ts` CRUD and claim/update paths
- already verifies locking, task creation, assignment, completion, and dependency behavior
- runs in required CI via `npm run smoke-test`

What it does **not** cover yet for PR2:
- retry metadata written on failure/abort
- cooldown calculation behavior
- exhaustion thresholds and skip semantics
- metadata preservation across retry state transitions
- max-worker policy because spawn/delegate flows are not exercised here

**Conclusion:** `scripts/smoke-test.mts` should be the primary home for deterministic retry-policy verification.

---

### 2. `scripts/integration-spawn-overrides-test.mts` — best existing home for max-worker policy

Current relevant baseline:
- already drives a real leader in RPC mode
- already exercises `/team spawn ...` end-to-end
- already validates spawn refusal flows and notification messages for invalid input
- already inspects `config.json` snapshots for spawned workers

Why it is a good fit for PR2 max-worker coverage:
- the harness is already set up for leader-side spawn decisions
- it already asserts user-visible rejection behavior
- it avoids inventing a new RPC leader harness just for spawn caps

What it does **not** cover yet:
- max-worker refusal once cap is reached
- delegate/tool-driven auto-spawn under cap pressure

**Conclusion:** extend this script first for `/team spawn` max-worker enforcement. If tool-driven delegate coverage gets too large, split that into a dedicated integration script.

---

### 3. `scripts/integration-claim-test.mts` — useful secondary retry regression signal

Current relevant baseline:
- real workers auto-claim and complete tasks
- validates end-to-end task claiming under parallel workers

What it does **not** cover for PR2:
- failure/abort loops
- cooldown/exhaustion behavior
- scheduler-side skip logic for cooling/exhausted tasks

**Conclusion:** not a primary PR2 proof target. Keep it as a regression guard for “normal work still succeeds after retry logic lands.”

---

### 4. `scripts/e2e-rpc-test.mjs` — optional tool/delegate coverage

This script already drives a leader over RPC and exercises basic team lifecycle.

Possible PR2 use:
- add a narrow delegate-path assertion if we want to prove `teams(delegate)` or model-driven spawn respects max-worker limits

However:
- the current script is broad lifecycle smoke, not focused spawn policy verification
- adding too much PR2-specific logic here may make failures harder to diagnose

**Conclusion:** optional only. Prefer `integration-spawn-overrides-test.mts` first, then create a small dedicated PR2 integration script if needed.

## Recommended coverage placement for PR2

### A. Extend `scripts/smoke-test.mts` for retry/cooldown/exhaustion

This should be the primary required PR2 proof.

Add a PR2 subsection covering:
- failed task metadata written correctly (`retryCount`, failure timestamps/reason, cooldown markers, exhaustion markers as implemented)
- cooldown/backoff calculation remains deterministic
- exhausted tasks are not considered immediately claimable again
- non-failed tasks still claim/complete normally
- leader/task-store helper behavior stays compatible with the current file format

Why here:
- deterministic and fast
- no child Pi processes required
- becomes required automatically in CI

Recommended shape:
- keep pure policy math and metadata assertions here
- do not rely on real model output to simulate failures if a direct task-store/state transition can express the invariant more reliably

---

### B. Extend `scripts/integration-spawn-overrides-test.mts` for max-worker enforcement

This should be the primary end-to-end proof for worker-cap policy.

Add assertions for:
- with `PI_TEAMS_MAX_WORKERS=1`, first spawn succeeds and second spawn is rejected
- rejection produces a clear notification / response
- rejected worker is not written as online in `config.json`
- existing workers remain healthy when later spawns are refused

Optional second step in the same script:
- validate cap behavior for `/team spawn` and, if easy, a tool-driven spawn path

If tool-path coverage makes the script messy, do **not** overload it. Split instead.

---

### C. Create a narrow new script only if delegate-path coverage needs isolation

Preferred new file name if needed:
- `scripts/integration-max-workers-test.mts`

Use it only for:
- `teams` tool `delegate` / `member_spawn` cap enforcement
- round-robin delegation behavior when requested teammates exceed cap
- verifying that cap failures are warnings/refusals rather than silent partial corruption

This should be created only if `integration-spawn-overrides-test.mts` becomes too mixed-purpose.

---

### D. Keep `scripts/integration-claim-test.mts` green as the “normal flow still works” regression check

No major PR2-specific additions are required here unless retry logic accidentally changes normal claim/complete flow.

Optional light enhancement:
- run with more tasks than workers and assert all tasks still complete under PR2 with retry policy enabled but no failures injected

## Verification plan for PR2

### Required before merge

1. **Fast deterministic verification**
   - `npm run check`
   - `npm run smoke-test`

2. **Targeted integration coverage**
   - `npm run integration-spawn-overrides-test`
   - if a new PR2-specific script is added, run that too

3. **Regression confidence**
   - `npm run integration-claim-test`

### Optional but recommended during rollout

- run `scripts/integration-todo-test.mts` once manually after PR2 lands to confirm dependency-driven real work still completes under the new retry metadata rules
- run a manual leader session with `PI_TEAMS_MAX_WORKERS=1` and confirm visible refusal behavior feels sane

## Rollout recommendation

### Step 1 — Land code with both flags default-off

- `PI_TEAMS_TASK_RETRY_POLICY` off by default
- `PI_TEAMS_MAX_WORKERS` unset/off by default

This keeps PR2 safe while we validate behavior in internal sessions.

### Step 2 — Turn on in targeted internal sessions

Recommended internal test matrix:
- retry policy on, max-workers off
- retry policy off, max-workers = 1
- retry policy on, max-workers = 2 or 3

This helps isolate which behavior causes regressions.

### Step 3 — Promote only the safer behavior first

Expected promotion order:
1. `PI_TEAMS_MAX_WORKERS` with a conservative default, once spawn/delegate flows are stable
2. `PI_TEAMS_TASK_RETRY_POLICY` only after retry metadata and cooldown semantics have proven easy to reason about in live use

Reasoning:
- max-worker caps are easier to reason about operationally
- retry policy changes scheduler behavior and deserves longer soak time

## Recommended PR2 acceptance checklist

Before PR2 merges, we should be able to point to:

### Retry policy
- deterministic smoke coverage for retry metadata and cooldown/exhaustion semantics
- no hot-loop behavior in targeted failure simulation
- normal claim/complete flows still pass unchanged

### Max-worker policy
- end-to-end spawn refusal proven in integration coverage
- refusal is visible and non-destructive
- config/task state remains consistent when extra spawns are refused

### Operational stance
- both features remain flag-gated initially
- no rename or terminology churn mixed into PR2

## Bottom line

For PR2, the cleanest path is:
- **put retry/cooldown/exhaustion proof in `scripts/smoke-test.mts`**
- **put spawn-cap proof in `scripts/integration-spawn-overrides-test.mts`**
- only create a new PR2-specific integration script if delegate-path cap coverage becomes too awkward to keep readable

That keeps the verification story simple, keeps required CI fast, and fits the repo’s current testing shape without introducing unnecessary test sprawl.
