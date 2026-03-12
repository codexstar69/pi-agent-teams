# Concise executable verification checklist

This is the short operator version of the full verification/soak plan.

Run from repo root:

```bash
cd /Users/codex/projects/pi-agent-teams
mkdir -p .tmp/verification-logs
runlog() {
  local name="$1"
  shift
  "$@" 2>&1 | tee ".tmp/verification-logs/${name}.log"
}
```

---

## A. Fast gate

Run in order. Stop on first failure.

```bash
runlog 01-typecheck bun run typecheck
runlog 02-lint bun run lint
runlog 03-smoke bun run smoke-test
```

Expected output:
- `typecheck`: exit 0
- `lint`: exit 0
- `smoke-test`: summary ends with `FAILED: 0`

Manual check:
- no unexpected stack traces
- no module-resolution errors

---

## B. Focused feature proofs

```bash
runlog 10-adaptive bun x tsx scripts/integration-adaptive-polling-test.mts
runlog 11-mailbox bun x tsx scripts/integration-mailbox-pruning-test.mts
runlog 12-heartbeat bun run integration-heartbeat-lease-scaffold-test
runlog 13-rpc bun run integration-rpc-ready-handshake-test
runlog 14-cleanup-plan bun run integration-cleanup-worktree-plan-test
runlog 15-worktree-helper bun run integration-git-worktree-cleanup-helper-test
runlog 16-worktree-cleanup bun run integration-git-worktree-cleanup-test
runlog 17-doctor bun run integration-team-doctor-test
```

Expected output:
- every script ends with a clear `PASS:` or `PASSED:` line
- no flaky retry loops
- no leftover temp worktrees in test repos

Manual check:
- `integration-rpc-ready-handshake-test` must show handshake success and failure-path assertions, not only happy path
- `integration-team-doctor-test` must show stale worker + stale lock + managed worktree reporting

---

## C. Broader regression flows

```bash
runlog 20-claim bun run integration-claim-test
runlog 21-spawn bun run integration-spawn-overrides-test
runlog 22-hooks bun run integration-hooks-remediation-test
runlog 23-todo bun run integration-todo-test
runlog 24-e2e-rpc bun x node scripts/e2e-rpc-test.mjs
```

Expected output:
- exit 0 for all commands
- no healthy-run stale-worker warnings
- no stuck `in_progress` tasks after clean shutdown

Manual check:
- workers still spawn, claim, DM, and shut down normally
- no confusing startup-handshake regressions in healthy runs

---

## D. Hardened flag matrix

### D1. Baseline

```bash
runlog 30-baseline-smoke bun run smoke-test
runlog 31-baseline-claim bun run integration-claim-test
```

Expected output:
- legacy/default behavior still green

### D2. Adaptive polling on

```bash
runlog 32-adaptive-on env \
  PI_TEAMS_ADAPTIVE_POLLING=1 \
  bun run integration-claim-test
```

Expected output:
- pass
- no visible slowdown in active flow

### D3. Heartbeats + lease metadata on

```bash
runlog 33-heartbeats-on env \
  PI_TEAMS_HEARTBEAT_INTERVAL_MS=4000 \
  PI_TEAMS_HEARTBEAT_STALE_MS=25000 \
  PI_TEAMS_TASK_LEASE_DURATION_MS=18000 \
  bun run integration-todo-test
```

Expected output:
- pass
- no false stale-worker classification in healthy run

### D4. Explicit RPC startup timeout

```bash
runlog 34-rpc-timeout env \
  PI_TEAMS_RPC_START_TIMEOUT_MS=15000 \
  bun run integration-rpc-ready-handshake-test
```

Expected output:
- pass
- healthy startup still succeeds inside timeout
- failure path still produces explicit handshake error

### D5. Combined hardened runtime

```bash
runlog 35-hardened env \
  PI_TEAMS_ADAPTIVE_POLLING=1 \
  PI_TEAMS_HEARTBEAT_INTERVAL_MS=4000 \
  PI_TEAMS_HEARTBEAT_STALE_MS=25000 \
  PI_TEAMS_TASK_LEASE_DURATION_MS=18000 \
  PI_TEAMS_RPC_START_TIMEOUT_MS=15000 \
  bun run integration-claim-test
```

Expected output:
- pass
- no healthy-flow regressions

---

## E. Manual evidence passes

## E1. Healthy runtime pass

Set flags:

```bash
export PI_TEAMS_ADAPTIVE_POLLING=1
export PI_TEAMS_HEARTBEAT_INTERVAL_MS=4000
export PI_TEAMS_HEARTBEAT_STALE_MS=25000
export PI_TEAMS_TASK_LEASE_DURATION_MS=18000
export PI_TEAMS_RPC_START_TIMEOUT_MS=15000
```

In Pi, run:
1. `/team spawn alice fresh`
2. `/team spawn bob fresh`
3. `/team task add alice: inspect a file`
4. `/team task add bob: inspect another file`
5. `/team doctor`
6. `/team shutdown`
7. `/team doctor`

Capture evidence:
- widget screenshot with workers online
- `/team doctor` output during healthy run
- `/team doctor` output after shutdown

Expected manual result:
- healthy workers are **not** stale
- doctor output is readable and non-destructive
- shutdown leaves no obviously stuck worker/task state

## E2. Worktree cleanup pass

In a temp git repo, run:
1. `/team spawn alice fresh worktree`
2. `git worktree list`
3. cleanup flow
4. `git worktree list`
5. `/team doctor`

Capture evidence:
- `git worktree list` before cleanup
- `git worktree list` after cleanup
- cleanup warnings if any

Expected manual result:
- managed worktree is visible before cleanup
- registration disappears after cleanup
- no unrelated paths are touched

