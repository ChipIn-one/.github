# GitHub coordination automation

This directory contains narrow, fail-closed automation for ChipIn GitHub coordination.

## DEV readiness

`dev-readiness.mjs` is the pure read-only policy evaluator for the future Project `→ DEV` automation. It does not call GitHub APIs or mutate state. Its fixture/unit tests run in the repository-local `DEV readiness policy tests` workflow.

## Metadata migration

`metadata-migration.mjs` implements task #6 / backend #117 as an auditable, resumable `plan` / `apply` migration.

- Organization Issue Field IDs and Issue Type IDs are pinned in `metadata-migration.config.json` and verified from live organization metadata before apply.
- Project #5 Priority/Severity/Release scope fields must prove their `issueField.fullDatabaseId` relationship to those organization fields; display names or empty Project option arrays are never treated as authority.
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

The tests include the existing DEV-readiness fixtures, migration safety/idempotency coverage, and a consistency check for all supported shared Issue Forms.
