# Full verification + soak checklist

This is the concrete runnable checklist for validating the PR1–PR7 runtime hardening work.

It is organized in execution order:
1. fast local gate
2. focused deterministic tests
3. broader regression flows
4. manual inspection passes
5. soak passes
6. evidence bundle to save

The goal is to make it obvious:
- which commands to run
- which flags to enable
- what to inspect manually
- what counts as enough evidence to promote changes

---

## 0. Shell setup

Run all commands from the repo root:

```bash
cd /Users/codex/projects/pi-agent-teams
```

Optional helper for clean logs:

```bash
mkdir -p .tmp/verification-logs
```

If you want to capture all output to files while still seeing it live:

```bash
runlog() {
  local name="$1"
  shift
  "$@" 2>&1 | tee ".tmp/verification-logs/${name}.log"
}
```

---

## 1. Fast local gate

Run this first. If any step fails, stop and fix before moving on.

### 1.1 Typecheck

```bash
runlog 01-typecheck bun run typecheck
```

### 1.2 Lint

```bash
runlog 02-lint bun run lint
```

### 1.3 Core smoke

```bash
runlog 03-smoke bun run smoke-test
```

Manual inspection:
- verify smoke summary ends with `FAILED: 0`
- verify no unexpected stack traces or module-resolution noise

Evidence to save:
- `.tmp/verification-logs/01-typecheck.log`
- `.tmp/verification-logs/02-lint.log`
- `.tmp/verification-logs/03-smoke.log`

---

## 2. Focused deterministic regression suite

These are the feature-specific proofs for PR1–PR7.

Run in this exact order.

### 2.1 PR3 adaptive polling helper behavior

```bash
runlog 10-adaptive-polling bun x tsx scripts/integration-adaptive-polling-test.mts
```

### 2.2 PR3 mailbox pruning / compaction

```bash
runlog 11-mailbox-pruning bun x tsx scripts/integration-mailbox-pruning-test.mts
```

### 2.3 PR5 heartbeat + lease helper behavior

```bash
runlog 12-heartbeat-lease bun run integration-heartbeat-lease-scaffold-test
```

### 2.4 PR6 RPC ready handshake

```bash
runlog 13-rpc-ready-handshake bun run integration-rpc-ready-handshake-test
```

### 2.5 PR7 cleanup planning safety

```bash
runlog 14-cleanup-plan bun run integration-cleanup-worktree-plan-test
```

### 2.6 PR7 git-aware worktree cleanup helpers

```bash
runlog 15-git-worktree-helper bun run integration-git-worktree-cleanup-helper-test
```

### 2.7 PR7 git-aware worktree cleanup integration

```bash
runlog 16-git-worktree-cleanup bun run integration-git-worktree-cleanup-test
```

### 2.8 PR7 doctor helper / formatting

```bash
runlog 17-team-doctor bun run integration-team-doctor-test
```

Manual inspection:
- each script should end in a clear PASS/PASSED line
- no test should rely on hidden retries or intermittent flake to pass
- worktree tests should not leave temp worktrees behind in the repo under test

Evidence to save:
- `10-adaptive-polling.log`
- `11-mailbox-pruning.log`
- `12-heartbeat-lease.log`
- `13-rpc-ready-handshake.log`
- `14-cleanup-plan.log`
- `15-git-worktree-helper.log`
- `16-git-worktree-cleanup.log`
- `17-team-doctor.log`

---

## 3. Broader regression flows

These prove the runtime still behaves normally under real team flows.

### 3.1 Claim / auto-claim regression

```bash
runlog 20-claim bun run integration-claim-test
```

### 3.2 Spawn overrides / model / worker-policy regression

```bash
runlog 21-spawn-overrides bun run integration-spawn-overrides-test
```

### 3.3 Hook remediation regression

```bash
runlog 22-hooks-remediation bun run integration-hooks-remediation-test
```

### 3.4 Todo / dependency-heavy regression

```bash
runlog 23-todo bun run integration-todo-test
```

### 3.5 Broad RPC end-to-end regression

