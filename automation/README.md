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

## Native Development linking

`development-link.mjs` is the shared fail-closed reconciler for implementation PRs in
`ChipIn-one/chipin-frontend`, `ChipIn-one/chipin-backend`, and
`ChipIn-one/chipin-knowledge-base`.

- The task identity is the existing canonical `ChipIn-one/<repository>#<issue-number>` value.
  Automatic PR-event reconciliation reads it only from one exact PR-body line,
  `Task identity: ChipIn-one/<repository>#<issue-number>`. Manual reconciliation may pass the
  same canonical identity as an explicit workflow input. The marker/input is identity transport
  only; it is never implementation evidence.
- Plain URLs, closing keywords, branch names, PR titles, matching numbers, Milestones, and other
  prose are never identity fallbacks.
- The only write is GitHub GraphQL `addCloseIssueReferences(issueId, pullRequestIds)`. Before a
  write, and again after it, the reconciler reads
  `closedByPullRequestsReferences(includeClosedPrs: true, userLinkedOnly: true)` with complete
  pagination. Success is impossible without exact native read-back.
- An already linked PR is an idempotent success. More than one implementation PR may link to the
  same Issue, and unrelated existing links are preserved.
- Missing/ambiguous identity, unsupported repositories, unreadable Issue/PR/relationship state,
  unavailable mutation permission/capability, incomplete pagination, and failed read-back all
  block without guessing.
- This path never closes/reopens an Issue, mutates Project #5 Status, writes `Done`, or implements
  production completion from #40.

The composite action at `automation/development-link-action/action.yml` packages this reconciler
for minimal repository-local PR-event callers. Organization `.github` workflows are not inherited
by sibling repositories, so FE/BE/KB each need a small caller on their canonical integration branch.
Those callers use normal `pull_request` metadata events, never check out or execute PR code, and
automatically reconcile only same-repository PR heads; fork PRs therefore have no write path. The
caller file ignores a PR that changes only that same caller path so its initial bootstrap does not
self-block before any local task identity exists; manual reconciliation remains available. The caller
grants `issues: write`, `pull-requests: read`, and `contents: read`; missing task identity or any
native mutation/read-back problem still fails eligible same-repository reconciliation instead of
substituting a textual link.

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

The tests include issue-intake retry and fail-closed coverage, migration safety/idempotency coverage, and a consistency check for all supported shared Issue Forms.
