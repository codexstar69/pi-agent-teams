# PR6 / PR7 Rollout and Verification Note

## Scope being planned

This note covers the next two runtime-hardening slices after PR5:

- **PR6**: RPC startup handshake validation, startup failure classification, optional restart supervision sequencing
- **PR7**: worktree cleanup safety checks, diagnostics/doctor strategy, cleanup verification

This is written for the **internal fork**. Optimize for runtime reliability and maintainability, not upstream PR presentation. Keep current names, commands, and on-disk layout stable while these recovery and cleanup semantics are still changing.

## Why PR6 and PR7 should be planned together

These two slices are both about **operational trust**:

- PR6 determines whether we can trust spawned workers to boot cleanly and recover predictably.
- PR7 determines whether we can trust the system to clean up after itself without damaging repos or losing forensic value.

That means they share an important requirement:
- we need clear diagnostics before we enable more automation.

Recommended principle:
- **handshake before supervision**
- **diagnostics before destructive cleanup**

## Current baseline in the repo

### PR6 baseline

`extensions/teams/teammate-rpc.ts` currently:
- spawns `pi --mode rpc`
- listens to stdout for RPC responses and agent events
- waits a fixed `120ms` after spawn, then marks the teammate `idle`
- has no explicit ready/boot handshake
- has no structured startup failure classification
- has no restart supervision policy

This means current startup is optimistic and timing-sensitive.

### PR7 baseline

`extensions/teams/worktree.ts` currently:
- creates per-worker git worktrees
- falls back to shared workspace if worktree creation fails
- does not currently provide removal/prune helpers for cleanup

`extensions/teams/cleanup.ts` currently:
- protects against deleting outside the teams root
- deletes the team directory with `fs.rm(..., recursive: true, force: true)`
- does **not** currently remove git worktrees via `git worktree remove`

`extensions/teams/leader-lifecycle-commands.ts` currently:
- refuses cleanup while RPC teammates are running unless `--force`
- refuses cleanup while tasks are in progress unless `--force`
- delegates deletion to `cleanupTeamDir()`

This means current cleanup is filesystem-safe, but not yet fully **git-worktree-safe**.

## Recommended feature flags

### PR6 flags

#### 1. `PI_TEAMS_RPC_READY_HANDSHAKE`

Recommended meaning:
- `0` / unset: current fixed-sleep startup path
- `1`: child must emit an explicit ready/boot-complete signal before the parent marks it usable

What should be gated behind it:
- ready message emission/consumption
- startup timeout waiting for handshake
- startup failure classification when handshake never arrives

#### 2. `PI_TEAMS_RPC_SUPERVISOR`

Recommended meaning:
- `0` / unset: no automatic restart supervision
- `1`: leader may attempt bounded worker restarts after unexpected exit

What should be gated behind it:
- restart attempts on unexpected close
- restart counters / backoff
- restart classification metadata
- supervisor notifications

#### 3. `PI_TEAMS_RPC_SUPERVISOR_MAX_RESTARTS` *(recommended companion flag)*

Recommended meaning:
- integer cap on restart attempts per teammate/session

Why it matters:
- restart loops are worse than a single failure
- this should be part of the contract from the beginning

---

### PR7 flags

PR7 is more about safety than about changing default semantics, so fewer flags are needed.

#### 4. `PI_TEAMS_WORKTREE_CLEANUP`

Recommended meaning:
- `0` / unset: current cleanup behavior only
- `1`: cleanup attempts git-aware worktree removal before filesystem deletion

What should be gated behind it:
- `git worktree remove` usage
- stale worktree prune attempts
- worktree-related warnings/diagnostics during cleanup

#### 5. `PI_TEAMS_DOCTOR`

Recommended meaning:
- enables diagnostic/repair commands or checks that inspect:
  - stale locks
  - missing session files
  - worktree inconsistencies
  - stale members/tasks

This can remain internal-only and opt-in at first.

## Verification model for PR6

PR6 should be verified in three steps.

### Step 1 — startup handshake correctness

Purpose:
- prove the leader only treats a worker as ready after an explicit boot-complete signal

What to verify:
- happy path: child emits ready signal, leader marks worker usable
- timeout path: child never emits ready signal, leader reports startup failure clearly
- malformed/partial output before ready does not falsely count as readiness
- startup diagnostics include enough context to understand what failed

