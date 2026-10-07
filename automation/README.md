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

## Issue intake

`issue-intake.mjs` provides one bounded create/finalize and reconcile path for new ChipIn issues. It reuses the canonical schema IDs and project readers from the metadata migration but never uses migration #117's fixed issue mapping as a classifier.

- `plan reconcile` reads one existing issue and reports exactly what is missing.
- `apply reconcile` writes only missing requested values, ensures one Project #5 membership, initializes `Backlog` only when Status is absent, and reads everything back.
- `plan create` validates explicit classification without creating anything.
- `apply create` creates with explicit Issue Type / issue-field values, persists the returned issue identity before Project writes, then runs the same reconciliation and read-back path.
- conflicting existing human values, duplicate membership, permission failures, schema drift, or unreadable read-back produce an incomplete result rather than overwrite/guess/success.
- apply mode requires both `--activate issue-intake-v1` and `CHIPIN_ISSUE_WRITE=1`.

The UI entry point is the manual `.github/workflows/issue-metadata-finalize.yml` workflow. It runs the full automation test suite before plan/apply. Read-only plans can use `CHIPIN_DEV_READ_TOKEN`; writes require the separate `CHIPIN_ISSUE_WRITE_TOKEN`.

For API clients/connectors that can create normal Issues but cannot mutate Issue Fields / Issue Type / Projects v2, `.github/workflows/issue-intake-connector-bridge.yml` accepts a narrowly formatted control issue in this repository. `issue-intake-request.mjs` validates the trusted author/trigger actor, exact target, request schema, and canonical classification, persists a durable normalized queue snapshot, then a repository-wide serialized drain invokes the same existing `issue-intake.mjs apply reconcile` path. The manual UI finalizer uses this same queue for apply operations. Pending drain replacement cannot lose a request because queue state exists before concurrency admission. The bridge never implements a second metadata writer.

See [issue-intake.md](./issue-intake.md) for CLI examples, connector request format, retry semantics, the named-gap reconciliation plan, and the live activation procedure.

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

## Knowledge-base documentation validation

`.github/workflows/kb-docs-validation.yml` is the trusted external host for the existing
`ChipIn-one/chipin-knowledge-base/infra/check-docs.py` validator. It does not copy or reimplement
validator logic.

- the workflow resolves `chipin-knowledge-base@master` to an immutable SHA with the existing
  `CHIPIN_DEV_READ_TOKEN`, then checks out that exact revision with persisted credentials disabled;
- Python 3.13 installs the KB-pinned `infra/requirements-docs.txt`, then runs both validator
  `--self-test` and the full `--base master` check;
- an artifact receipt records target/check-out SHA, validator and dependency blob SHAs, runtime
  versions, both check outcomes, and an overall complete/incomplete result;
- missing credentials, unresolved/mismatched provenance, dependency setup failure, or either
  validator failure fail closed;
- the host runs on this repository's PRs and pushes, on a daily schedule, and by manual dispatch.

This is an external current-master validation host, not a cross-repository PR status check. Native
GitHub Actions events cannot attach this repository's job as a required check to a private KB pull
request without separate cross-repository check-run/dispatch infrastructure.

## Tests

```sh
node --test automation/*.test.mjs
```

The tests include DEV-readiness fixtures, live-adapter normalization/contracts, issue-intake retry and fail-closed coverage, migration safety/idempotency coverage, and a consistency check for all supported shared Issue Forms.
