# Final stabilization checklist and internal rename staging note

## Purpose

This note defines:

1. what must be true before we do the internal rename pass,
2. which compatibility shims we should keep during migration,
3. what evidence we should gather first.

This is for the **internal fork**. The rename should happen only after the runtime is boring enough that a naming change does not hide stability regressions.

## Rule of thumb

**Do not rename while we are still proving runtime semantics.**

The rename pass should start only after the team runtime is stable enough that any new failure is clearly attributable to the rename/migration layer, not to ongoing concurrency, recovery, cleanup, or scheduling work.

---

## How to use this note once PR8 closes

Treat this document as the **single pre-rename sign-off checklist**.

Recommended usage:
1. confirm PR1–PR8 runtime work is merged or intentionally deferred,
2. collect the evidence bundle listed below,
3. walk the checklist sections in order,
4. write down any open items explicitly,
5. only start the rename pass when every blocking item is either complete or consciously accepted.

If a reviewer cannot tell from this note whether the rename is safe to begin, the note is not finished yet.

---

## Final stabilization checklist

Before the rename pass starts, all of the following should be true.

### A. Core runtime hardening is landed and understood

These areas should already exist in the codebase and be operationally trusted:
- lock correctness
- retry/cooldown behavior
- worker cap behavior
- adaptive polling / mailbox bounding / task cache behavior
- heartbeat freshness and lease recovery behavior
- RPC ready handshake behavior
- worktree cleanup and doctor support
- structured logging and priority ordering behavior

Not every feature has to be default-on yet, but the behavior must be:
- implemented,
- documented,
- and testable in isolation.

### B. Primary verification surfaces are in place

At minimum, we should have stable evidence from:
- `npm run smoke-test`
- `npm run integration-claim-test`
- `npm run integration-rpc-ready-handshake-test`
- `npm run integration-heartbeat-lease-scaffold-test`
- `npm run integration-cleanup-worktree-plan-test`
- `npm run integration-git-worktree-cleanup-test`
- `npm run integration-team-doctor-test`

And, where applicable, focused PR-specific scripts for the harder runtime slices.

### C. Soak evidence exists

Before rename, we should have recent soak results covering at least:
- healthy multi-worker task completion
- heartbeat freshness without false stale churn
- lease recovery under controlled worker failure
- repeated spawn/shutdown cycles with handshake enabled
- worktree-backed teammate creation and cleanup
- doctor output on intentionally broken state
- structured log generation under normal load
- priority ordering under mixed pending tasks

### D. Operator diagnostics are trusted

Before rename, operators should already be able to answer:
- why a worker failed to start,
- why a task was retried,
- why a task was recovered,
- why cleanup refused to run,
- whether worktree state is safe,
- whether runtime state is actually bad or only looks unusual.

That means doctor output, logs, and task/config metadata should already be usable **before** the rename.

### E. Runtime defaults are settled enough

We do not need every flag default-on, but we should know which of these are intended to remain:
- permanent knobs,
- temporary migration flags,
- or future defaults.

In other words: do not rename env vars and commands while the semantics behind them are still changing weekly.

---

## What must be frozen before rename

Before renaming commands, paths, or package identity, the following surfaces should be treated as **frozen contracts**:

### 1. Runtime semantics

These behaviors must stop moving first:
- task claim / retry / cooldown semantics
- heartbeat freshness and stale-worker classification
- lease recovery rules
- startup handshake / supervisor behavior
- cleanup refusal vs cleanup execution rules
- priority ordering rules
- event-log schema at least at the envelope level

If these are still changing, a rename will hide whether a regression came from semantics or migration.

### 2. Operator-facing diagnostics

These outputs should be stable enough that we can compare before/after rename runs:
- doctor issue categories and severity model
- task metadata fields operators rely on
- event-log envelope fields
- cleanup refusal / recovery / startup failure messages
- task-show diagnostic sections

The exact wording can improve later, but the meaning and field structure should be stable.

