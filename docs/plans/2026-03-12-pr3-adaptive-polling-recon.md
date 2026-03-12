# PR3 adaptive polling reconnaissance

Adaptive polling is already wired in the current runtime.

## Current state

### Helper module
- `extensions/teams/adaptive-polling.ts`
- opt-in flag: `PI_TEAMS_ADAPTIVE_POLLING=1`
- helper functions:
  - `getWorkerPollDelayMs(...)`
  - `getLeaderRefreshPollDelayMs(...)`
  - `getLeaderInboxPollDelayMs(...)`

### Worker wiring
- `extensions/teams/worker.ts`
- poll loop tracks:
  - inbox activity
  - pending work
  - running work
  - idle streak
- sleep delay is computed by `getWorkerPollDelayMs(...)`

### Leader wiring
- `extensions/teams/leader.ts`
- refresh loop and inbox loop both use `setTimeout(...)` rather than fixed `setInterval(...)`
- each loop computes idle streak and uses:
  - `getLeaderRefreshPollDelayMs(...)`
  - `getLeaderInboxPollDelayMs(...)`

## Safety properties already present

- feature remains opt-in
- legacy cadence remains the default when disabled
- active team work keeps leader/worker loops fast
- idle teams back off to bounded ceilings

## This slice

To keep this task low-risk and reviewable, I added focused verification rather than further runtime changes:
- `scripts/integration-adaptive-polling-test.mts`

This gives a narrow regression suite for the helper-level behavior that the runtime loops already depend on.

## Next safe follow-up if more PR3 work is needed

1. expose current effective polling mode in diagnostics/widget
2. add loop-level counters/telemetry for idle streaks and chosen delays
3. add soak tests comparing active vs idle filesystem churn

No additional runtime changes were necessary in this slice because helper + loop wiring already exists.