```bash
runlog 24-e2e-rpc bun x node scripts/e2e-rpc-test.mjs
```

Manual inspection:
- workers should still spawn, claim, message, and shut down cleanly
- no new false stale-worker warnings during healthy runs
- no stuck `in_progress` tasks after clean shutdown
- no confusing RPC startup failures in healthy runs

Evidence to save:
- `20-claim.log`
- `21-spawn-overrides.log`
- `22-hooks-remediation.log`
- `23-todo.log`
- `24-e2e-rpc.log`

---

## 4. Feature-flag matrix

Run the focused checks under the intended runtime flags.

## 4.1 Baseline (legacy/default behavior)

Use no extra flags:

```bash
runlog 30-baseline-smoke bun run smoke-test
runlog 31-baseline-claim bun run integration-claim-test
```

## 4.2 Adaptive polling enabled

```bash
runlog 32-adaptive-on env \
  PI_TEAMS_ADAPTIVE_POLLING=1 \
  bun run integration-claim-test
```

## 4.3 Heartbeats visible, lease recovery still conservative

```bash
runlog 33-heartbeats-on env \
  PI_TEAMS_HEARTBEAT_INTERVAL_MS=4000 \
  PI_TEAMS_HEARTBEAT_STALE_MS=25000 \
  PI_TEAMS_TASK_LEASE_DURATION_MS=18000 \
  bun run integration-todo-test
```

## 4.4 RPC startup timeout explicit

```bash
runlog 34-rpc-timeout-config env \
  PI_TEAMS_RPC_START_TIMEOUT_MS=15000 \
  bun run integration-rpc-ready-handshake-test
```

## 4.5 Combined “hardened runtime” pass

```bash
runlog 35-hardened-runtime env \
  PI_TEAMS_ADAPTIVE_POLLING=1 \
  PI_TEAMS_HEARTBEAT_INTERVAL_MS=4000 \
  PI_TEAMS_HEARTBEAT_STALE_MS=25000 \
  PI_TEAMS_TASK_LEASE_DURATION_MS=18000 \
  PI_TEAMS_RPC_START_TIMEOUT_MS=15000 \
  bun run integration-claim-test
```

Manual inspection:
- ensure enabling adaptive polling does not slow active flows visibly
- ensure heartbeat/lease settings do not produce false stale-worker/offline classification in healthy runs
- ensure RPC timeout env does not regress healthy startup

---

## 5. Manual inspection passes

These are not replacements for tests. They are operator-confidence checks.

## 5.1 Manual pass A — healthy team session

Flags:

```bash
export PI_TEAMS_ADAPTIVE_POLLING=1
export PI_TEAMS_HEARTBEAT_INTERVAL_MS=4000
export PI_TEAMS_HEARTBEAT_STALE_MS=25000
export PI_TEAMS_TASK_LEASE_DURATION_MS=18000
export PI_TEAMS_RPC_START_TIMEOUT_MS=15000
```

Start pi in a temp git repo or safe playground repo.

Suggested flow:
1. start `pi`
2. `/team spawn alice fresh`
3. `/team spawn bob fresh`
4. `/team task add alice: create a tiny file or inspect a file`
5. `/team task add bob: review another file`
6. wait for both workers to go active and finish
7. run `/team doctor`
8. run `/team shutdown`

Manual evidence to capture:
- screenshot or copy of widget with workers online
- screenshot or copy of `/team doctor` output during healthy state
- screenshot or copy of `/team doctor` output after shutdown

What to inspect:
- workers show recent heartbeat activity, not stale
- no unexpected stale-lock warnings during healthy operation
- doctor output is readable and non-destructive
- shutdown leaves no obviously stuck workers/tasks

## 5.2 Manual pass B — worktree-backed flow

In a temp git repo:
1. start `pi`
2. `/team spawn alice fresh worktree`
3. confirm worktree exists under team worktree directory
4. inspect `git worktree list`
5. perform cleanup flow when safe
6. inspect `git worktree list` again

Manual evidence to capture:
- `git worktree list` before cleanup
- `git worktree list` after cleanup
- any warnings surfaced during cleanup/doctor output