### 3. Migration boundaries

These decisions should already be made before rename work starts:
- which old commands remain as aliases during migration
- which env vars get fallback support
- whether the root path actually changes
- whether session-name prefixes change
- whether the tool name `team_message` stays as a compatibility alias
- how long we keep legacy reads before cleanup

Do not begin renaming while those boundaries are still undecided.

### 4. Review boundaries

Rename PRs should be frozen to migration-only scope:
- no new scheduling logic
- no new cleanup semantics
- no new recovery behavior
- no new logging schema changes
- no new mutation APIs

This keeps reviewability high and failure attribution clean.

---

## Evidence to gather first

Before starting the rename, gather a small internal evidence pack.

### 1. Verification evidence

Capture the latest outputs for:
- required smoke/integration scripts
- any focused runtime scripts added during PR6/PR7/PR8
- typecheck status (including any known unrelated failures if still present)

### 2. Soak evidence

Record:
- date/time of soak run
- flags enabled
- task/worker counts
- whether any stale-worker, cleanup, or scheduling anomalies occurred
- links/paths to logs if available

### 3. Runtime state examples

Save representative examples of:
- `config.json`
- task JSON with retry/lease metadata
- doctor output
- event log lines
- cleanup refusal / recovery messages

These become the baseline for migration validation after rename.

### 4. Surface inventory

Before renaming anything, explicitly inventory all surfaces that contain current naming:
- package name
- repo/docs references
- `/team` commands
- `team_message` tool name
- session names
- widget/panel labels
- style defaults and terminology strings
- env vars beginning with `PI_TEAMS_`
- on-disk paths under `~/.pi/agent/teams`
- script names and docs references

If a surface is not in the inventory, it will be missed during migration.

### 5. Final pre-rename sign-off record

Before the first rename PR lands, capture a short sign-off record with:
- date of sign-off,
- commit or branch being approved as the rename baseline,
- which verification scripts were run and when,
- which soak runs are being treated as the authoritative evidence,
- any known unrelated failures being accepted,
- the explicit migration owner for commands, env vars, and on-disk path changes.

This prevents the rename from starting against a moving target.

---

## Recommended rename order

Keep the rename staged. Do not do it in one giant pass.

### Stage 1 — metadata and docs only

Safe first rename targets:
- package metadata
- repo-level docs
- plan docs
- non-runtime-facing labels

Why first:
- low runtime risk
- easy to review
- does not change stored state or command behavior

### Stage 2 — session/widget/style labels

Next rename targets:
- session naming prefix
- widget/panel titles
- default style terminology strings

Why here:
- these are visible but comparatively low-risk
- if something looks wrong, the runtime still works the same way underneath

### Stage 3 — command aliases before command replacement

Do **not** immediately remove `/team`.

Recommended approach:
- add the new command alias first
- keep `/team` working during migration
- update docs to prefer the new alias
- only remove or demote legacy aliases after soak confidence

Same principle applies to any future `/tw` / widget aliases.

### Stage 4 — environment variables and on-disk paths with shims

This is the riskiest rename stage and should happen only after the earlier stages are stable.

Targets here:
- `PI_TEAMS_*` env vars
- `~/.pi/agent/teams`
- hook/style root lookup behavior

This stage requires explicit compatibility shims.

### Stage 5 — legacy cleanup

Only after migration soak:
- remove old command aliases
- remove old env var fallbacks
- stop reading legacy root paths
- clean up old docs references

---

## Required compatibility shims

These are the shims we should expect to need during the rename window.

### 1. Command alias shims

Keep legacy commands working while the new names are introduced.

At minimum:
- old `/team ...` path should continue to dispatch
- old widget aliases should continue to work if new ones are added

Migration rule:
- prefer additive aliases first, removal later

### 2. Environment variable fallback shims

If `PI_TEAMS_*` variables are renamed, support both old and new names for at least one migration window.

Recommended pattern:
- read new env var first
- fall back to old env var
- optionally emit a warning only in debug/doctor output, not on every normal run

