# GitHub coordination automation

This directory contains narrow, fail-closed automation for ChipIn GitHub coordination.

## Workflow status model

Project #5 `Status` uses `Backlog`, `Todo`, `In Progress`, and `Done`. `Done` is accepted only as a derived mirror of an Issue already `closed/completed`; terminal completion authority remains native Issue closure. `DEV`/`PROD` stay retired. The retired DEV-readiness reader/writer workflows are not part of the active automation surface; PR merge state remains native GitHub evidence.

## Issue intake

`issue-intake.mjs` provides one bounded create/finalize and reconcile path for new ChipIn issues. It reuses active schema IDs and shared Project/Issue readers from `github-metadata.mjs`; migration #117 is historical only.

- `plan reconcile` reads one existing issue and reports exactly what is missing.
- `apply reconcile` writes only missing requested values, ensures one Project #5 membership, initializes `Backlog` only when Status is absent, and reads everything back.
- `plan create` validates explicit Issue Type/Priority/applicable Severity without creating anything; Milestone is optional and is never inferred or mutated by intake.
- `apply create` creates with explicit Issue Type / issue-field values, persists the returned issue identity before Project writes, then runs the same reconciliation and read-back path.
- conflicting existing human values, duplicate membership, permission failures, schema drift, or unreadable read-back produce an incomplete result rather than overwrite/guess/success.
- apply mode requires both `--activate issue-intake-v1` and `CHIPIN_ISSUE_WRITE=1`.

The UI entry point is the manual `.github/workflows/issue-metadata-finalize.yml` workflow. It runs the full automation test suite before plan/apply. Read-only plans can use `CHIPIN_DEV_READ_TOKEN`; writes require the separate `CHIPIN_ISSUE_WRITE_TOKEN`.

For API clients/connectors that can create normal Issues but cannot mutate Issue Fields / Issue Type / Projects v2, `.github/workflows/issue-intake-connector-bridge.yml` accepts a narrowly formatted control issue in this repository. `issue-intake-request.mjs` validates the trusted author/trigger actor, exact target, request schema, and canonical classification, persists a durable normalized queue snapshot, then a repository-wide serialized drain invokes the same existing `issue-intake.mjs apply reconcile` path. The manual UI finalizer uses this same queue for apply operations. Pending drain replacement cannot lose a request because queue state exists before concurrency admission. The bridge never implements a second metadata writer.

See [issue-intake.md](./issue-intake.md) for CLI examples, connector request format, retry semantics, the named-gap reconciliation plan, and the live activation procedure.

## Historical metadata migration

`metadata-migration.mjs` implements the completed task #6 / backend #117 migration as historical, auditable evidence. Active intake imports `github-metadata.mjs` directly; the historical mapping is not canonical schema.

- Active Organization Issue Field IDs (Priority/Severity) and Issue Type IDs are pinned in `metadata-migration.config.json`. The retired Release scope definition and old backend mapping live only under `historicalMigration` so the old run can be reproduced without making that field active authority.
- Shared schema verification checks only active fields. Historical migration adapts its explicitly historical configuration before reproducing old #117 checks.
- Issue Type, Project membership, native dependencies/parent/sub-issues, and Project Status are read independently.
- canonical writes are re-read before any legacy cleanup.
- inaccessible or inconsistent structured state fails closed.
- `apply` requires both `--activate issue-117` and `CHIPIN_METADATA_APPLY=1`; CI never supplies either.
- a state file checkpoints completed issues for resumable operator runs.

See [metadata-migration.md](./metadata-migration.md) for the prepared diff, permissions, and activation procedure.

## Tests

```sh
node --test automation/*.test.mjs
```

The tests include issue-intake retry and fail-closed coverage, migration safety/idempotency coverage, and a consistency check for all supported shared Issue Forms.
