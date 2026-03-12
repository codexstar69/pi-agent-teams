# PR6 / PR7 rollout and verification notes

This note covers the next safe rollout slices for:
- PR6: RPC startup handshake validation + restart supervision sequencing
- PR7: worktree cleanup hardening + doctor / diagnostics strategy

The guiding rule is the same for both tracks: **instrument and validate first, recover later**.

---

## PR6 — startup handshake validation

### Current state

`extensions/teams/teammate-rpc.ts` already moved from a fixed startup sleep to a startup handshake by issuing `get_state` and waiting for a response before declaring the teammate ready.

This is the right direction because it:
- avoids arbitrary boot sleeps
- fails fast on broken RPC startup
- produces a clearer startup error path

### What still needs validation

Before adding restart supervision, validate the handshake path in isolation.

#### Scenarios to verify
1. **healthy startup**
   - child answers `get_state`
   - teammate transitions to `idle`
2. **slow startup within timeout**
   - delayed readiness still succeeds
3. **startup timeout**
   - missing response yields explicit handshake failure
4. **early child exit**
   - process dies before ready and reports actionable error
5. **stderr noise during startup**
   - does not count as readiness by itself

### Suggested verification assets
- narrow RPC startup integration test
- fixture child that can:
  - answer immediately
  - answer after delay
  - never answer
  - exit early

### Rollout guidance
Ship in this order:
1. handshake test coverage
2. startup error classification cleanup
3. user-facing warnings / logs for handshake failure
4. only then restart supervision

---

## PR6 — restart supervision sequencing

Restart supervision is high leverage but also high risk. It should be introduced in phases.

### Phase 1: observation only
Add metadata/logging only:
- restart attempt count
- last unexpected exit code
- last restart timestamp
- last restart reason

No automatic restart yet.

### Phase 2: opt-in single restart
Behind a flag, allow one best-effort restart for unexpected exits.

Suggested flag:
- `PI_TEAMS_RPC_SUPERVISOR=1`

Suggested limits:
- one restart by default
- restart window, e.g. 60s
- no restart on clean shutdown
- no restart during explicit `/team shutdown` or `/team kill`

### Phase 3: task-aware restart policy
Only after PR5 lease wiring is stable.

Rules:
- do not auto-restore in-progress work unless lease ownership rules are explicit
- if restart occurs after task lease expiry, prefer leader-side recovery/requeue
- restart should never silently duplicate active work

### Verification matrix
- child exits once unexpectedly -> one restart attempt
- child crashes repeatedly -> supervisor stops retrying
- explicit shutdown -> no restart
- explicit kill -> no restart
- stale in-progress task after failed restart -> leader recovery path handles it

---

## PR7 — worktree cleanup hardening

### Current state

`extensions/teams/cleanup.ts` now validates:
- team dir is inside teams root
- managed worktrees are inside `<teamDir>/worktrees`
- cleanup uses a validated plan before recursive deletion

This is a good planning/safety base, but it still does **filesystem deletion only**.

### Next cleanup hardening steps

#### Step 1: inspect worktree state
Add pure helpers in `worktree.ts` to report:
- repo root for a candidate worktree
- whether path is registered as a git worktree
- whether worktree appears dirty
- whether branch name is known

This must be read-only.

#### Step 2: cleanup plan with actions
Extend cleanup planning to classify each worktree path into one of:
- `git_remove`
- `fs_remove_only`
- `skip_missing`
- `unsafe_reject`

This should still be planning only.

#### Step 3: best-effort git cleanup
When safe:
- run `git worktree remove <path>` first
- optionally follow with `git worktree prune`
- fall back to filesystem cleanup only when:
  - worktree already missing, or
  - explicitly marked orphaned and safe to remove

### Safety checks
Never remove a worktree path unless all are true:
- path is under `<teamDir>/worktrees`
- path resolves to a directory
- plan classified it as managed
- if using git removal, target repo is discoverable and command is scoped to expected repo

### Verification matrix
- managed clean worktree -> planned for git removal
- missing worktree dir -> skip / no error
- non-worktree directory under worktrees root -> filesystem-only plan or explicit warning
- unsafe external path -> rejected
- dirty worktree -> warning surfaced; behavior explicit

---

## PR7 — doctor / diagnostics strategy

Doctor should start as **read-only diagnostics**.

### Goals
Give operators a trustworthy snapshot of team health before any repair logic exists.

### First doctor report should include
- stale worker heartbeats
- workers marked online but missing recent heartbeat
- in-progress tasks whose owners are offline/stale
- tasks with expired leases
- managed worktree paths and classification
- unsafe cleanup paths rejected by validation
- stale lock files (if detectable without mutation)
- mailbox sizes / oversized inboxes (optional but useful)

### Output format
Prefer a pure diagnostic helper returning structured data:
- machine-readable object first
- UI formatting second

That enables:
- `/team doctor`
- future tests
- possible JSON/debug output later

### Repair strategy sequencing
Do **not** mix diagnosis and repair in the first pass.

Ship in this order:
1. read-only doctor helper
2. `/team doctor` command
3. review warnings from real usage
4. add narrow repair actions one by one
5. only later consider `/team cleanup --repair`

---

## Rollout flags

Recommended flags and their status:

### PR6
- `PI_TEAMS_RPC_START_TIMEOUT_MS`
  - already useful for handshake validation
- `PI_TEAMS_RPC_SUPERVISOR=1`
  - keep opt-in initially
- future: `PI_TEAMS_RPC_MAX_RESTARTS`
- future: `PI_TEAMS_RPC_RESTART_WINDOW_MS`

### PR7
- no flag needed for read-only doctor helpers
- future cleanup hardening could use:
  - `PI_TEAMS_SAFE_WORKTREE_CLEANUP=1`
  - `PI_TEAMS_WORKTREE_PRUNE=1`

---

## Recommended delivery order

### PR6
1. handshake validation tests
2. startup failure classification/logging
3. observation-only restart metadata
4. opt-in single restart
5. task-aware supervision after lease recovery is stable

### PR7
1. worktree inspection helpers
2. read-only doctor helper
3. cleanup action planning
4. safe git worktree removal
5. optional repair actions

---

## Minimum success criteria

### PR6
- teammate never reports `idle` before a real handshake response
- startup timeouts are explicit and actionable
- restart supervision never restarts intentional shutdowns

### PR7
- cleanup never touches paths outside managed team/worktree roots
- doctor can explain stale workers, stuck tasks, and managed worktrees without mutating state
- destructive worktree cleanup is preceded by explicit safe classification