Best coverage home:
- new focused integration script, preferably:
  - `scripts/integration-rpc-startup-handshake-test.mts`

Why a focused script is worth it:
- startup behavior is timing-sensitive
- existing `e2e-rpc-test.mjs` is too broad to be the main proof
- handshake failures should be easy to isolate

---

### Step 2 — restart-supervision sequencing

Purpose:
- prove supervision is only added on top of a trusted handshake

Recommended sequence:
1. handshake on, supervisor off
2. handshake on, supervisor on with bounded restarts
3. only then consider wider internal enablement

What to verify:
- unexpected worker exit increments restart state
- bounded retries stop after the configured limit
- restarts do not occur for intentional shutdown paths
- restart attempts preserve useful task/session context when safe
- repeated startup failure does not loop forever

Best coverage home:
- separate focused integration script if needed:
  - `scripts/integration-rpc-supervisor-test.mts`

Do **not** merge handshake and supervision validation into one vague broad smoke flow.

---

### Step 3 — regression confidence

Use existing broad scripts only as regression guards:
- `scripts/integration-claim-test.mts`
- `scripts/e2e-rpc-test.mjs`

These should answer:
- normal spawned workers still function when handshake is enabled
- shutdown paths still behave correctly

They should not be the primary proof for startup failure semantics.

## Verification model for PR7

PR7 should be verified in two layers.

### Layer 1 — cleanup safety invariants

Purpose:
- prove cleanup does not delete the wrong thing and does not leave git metadata in a worse state

What to verify:
- existing path safety still blocks deletion outside teams root
- cleanup refuses unsafe worktree states unless policy/force says otherwise
- worktree-aware cleanup removes the git worktree registration before removing directories
- cleanup remains idempotent if worktree path is already gone

Best coverage home:
- extend deterministic tests around:
  - `extensions/teams/cleanup.ts`
  - new helpers likely added to `extensions/teams/worktree.ts`
- likely in `scripts/smoke-test.mts` for path safety
- add focused integration test for real git worktree cleanup:
  - `scripts/integration-worktree-cleanup-test.mts`

---

### Layer 2 — diagnostics / doctor behavior

Purpose:
- prove operators can see what is broken before they run a repair/destructive flow

What to verify:
- stale lock detection reports the lock path and owner metadata when available
- orphaned worktree paths vs git registrations are surfaced clearly
- missing session files and stale members are discoverable
- diagnostics distinguish warning-only issues from repairable/destructive ones

Best coverage home:
- focused deterministic helper assertions first
- if a `/team doctor` or similar command lands, add a targeted integration script rather than bloating lifecycle smoke

## Recommended new coverage placement

### 1. `scripts/integration-rpc-ready-handshake-test.mts`

This should be the primary PR6 proof.

Suggested assertions:
- worker does not become `idle` before ready handshake
- handshake success path yields usable RPC session
- startup timeout or early child exit yields clear failure classification
- stderr/startup diagnostics are preserved for debugging

### 2. Add `scripts/integration-rpc-supervisor-test.mts` only if supervision becomes non-trivial

Use it for:
- crash after successful start
- bounded restart attempts
- no restart on graceful shutdown
- no infinite restart loop on repeated boot failure

If supervision remains very small, this may be folded into the handshake script, but only if the test remains readable.

### 3. Add `scripts/integration-worktree-cleanup-test.mts`

This should be the primary PR7 proof.

Use it for:
- create temp git repo
- create worktree-backed teammate workspace
- invoke cleanup helper/flow
- verify git no longer reports the worktree
- verify cleanup stays inside teams root
- verify repeated cleanup is safe

### 4. Keep broad scripts as regression and soak seeds

Useful regression guards after PR6/PR7 changes:
- `scripts/e2e-rpc-test.mjs`
- `scripts/integration-claim-test.mts`
- `scripts/integration-todo-test.mts`

These should answer “did core behavior stay intact?” not “did startup failure and worktree cleanup semantics work perfectly?”

## Rollout sequencing recommendations

### PR6 sequencing

#### Stage A — handshake only
Flags:
- `PI_TEAMS_RPC_READY_HANDSHAKE=1`
- `PI_TEAMS_RPC_SUPERVISOR=0`

Goal:
- trust worker readiness classification before any restart automation exists

Merge confidence:
- focused handshake integration test passes
- broad spawned-worker regressions stay green

