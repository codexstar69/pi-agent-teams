# Governance

## Maintainer model

This project is currently maintainer-led.

Maintainers are responsible for:

- release decisions
- security triage
- roadmap direction
- issue / PR prioritization
- compatibility policy

## Decision making

Default model:

1. discuss in issue / PR
2. prefer reversible changes
3. prefer documented behavior over implicit behavior
4. maintainer makes the final merge / release decision

## Project priorities

Current priorities:

- runtime correctness
- safe filesystem/process behavior
- clear operator UX
- Windows/macOS/Linux usability
- docs that match shipped behavior

## Breaking changes

Breaking changes should include:

- explicit release notes
- migration notes
- README / docs updates
- tests covering the new contract
