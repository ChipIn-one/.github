# DEV readiness policy evaluator

This directory contains the pure, read-only decision logic for the future ChipIn Project `→ DEV` automation.

This PR is the policy layer only. It does not call GitHub APIs and cannot mutate issues, Projects, fields, statuses, PRs, or relationships. A later read-only adapter will feed real GitHub issue/PR/Project state into this evaluator before any live mutation is considered.

## States

- `READY_FOR_DEV` — deterministic delivery requirements are integrated and the current Project status is still before `DEV`.
- `NOT_READY` — no DEV transition should happen now; required work may be incomplete, the task may be manual/non-code, or the item may already be at a terminal/integrated status.
- `BLOCKED_UNKNOWN` — required structured state is missing, unreadable, ambiguous, or unsupported.
- `INCONSISTENT` — an item already at `DEV` or `PROD` no longer satisfies DEV readiness and needs human review.

## Integration branches

- frontend: `dev`
- backend: `develop`
- knowledge base: `main`

A blocking issue is considered satisfied for DEV readiness when the blocker itself is closed or its readable Project status is `DEV`, `PROD`, or `Done`. An unresolved/open blocker without an integrated Project status still blocks.

Deployment and informational `References` never gate `DEV`. `PROD`, `Done`, and parent closure remain manual in v1, and the evaluator never proposes a transition back from those statuses.

## Why not Boardly

Boardly was reviewed before implementing this evaluator. It provides GitHub Projects v2 dry-run and sub-issue gating, but its built-in model does not express ChipIn's required Development-linked PR integration checks against repository-specific integration branches or the post-DEV inconsistency rule. Reusing it would require a larger customization layer than this isolated pure evaluator.

## Tests

The GitHub Actions workflow runs on pull requests that touch `automation/**` or the workflow itself, and can also be started manually. It has only `contents: read` permission.

```sh
node --test automation/*.test.mjs
```
