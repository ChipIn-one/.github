# DEV readiness dry-run

This directory contains the pure, read-only decision logic for the future ChipIn Project `→ DEV` automation.

It does not call GitHub APIs and cannot mutate issues, Projects, fields, statuses, PRs, or relationships. The manual workflow only checks the evaluator against fixtures.

## States

- `READY_FOR_DEV` — deterministic delivery requirements are integrated.
- `NOT_READY` — readable state shows required work is incomplete.
- `BLOCKED_UNKNOWN` — required structured state is missing, unreadable, ambiguous, or unsupported.
- `INCONSISTENT` — an item already at `DEV` no longer satisfies DEV readiness and needs human review.

## Integration branches

- frontend: `dev`
- backend: `develop`
- knowledge base: `main`

Deployment and informational `References` never gate `DEV`. `PROD`, `Done`, and parent closure are outside this evaluator and remain manual in v1.

## Why not Boardly

Boardly was reviewed before implementing this evaluator. It provides GitHub Projects v2 dry-run and sub-issue gating, but its built-in model does not express ChipIn's required Development-linked PR integration checks against repository-specific integration branches or the post-DEV inconsistency rule. Reusing it would require a larger customization layer than this isolated pure evaluator.

## Run

```sh
node --test automation/*.test.mjs
```
