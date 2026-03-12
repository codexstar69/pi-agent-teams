# Changelog

All notable changes to this project should be documented in this file.

## Unreleased

- fixed the worker integration harness so spawned test teammates can use an explicit test model instead of silently falling back to the global default model
- fixed the RPC ready-handshake integration test to load the teams extension and match the production spawn path
- verified teammate execution against inherited custom models (including provider-prefixed custom model ids)

## 0.4.1

- merged the hardened branch into `main`
- published the package under the `@codexstar` npm scope
- added enterprise-grade repository polish (community health, governance, support, AI discovery files)
- added a polished triptych README hero banner for the GitHub landing surface

## 0.4.0

- stabilized leader/worker lifecycle behavior
- added stronger task, lease, and event-log hardening
- added Windows-friendly `/team env` output
- added PowerShell launcher script
- added PowerShell hook support
- improved cross-platform process termination handling
- polished repo metadata and package publishing under `@codexstar/pi-agent-teams`