## E3. Stale-worker observation pass

In a safe sandbox:
1. spawn a worker
2. capture `/team doctor`
3. stop/kill the worker externally or let it go stale in a controlled way
4. capture `/team doctor` again

Capture evidence:
- before/after `/team doctor`
- widget screenshot if stale heartbeat warning appears

Expected manual result:
- stale worker is reported by name
- report stays diagnostic only
- no unrelated workers are flagged stale

---

## F. Soak checklist

## F1. Soak 1 — healthy runtime (30–60 min)

Flags:

```bash
export PI_TEAMS_ADAPTIVE_POLLING=1
export PI_TEAMS_HEARTBEAT_INTERVAL_MS=4000
export PI_TEAMS_HEARTBEAT_STALE_MS=25000
export PI_TEAMS_TASK_LEASE_DURATION_MS=18000
export PI_TEAMS_RPC_START_TIMEOUT_MS=15000
```

Run repeated normal flows with 4–8 workers if machine allows.

Use as anchors:

```bash
runlog 40-soak-claim bun run integration-claim-test
runlog 41-soak-todo bun run integration-todo-test
```

Capture:
- `/team doctor` at start, mid-run, end
- any stale-lock warnings
- any stale-worker warnings

Expected result:
- no false stale-worker noise during healthy operation
- no stuck tasks after healthy completion
- no obvious UI thrash or polling sluggishness

## F2. Soak 2 — worktree lifecycle (20–30 min)

Run repeated cycles in temp git repos:
- create repo
- spawn worktree-backed teammate(s)
- inspect `git worktree list`
- cleanup
- inspect `git worktree list` again
- repeat

Capture:
- before/after `git worktree list`
- note any orphaned registrations

Expected result:
- no orphaned worktree registrations accumulate
- cleanup remains idempotent

## F3. Soak 3 — doctor signal quality (15–20 min)

During mixed activity, capture doctor output for:
- healthy state
- after one worker shutdown
- after one stale-lock simulation in a temp team dir if safe

Expected result:
- doctor clearly separates stale workers, stale locks, and managed worktrees
- output stays readable
- false positives stay low

---

## G. PR8 coverage note

PR8 is only partially landed, so use the existing regression suite plus targeted manual inspection.

Automated proof still comes from:
- `bun run smoke-test`
- `bun run integration-claim-test`
- `bun run integration-todo-test`

Manual PR8 inspection should verify:
- priority / retry / lease visibility in task views if surfaced
- structured log files, if present, are append-only and readable
- no new UI noise from added visibility features

If PR8 changes added event logs in your branch, also capture:
- one sample log file path
- first 5–10 lines of that log
- confirmation that repeated events append rather than rewrite unexpectedly

---

## H. Minimum evidence bundle before promotion

Save all of these:
- fast gate logs (`01`–`03`)
- focused feature logs (`10`–`17`)
- regression logs (`20`–`24`)
- hardened flag logs (`30`–`35`)
- healthy `/team doctor` output
- stale-worker `/team doctor` output
- `git worktree list` before/after cleanup
- short final note with:
  - commit SHA
  - date/time
  - flags used
  - failed commands, if any
  - recommendation: promote / more soak / blocked

---

## I. One-shot execution block

```bash
cd /Users/codex/projects/pi-agent-teams
mkdir -p .tmp/verification-logs
runlog() {
  local name="$1"
  shift
  "$@" 2>&1 | tee ".tmp/verification-logs/${name}.log"
}
runlog 01-typecheck bun run typecheck
runlog 02-lint bun run lint
runlog 03-smoke bun run smoke-test
runlog 10-adaptive bun x tsx scripts/integration-adaptive-polling-test.mts
runlog 11-mailbox bun x tsx scripts/integration-mailbox-pruning-test.mts
runlog 12-heartbeat bun run integration-heartbeat-lease-scaffold-test
runlog 13-rpc bun run integration-rpc-ready-handshake-test
runlog 14-cleanup-plan bun run integration-cleanup-worktree-plan-test
runlog 15-worktree-helper bun run integration-git-worktree-cleanup-helper-test
runlog 16-worktree-cleanup bun run integration-git-worktree-cleanup-test
runlog 17-doctor bun run integration-team-doctor-test
runlog 20-claim bun run integration-claim-test
runlog 21-spawn bun run integration-spawn-overrides-test
runlog 22-hooks bun run integration-hooks-remediation-test
runlog 23-todo bun run integration-todo-test
runlog 24-e2e-rpc bun x node scripts/e2e-rpc-test.mjs
runlog 30-baseline-smoke bun run smoke-test
runlog 31-baseline-claim bun run integration-claim-test
runlog 32-adaptive-on env PI_TEAMS_ADAPTIVE_POLLING=1 bun run integration-claim-test
runlog 33-heartbeats-on env PI_TEAMS_HEARTBEAT_INTERVAL_MS=4000 PI_TEAMS_HEARTBEAT_STALE_MS=25000 PI_TEAMS_TASK_LEASE_DURATION_MS=18000 bun run integration-todo-test
runlog 34-rpc-timeout env PI_TEAMS_RPC_START_TIMEOUT_MS=15000 bun run integration-rpc-ready-handshake-test
runlog 35-hardened env PI_TEAMS_ADAPTIVE_POLLING=1 PI_TEAMS_HEARTBEAT_INTERVAL_MS=4000 PI_TEAMS_HEARTBEAT_STALE_MS=25000 PI_TEAMS_TASK_LEASE_DURATION_MS=18000 PI_TEAMS_RPC_START_TIMEOUT_MS=15000 bun run integration-claim-test
```

If this block is green, move on to the manual passes and soak passes above.
