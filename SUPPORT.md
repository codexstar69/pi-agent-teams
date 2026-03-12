# Support

## Getting help

Use the right channel for the right problem:

- **Bug reports:** GitHub Issues
- **Feature requests:** GitHub Issues
- **Security issues:** see `SECURITY.md`
- **Usage / setup questions:** GitHub Discussions if enabled, otherwise Issues tagged `question`

## Before opening an issue

Please include:

- package version
- Pi version
- OS (`macOS`, `Windows`, `Linux`)
- whether you are using npm package, local install, or dev extension load
- relevant environment variables (`PI_TEAMS_*`)
- exact command you ran
- expected behavior vs actual behavior
- minimal reproduction

## Troubleshooting checklist

1. Run `/team id` and confirm team/task-list paths.
2. Run `bun run typecheck && bun run lint && bun run smoke-test` in the repo.
3. If worktrees are involved, run `/team doctor`.
4. If hooks are involved, verify `PI_TEAMS_HOOKS_ENABLED=1` and inspect `hook-logs/`.
5. On Windows, prefer the PowerShell instructions from `/team env <name>`.

## Compatibility notes

See `docs/COMPATIBILITY.md` for current platform expectations and shell support.
