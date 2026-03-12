# Architecture

`pi-agent-teams` is a Pi extension with two runtime roles:

- **leader** — owns commands, widget/panel UI, teammate lifecycle, hooks, and team coordination
- **worker** — polls mailboxes, claims/starts tasks, reports idle/completion, and executes assigned work

## Core building blocks

- `task-store.ts` — file-per-task persistence, dependency graph, claim/start/complete/retry logic
- `mailbox.ts` — mailbox queues for leader/worker and peer communication
- `team-config.ts` — persisted team membership and policy state
- `teammate-rpc.ts` — child-process RPC wrapper for spawned teammates
- `leader.ts` — orchestration entrypoint for the leader role
- `worker.ts` — orchestration entrypoint for the worker role
- `hooks.ts` — optional quality gates / hook execution
- `worktree.ts` — isolated git worktree support for teammates

## Persistence model

State lives under the teams root directory:

- team config
- tasks
- mailboxes
- sessions
- optional worktrees
- logs / hook logs

The project is intentionally filesystem-first so local multi-agent workflows remain inspectable and recoverable.

## Safety model

The codebase prioritizes:

- path safety around cleanup and worktree operations
- lock-based serialization for contended filesystem writes
- explicit stale-worker / stale-lease recovery
- best-effort process cleanup with escalation
- docs/tests that pin behavioral contracts
