# Compatibility

## Supported environments

### Core runtime

| Environment | Status | Notes |
| --- | --- | --- |
| macOS | ✅ | first-class dev environment |
| Linux | ✅ | expected to work for core leader/worker flows |
| Windows | ✅ | supported for core flows; prefer PowerShell for manual-worker setup |

## Shell / launcher support

| Workflow | macOS/Linux | Windows |
| --- | --- | --- |
| `/team env <name>` output | POSIX shell instructions | PowerShell instructions |
| local multi-window launcher | `scripts/start-tmux-team.sh` | `scripts/start-team-windows.ps1` |
| `.sh` hooks | ✅ | requires bash |
| `.ps1` hooks | optional (`pwsh`) | ✅ |

## Process model notes

- POSIX platforms use signal-based termination (`SIGTERM`/`SIGKILL`).
- Windows uses process-tree termination helpers for forceful cleanup.
- Hook execution supports `js`, `mjs`, `sh`, and `ps1` entrypoints.

## CI expectations

At minimum, typecheck, lint, and smoke test should stay green on the actively supported development path.