#### Stage B — supervision after handshake is boring
Flags:
- `PI_TEAMS_RPC_READY_HANDSHAKE=1`
- `PI_TEAMS_RPC_SUPERVISOR=1`
- bounded max restarts set conservatively

Goal:
- prove restart behavior is controlled, finite, and observable

Promotion rule:
- do not promote supervision until handshake failures are easy to diagnose and no false-ready states remain

---

### PR7 sequencing

#### Stage A — worktree-aware cleanup helpers
Goal:
- make cleanup git-aware before introducing more aggressive repair flows

#### Stage B — diagnostics / doctor output
Goal:
- surface stale/misaligned state before asking the system to repair it

#### Stage C — optional repair flows
Goal:
- only after diagnostics are trusted should repair commands become more automatic

Promotion rule:
- do not default-on any destructive repair behavior until worktree cleanup has been soak-tested in temp repos and a real project repo clone

## Manual verification guidance

### Manual PR6 pass A — startup handshake

Flags:
- handshake on
- supervisor off

Exercise:
- spawn teammate normally
- confirm startup feels normal
- then simulate a child that never reaches ready state

Expected:
- leader does not treat it as healthy/idle prematurely
- failure message is understandable and actionable

### Manual PR6 pass B — supervision

Flags:
- handshake on
- supervisor on

Exercise:
- kill worker after it has successfully started
- inspect restart behavior and logs

Expected:
- bounded restart attempts
- no restart on intentional shutdown path
- no silent looping

### Manual PR7 pass A — worktree cleanup safety

Flags:
- worktree cleanup on

Exercise:
- spawn worktree-backed teammate in a temp git repo
- run cleanup flow
- inspect `git worktree list`

Expected:
- worktree registration disappears cleanly
- no deletion outside expected directories

### Manual PR7 pass B — diagnostics

Exercise:
- create or simulate stale lock / stale member / missing session file / orphaned worktree
- run diagnostics flow

Expected:
- issues are classified clearly
- destructive action is not the first step unless explicitly requested

## Soak-test ideas

### Soak 1 — handshake stability

Duration:
- 20–30 minutes

Flags:
- handshake on
- supervisor off

Scenario:
- repeated worker spawn/shutdown cycles
- mixed fast and slow starts

Watch for:
- false-ready states
- startup timeouts that should have succeeded
- unreadable diagnostics

### Soak 2 — supervision stability

Duration:
- 30–45 minutes

Flags:
- handshake on
- supervisor on

Scenario:
- periodic forced worker exits
- some workers fail at boot, some fail mid-run

Watch for:
- restart loops
- task/session corruption after restart
- noisy or missing operator signals

### Soak 3 — cleanup safety

Duration:
- 20–30 minutes

Flags:
- worktree cleanup on

Scenario:
- repeated creation and cleanup of worktree-backed teammates in temp repos

Watch for:
- orphaned git worktrees
- unsafe deletion behavior
- cleanup failures leaving partial state

## Main sequencing risks

### Risk 1 — supervision before handshake trust

If the leader cannot reliably tell whether a worker actually booted, supervision will restart the wrong thing or hide startup bugs.

Recommendation:
- handshake first
- supervision second

### Risk 2 — destructive cleanup before diagnostics

If cleanup/repair gets smarter before diagnostics are trustworthy, operators lose visibility and cleanup mistakes get harder to debug.

Recommendation:
- diagnostics first for visibility
- repair second

### Risk 3 — worktree cleanup relying only on filesystem deletion

Removing directories without removing git registrations leaves repo metadata dirty.

Recommendation:
- make git-aware cleanup the standard verified path before promoting PR7 behavior

### Risk 4 — overloading existing broad integration scripts

Broad lifecycle scripts become hard to debug when they also own startup failure and cleanup semantics.

Recommendation:
- add focused PR6/PR7 integration scripts for primary proof
- keep broad scripts as regressions only

## Bottom line

The safest PR6/PR7 rollout path is:

- **PR6:** validate explicit startup readiness first, then add bounded supervision
- **PR7:** validate git-aware cleanup safety first, then add diagnostics/doctor flows, then consider repair automation

Primary proof should live in focused scripts:
- `integration-rpc-startup-handshake-test.mts`
- `integration-rpc-supervisor-test.mts` if needed
- `integration-worktree-cleanup-test.mts`

That keeps failure diagnosis clean and avoids mixing operational safety work into broad runtime smoke too early.