What to inspect:
- managed worktree is classified correctly
- cleanup does not touch unrelated paths
- git registration disappears cleanly when cleanup path is exercised

## 5.3 Manual pass C — stale-worker observation

This is observation-only. Do not simulate destructive recovery yet.

Suggested flow:
1. start `pi`
2. spawn a worker
3. note current `/team doctor` output
4. stop/kill the worker process externally or let it go stale in a controlled sandbox
5. refresh `/team doctor`

Manual evidence to capture:
- before/after `/team doctor` output
- any widget warning line for stale worker heartbeats

What to inspect:
- stale worker is reported by name
- output is diagnostic, not destructive
- no unrelated workers are misclassified stale

---

## 6. Soak passes

These should be run after all deterministic and manual passes are green.

## 6.1 Soak 1 — healthy runtime stability (30–60 min)

Flags:

```bash
export PI_TEAMS_ADAPTIVE_POLLING=1
export PI_TEAMS_HEARTBEAT_INTERVAL_MS=4000
export PI_TEAMS_HEARTBEAT_STALE_MS=25000
export PI_TEAMS_TASK_LEASE_DURATION_MS=18000
export PI_TEAMS_RPC_START_TIMEOUT_MS=15000
```

Run:
- repeated worker spawn/shutdown cycles
- 4–8 workers over time if machine allows
- 20–50 mixed tasks
- some DMs and broadcast messages
- some hook activity if available

Suggested command anchors:
- use `bun run integration-todo-test` as a seed
- use `bun run integration-claim-test -- --agents 4 --tasks 20` if the script supports it in your local branch
- otherwise run repeated normal flows manually in pi

Manual evidence to capture:
- one doctor snapshot at start
- one doctor snapshot mid-run
- one doctor snapshot at end
- note any stale lock or stale worker warnings

Success criteria:
- no growing stale-lock noise during healthy operation
- no false stale-worker reports while workers are active
- no obvious polling-related sluggishness or UI thrash

## 6.2 Soak 2 — worktree lifecycle stability (20–30 min)

Flags:

```bash
export PI_TEAMS_ADAPTIVE_POLLING=1
export PI_TEAMS_RPC_START_TIMEOUT_MS=15000
```

Run repeated cycles in temp git repos:
1. create repo
2. spawn worktree-backed teammate(s)
3. verify `git worktree list`
4. perform cleanup
5. verify `git worktree list` again
6. repeat

Manual evidence to capture:
- `git worktree list` samples across cycles
- any failures to remove worktree registrations
- any orphaned paths under team worktree dirs

Success criteria:
- no orphaned registrations accumulate
- no cleanup path touches directories outside managed worktree root
- repeated cleanup remains idempotent

## 6.3 Soak 3 — doctor usefulness / signal quality (15–20 min)

Goal:
- verify doctor output remains readable and useful under real activity

Run during a mixed active session and capture:
- healthy state
- after one worker shutdown
- after one stale lock simulation in a temp team dir if safe

Success criteria:
- output clearly separates stale workers, managed worktrees, and stale locks
- no noisy false positives dominate the report
- report is useful enough for operators without reading raw files

---

## 7. Manual evidence checklist

Save all of the following before calling the rollout verified:

### Automated evidence
- typecheck log
- lint log
- smoke log
- focused feature integration logs
- broader regression logs

### Manual evidence
- screenshot or pasted output of healthy `/team doctor`
- screenshot or pasted output of stale-worker `/team doctor`
- `git worktree list` before/after cleanup in temp repo
- any RPC ready-handshake failure output if you intentionally test failure paths

### Final summary note
Write a short verification summary containing:
- date/time
- git commit SHA tested
- commands run
- flags used
- failures seen and whether they were expected
- final recommendation: safe to promote / needs more soak / blocked

---

## 8. Recommended exact execution order

If you want the shortest credible path, run this exact sequence:

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
```

Then do:
1. healthy manual pass
2. worktree manual pass
3. stale-worker manual pass
4. soak 1
5. soak 2
6. soak 3

If all of that is clean, the runtime is in good shape for promotion.
