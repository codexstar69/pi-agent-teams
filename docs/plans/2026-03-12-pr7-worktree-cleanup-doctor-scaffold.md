# PR7 worktree cleanup + doctor scaffold

This slice adds safe cleanup planning primitives before wiring destructive git worktree removal or a `/team doctor` command.

## What landed

Helper-level cleanup safety in `extensions/teams/cleanup.ts`:
- `getTeamWorktreesDir(teamDir)`
- `assertWorktreePathWithinTeamDir(teamDir, worktreePath)`
- `listManagedWorktreePaths(teamDir)`
- `buildTeamCleanupPlan(teamsRootDir, teamDir, worktreePaths)`

`cleanupTeamDir(...)` now builds a validated cleanup plan before deleting the team directory tree.

## Why this is safe

- no git worktree removal is attempted yet
- no lifecycle command behavior changes are required yet
- all worktree cleanup paths are constrained to `<teamDir>/worktrees/*`
- the cleanup plan API is reusable for future doctor/repair flows

## What landed next

Git-aware inspection helpers now exist in `extensions/teams/worktree.ts`:
- `listGitWorktreeEntries(repoRoot)`
- `inspectGitWorktreePath({ repoRoot, worktreePath })`
- `planGitWorktreeCleanupAction(inspection)`

These helpers are still read-only. They let cleanup logic classify a managed path as:
- `git_remove`
- `fs_remove_only`
- `skip_missing`

This means the next destructive cleanup step can be based on an explicit inspected plan rather than guessing from filesystem state alone.

## What landed after that

Read-only doctor scaffolding now exists in `extensions/teams/doctor.ts`:
- `collectTeamDoctorReport(...)`
- `formatTeamDoctorReport(...)`

Current report contents:
- stale workers from heartbeat freshness
- managed worktree paths under `<teamDir>/worktrees`
- stale lock files under the team directory
- a short summary string for operator/UI use

This is intentionally non-destructive and is now suitable for `/team doctor` wiring.

`/team doctor` now uses the read-only doctor report formatter and surfaces the current snapshot without mutating team state.

## Intended next steps

### Cleanup hardening
1. connect git-aware inspection to cleanup planning
2. add best-effort `git worktree remove <path>` before filesystem deletion
3. annotate failures/warnings instead of silently deleting

### Doctor / repair
1. expose `collectTeamDoctorReport(...)` through `/team doctor`
2. extend report with in-progress tasks whose owners are stale/offline
3. add read-only mailbox size / oversized inbox reporting if useful
4. later add `/team cleanup --repair` for safe remediation

## Review boundary

This PR7 slice is intentionally limited to planning + path-safety helpers. It does not yet change the user-visible cleanup flow beyond validating managed worktree paths before removal.
