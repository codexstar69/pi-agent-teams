# Contributing

Thanks for contributing to `@codexstar/pi-agent-teams`.

## Development setup

```bash
bun install
bun run typecheck
bun run lint
bun run smoke-test
```

For interactive local dogfooding:

- macOS/Linux: `bun run start-team:tmux`
- Windows: `bun run start-team:windows`

## Contribution standards

Please keep changes:

- small and reviewable
- tested before claiming completion
- documented when behavior changes
- cross-platform where practical

## Required verification

Before opening a PR, run the relevant checks:

```bash
bun run typecheck
bun run lint
bun run smoke-test
```

For lifecycle / RPC / hooks / worktree changes, also run the relevant integration tests.

## PR expectations

A good PR includes:

- what changed
- why it changed
- user-visible impact
- verification evidence
- docs updates if commands, env vars, or workflows changed

## Triage expectations

Maintainership may ask for:

- a smaller PR
- an added smoke or integration test
- a docs update
- a safer migration path for breaking behavior
