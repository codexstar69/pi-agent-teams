# PR6 explicit RPC ready handshake — first slice

This note captures the current low-risk PR6 slice for replacing the old fixed startup sleep with an explicit RPC ready handshake.

## Current implementation state

`extensions/teams/teammate-rpc.ts` now treats readiness as a real RPC exchange:
- spawn child process
- send `get_state`
- wait for a successful response within `PI_TEAMS_RPC_START_TIMEOUT_MS` (default 10s)
- only then mark teammate status as `idle`

If the handshake fails, startup now throws an explicit error:
- `Teammate RPC ready handshake failed for <name>: ...`

This is the correct first step because it removes the arbitrary fixed boot delay and replaces it with a real capability check.

## What this slice proves

The current integration test (`scripts/integration-rpc-ready-handshake-test.mts`) validates the happy path:
- teammate starts successfully
- status becomes `idle` only after handshake succeeds
- `getState()` returns a valid payload
- the payload is sane for a ready-but-idle child (`isStreaming=false`, `pendingMessageCount=0`)

## What still needs to be validated next

The next PR6 slices should add failure-mode coverage before any restart supervision lands.

### Failure scenarios to cover
1. **startup timeout**
   - child never answers `get_state`
   - expected outcome: explicit handshake timeout error
2. **early process exit**
   - child exits before responding
   - expected outcome: classified startup failure, not generic idle/stopped state confusion
3. **slow-but-valid startup**
   - delayed response still succeeds inside timeout
4. **stderr noise during startup**
   - does not count as readiness

## Safe sequencing for PR6

1. keep current handshake path as the only readiness signal
2. add failure-mode test fixtures
3. improve error classification if tests show ambiguity
4. add observation-only restart metadata
5. only then add opt-in restart supervision

## Safety rules

- no teammate may transition to `idle` before a real RPC response
- stderr output alone must never satisfy readiness
- startup timeouts must remain explicit and actionable
- restart supervision must remain separate from handshake validation

## Verification strategy

### Current command
- `bun run integration-rpc-ready-handshake-test`

### Next commands to add later
- startup timeout fixture test
- early-exit fixture test
- optional slow-start fixture test

## Review boundary

This PR6 slice is intentionally narrow:
- explicit readiness is already in place
- current focus is validation and rollout discipline
- restart behavior remains a later, separately reviewable concern