This applies especially to:
- root dir override
- hook paths
- heartbeat/lease knobs
- handshake/supervisor knobs
- cleanup/doctor flags
- priority/logging flags

### 3. On-disk root path compatibility lookup

If the internal branding requires a new root path, do not cut over cold.

Recommended behavior during migration:
- check new root first
- if missing, check legacy `~/.pi/agent/teams`
- support a one-time migration/copy or compatibility lookup
- keep cleanup scoped carefully so the old and new roots are never confused

This is especially important for:
- task lists
- mailboxes
- sessions
- worktrees
- hooks
- styles
- logs

### 4. Session name compatibility

If session names change, the resume/inspection story should remain usable.

Recommended approach:
- accept both legacy and new session-name patterns during the migration window
- avoid breaking discovery or human debugging for existing sessions

### 5. Tool-name compatibility

If the worker-facing tool name changes from `team_message`, keep the old tool available as a compatibility alias until all prompts/docs/system templates have migrated.

This is important because tool names are part of runtime behavior, not just docs.

### 6. Doctor awareness of legacy names

Doctor/diagnostics should understand both old and new naming during migration.

Otherwise it may incorrectly classify perfectly valid legacy state as broken.

Doctor should be able to recognize:
- old root paths
- old session prefixes
- old env/config naming
- old task/log/style locations if any move occurs

---

## What not to combine with rename

Do **not** mix rename with:
- new recovery semantics
- new cleanup semantics
- new scheduling rules
- new logging schema changes
- new mutation APIs

Rename should be a migration pass, not another behavior pass.

If a PR both renames and changes runtime logic, review quality drops sharply and regression diagnosis gets harder.

---

## Rename readiness gate

A simple readiness gate before rename starts:

- runtime hardening slices are landed
- focused verification scripts exist and are passing or known-failing only for unrelated tracked reasons
- recent soak evidence exists
- doctor output is trustworthy
- event logs are trustworthy
- surface inventory is complete
- compatibility shim plan is written down before the first rename PR lands

If any of those are missing, delay the rename.

---

## Final pre-rename checklist

Use this as the last go/no-go pass after PR8 closes.

### Blockers — all must be true

- [ ] PR1–PR8 stabilization work is merged, intentionally deferred, or explicitly carved out of the rename scope.
- [ ] Runtime semantics listed in **What must be frozen before rename** are no longer changing week to week.
- [ ] Doctor output is trusted enough to distinguish real breakage from legacy-state noise.
- [ ] Event-log output is trusted enough to compare before/after rename behavior.
- [ ] Required compatibility shims are designed before the first rename PR starts.
- [ ] The evidence bundle has been collected and attached to the rename baseline.
- [ ] The surface inventory is complete enough that commands, paths, env vars, session names, tool names, and docs references are all accounted for.
- [ ] Rename PRs are scoped to migration-only changes.

### Strongly recommended before green-lighting

- [ ] At least one recent healthy soak run exists with the intended runtime defaults/flags.
- [ ] At least one controlled-failure soak run exists for worker failure / recovery / cleanup paths.
- [ ] A representative before-rename artifact set has been saved (`config.json`, task JSON, doctor output, event logs, refusal/recovery messages).
- [ ] Legacy alias retention/removal timing has been decided in advance.
- [ ] Root-path migration behavior has been decided in advance.

### Explicit go/no-go question

If we renamed commands, paths, and package identity today, would a regression be easy to attribute to:
- rename compatibility,
- or a still-moving runtime behavior?

If the answer is **not obviously "rename compatibility"**, do not start the rename pass yet.

---

## Bottom line

The rename should happen only after the runtime is stable enough that naming changes are the only real moving part.

Before rename:
- gather evidence,
- trust diagnostics,
- inventory every surface,
- and plan shims first.

During rename:
- rename docs/metadata first,
- aliases before replacements,
- env/path shims before migration,
- and legacy cleanup last.
