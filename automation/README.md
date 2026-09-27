# GitHub coordination automation

This directory contains narrow, fail-closed automation for ChipIn GitHub coordination.

## DEV readiness

`dev-readiness.mjs` is the pure read-only policy evaluator for the future Project `→ DEV` automation. It does not call GitHub APIs or mutate state. Its fixture/unit tests run in the repository-local `DEV readiness policy tests` workflow.

`dev-readiness-live.mjs` is the read-only GitHub adapter for that evaluator. It reuses the metadata migration's `GitHubClient`, Project reader, Issue reader, and schema verification instead of defining a second metadata authority.

- Organization Issue Fields / Issue Types and Project #5 schema are verified before eligibility can be positive.
- canonical Priority, Release scope, and Issue Type are read from structured GitHub metadata only; labels, milestones, body URLs, and `References` are never fallbacks.
- native blocked-by, parent, and sub-issue relationships come from GitHub relationship APIs and are paginated by the shared client.
- Development-linked PRs come from GitHub's manual/native Development relationship, with complete GraphQL pagination; closing-keyword-only references are explicitly excluded.
- direct merges are checked against the repository integration branch; stacked merged PRs are accepted only when their merge SHA is reachable from that integration branch.
- unreadable relationships, duplicate Project membership, schema drift, unsupported canonical values, or incomplete integration evidence fail closed.
- the adapter contains no write path.

A live read-only audit accepts exact issue identities and emits timestamped JSON:

```sh
GITHUB_TOKEN=... node automation/dev-readiness-live.mjs \
  ChipIn-one/chipin-frontend#164 \
  ChipIn-one/chipin-backend#101 \
  --output /tmp/dev-readiness-live.json
```

The token needs read access to the organization Issue Fields / Issue Types, Project #5, Issues, native relationships, PRs, and compare data. No credential is stored in this repository.

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

The tests include the DEV-readiness fixtures, live-adapter normalization/contracts, migration safety/idempotency coverage, and a consistency check for all supported shared Issue Forms.
