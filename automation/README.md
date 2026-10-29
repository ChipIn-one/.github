# GitHub coordination automation

This directory contains narrow, fail-closed automation for ChipIn GitHub coordination.

## Workflow status model

Project #5 `Status` uses `Backlog`, `Todo`, `In Progress`, `Awaiting release`, and `Done`. `Awaiting release` is written only by the completion engine (`completion.mjs`, production-merge or deployment-receipt, `CHIPIN_COMPLETION_AWAITING_RELEASE=1`) for an open Issue whose linked PRs are merged into the integration branch but not yet released; it never closes anything. `Done` is accepted only as a derived mirror of an Issue already `closed/completed`; terminal completion authority remains native Issue closure. `DEV`/`PROD` stay retired. The retired DEV-readiness reader/writer workflows are not part of the active automation surface; PR merge state remains native GitHub evidence.

## Repository registry

`registry.mjs` loads and validates `../workflow-registry.yaml` (see [docs/workflow](../docs/workflow/README.md)): repository kind, owner, branches, protection and capabilities.
`development-link.mjs`, `create-milestone.mjs` and `pr-metadata.mjs` read repository allowlists, integration branches and owners from it; `registry.test.mjs` guards the admission and intake modules that still carry their own literals against drift.
Validate locally with `node automation/registry.mjs --validate`; `automation-tests` runs it on every pull request.

## Native relationships

`relationships.mjs` is the only writer of native Issue relationships (`blocked by`, `relates to`, parent/sub-issue). It parses `Blocked by:`, `Blocks:`, `Relates to:` and `Parent:` lines in `## Dependencies`, adds missing native edges (never removes, inverts or re-parents), mirrors native edges back into the body, reads every write back, and exposes the read-only blocker gate used by `readAdmission()` (`BLOCKED_BY_DEPENDENCY`). `reconcile` is run by `.github/workflows/relationships-reconcile.yml`; `declare` writes lines and edges for one Issue; `issue-intake.mjs apply create` accepts `--blocked-by/--blocks/--relates-to/--parent`. See [docs/workflow/relationships.md](../docs/workflow/relationships.md).

## Conformance audit

`conformance.mjs audit` compares every `workflow-registry.yaml` repository (integration branch) with its record: callers, pins against `ChipIn-one/.github` tags, Dependabot `github-actions`, routing block and `.ai/context.md`, protection and required checks, pull requests in Project #5, closed Issues with open PRs, merges past a red required check. `upsert` keeps one drift Issue per repository. Run weekly by `.github/workflows/conformance-audit.yml`; see [docs/workflow/conformance.md](../docs/workflow/conformance.md).

## Release

`release.mjs` turns "what merged since the previous tag" into a version, a tag and a GitHub Release for registry repositories with a release strategy (`plan` reads only; `apply` needs `--activate release-v1` and `CHIPIN_RELEASE_WRITE=1`). The version is the previous tag bumped by the maximum `## Version impact` of the included pull requests; a missing or invalid impact, a tag on another commit, a commit outside the release branch or a failed read-back blocks. `release-action/` wraps it for the reusable `.github/workflows/release.yml`; callers come from `templates/caller-release-*.yml`. See [docs/workflow/release.md](../docs/workflow/release.md).

## Completion

`completion.mjs` is the single completion engine: it reads the registry record, runs only when `capabilities.completion: automatic`, and picks the strategy from `completion`. `production-merge` (frontend) delegates unchanged to `frontend-production-completion.mjs`; `integration-merge` (`.github`, knowledge base) closes an Issue once every Development-linked same-repository PR (base and `headRepository`) is merged into `branches.integration` and its merge commit is still in that branch head. Both share the fail-closed gates (native Development link read from `closedByPullRequestsReferences`, merged PR evidence, no open blockers or incomplete sub-issues, no scope change after the last merge, stale-snapshot check); `integration-merge` additionally fails closed when `sub_issues_summary.total` does not match the listed sub-issues and counts any reopen after the last merge as a scope change. `deployment-receipt` (.github#212) runs every `integration-merge` gate and then requires each linked PR's merge commit to be contained in a valid production receipt: a GitHub Deployment of the registry `productionEvidence` environment and creator, newest status `success`, SHA on the integration branch; merged but not yet received gives `awaiting-production`. The only mutation is `state=closed`, `state_reason=completed`. `manual` does not run (an org sweep with `CHIPIN_COMPLETION_SKIP_MANUAL=1` gets a green `skipped` receipt instead). The frontend record (`deployment-receipt` on canonical `master` since .github#216) is `automatic` with `completionRunner: org-sweep` since .github#217: no FE caller, the org sweep is its only runner; `production-merge` and `frontend-production-completion.mjs` stay for the dev/main rollback record only. Writes need `CHIPIN_COMPLETION_WRITE=1`; `CHIPIN_COMPLETION_PROJECT_RECONCILE=0` keeps repository-local runs away from Project #5; `CHIPIN_COMPLETION_AWAITING_RELEASE=1` (production-merge or deployment-receipt with Project reconciliation on) moves `Todo`/`In Progress` to `Awaiting release` for `awaiting-production` Issues, used by the org workflow `.github/workflows/frontend-production-completion.yml`, which runs `completion.mjs --repository ChipIn-one/chipin-frontend`. `completion-action/` wraps it for repository-local callers (`templates/caller-completion-integration.yml`, knowledge base, repository token: blockers in other private repositories are invisible to it; `templates/caller-completion-deployment-receipt.yml`, `deployment_status` + push, input `awaiting-release: "true"` with an org token that writes Project #5); `.github` runs it through `.github/workflows/integration-completion.yml` with the org write PAT `CHIPIN_ISSUE_WRITE_TOKEN` (as `CHIPIN_CANONICAL_WRITE_TOKEN`, workflow `permissions: contents: read`, Project #5 repair on). GitHub's native "Auto-close issues with merged linked pull requests" must be disabled by the owner in every `integration-merge` repository, otherwise GitHub closes linked Issues on merge without these gates. The `.github` development-link caller lands with the org pin bump after the first tag containing #179. See [docs/workflow/completion.md](../docs/workflow/completion.md).

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
- This path never closes/reopens an Issue, writes `Done`, or implements production completion from #40.
  Its only Project #5 write is the opt-in `In Progress` writer (.github#218, action input
  `set-in-progress`, default off, with `project-status-token`): after the link is read back it moves the
  open Issue's Status `Backlog`/`Todo` to `In Progress` (not for draft or Dependabot PRs), leaves every other
  value, and never fails the link: deterministic faults (write path, Project access, configuration) exit 1
  after the link, anything transient or drifted is a warning. See [docs/workflow/completion.md](../docs/workflow/completion.md#in-progress-at-development-link).

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

## Repository-local milestone creation

`create-milestone.mjs` is a shared repository-scoped control-Issue reconciler exposed by
`automation/create-milestone-action/action.yml`.
The allowlist contains **FE and BE only**; KB remains specification/documentation
and does not receive a product-release milestone caller. The FE and BE callers each
grant only `contents: read` and `issues: write`, and pass the local `GITHUB_TOKEN`;
no shared PAT, webhook, Project API, or alternate release metadata is needed.

Control Issues use `[create-milestone] <title>` and mandatory `Description:`
with optional `Due date: YYYY-MM-DD`. Both the original Issue author and
the triggering GitHub actor must have write/maintain/admin permission.
Ordinary Issues are ignored. Closed and open
milestones both participate in deduplication, and existing release objects are
never reopened or changed. Callers serialize competing requests through
`concurrency.queue: max`, and the reconciler re-reads conflicts and writes an
updatable bot receipt with milestone URL and number. Errors leave the Issue open.

Each repository must merge its caller workflow to its own **default branch**
before an Issue event can invoke it. See
[create-milestone-action/README.md](./create-milestone-action/README.md) and
`create-milestone.test.mjs`. A live canary is independent of Project #5
membership reconciliation and Release-scope retirement.

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

## Project #5 items reads (#221)

Every Project #5 items reader (`readProjectSnapshot` in `github-metadata.mjs`, used by completion,
intake, admission and the metadata migration; the conformance PR scan) goes through
`readProjectItemsPage`:

- GitHub intermittently answers a Project items page, first page or cursor page alike, with HTTP
  200, no `errors`, and a phantom empty connection (`totalCount: 0`, `hasNextPage: false`, no
  nodes). Such a page is re-read with the delays `PROJECT_PAGE_RETRY_DELAYS_MS`
  (100, 250, 500, 1000, 2000, 4000 ms).
- A page still phantom after every retry fails with `PROJECT_ITEMS_PHANTOM`; it never becomes a
  short read or an empty Project. Only a caller passing `allowEmptyProject: true` accepts an empty
  first page, and no production caller does.
- One whole read (all pages, phantom re-reads and growth re-reads) has a budget of
  `PROJECT_READ_DEADLINE_MS` = 60 s; exceeding it fails with `PROJECT_READ_DEADLINE`.
- The completeness (`read N of totalCount`), Project identity and growth re-read checks still apply.

## Tests

```sh
node --test automation/*.test.mjs
```

The tests include issue-intake retry and fail-closed coverage, migration safety/idempotency coverage, and a consistency check for all supported shared Issue Forms.


## Fail-closed Issue admission

Versioned read-only `issue-admission.mjs` validates a fresh exact Issue revision, durable body, native Type/Priority/Bug Severity, the required assignee from the registry record (explicit `--owner` where the record has `owner: null`), exactly one Project #5 item and readable Status. Writers remain exclusively in `issue-intake.mjs`. The `issue-admission-pr.mjs` boundary and `issue-admission-action/action.yml` guard PR reconciliation, publication handoff and review where callers opt in with an org read credential. A queued connector bridge is not a positive admission. See [issue-intake.md](./issue-intake.md) for roll-out; the admission scope (including `.github`) and the required owner per repository come from the registry (#183).

### Issue-based trusted preflight (#119)

Use `node automation/issue-admission-preflight.mjs --issue ChipIn-one/chipin-frontend#153` before any PR exists. It preserves canonical `readAdmission()` and uses explicit approved `GITHUB_TOKEN`, otherwise the existing authenticated `gh api` session (including GraphQL pagination); it never extracts tokens. KB uses `--owner <login>`. Only read-only REST GET/GraphQL query is allowed. Policy/auth failures do not become a metadata bypass.

Connector-only continuation is provided by the dedicated trusted `.github/workflows/issue-admission-preflight.yml` producer and `issue-admission-consumer.mjs`. A separately authorized trusted orchestrator dispatches `chipin-admission-preflight-v1`, with issue/request-id/optional revision using its own pre-existing GitHub dispatch authority; this is not an Executor action. GitHub authenticates the principal, the workflow checks `vars.CHIPIN_TRUSTED_PREFLIGHT_ACTOR`, runs only pinned trusted `master` code with `CHIPIN_DEV_READ_TOKEN`, and uploads a run-attempt-bound artifact. The consumer obtains the authenticated run and artifact IDs from that orchestrator, re-reads trusted branch, exact reader/config, run and artifact through approved GitHub reads, downloads ZIP bytes through the GitHub artifact interface and verifies hashes, issue/revision, source, actor, attempt, original freshness and durable single-use request correlation. First read may bind full revision only explicitly; later boundaries must provide their previously pinned revision and produce new evidence. No receipt is renewed by retimestamping; queue/upload/download must fit 120 seconds.

This repository owns canonical reader/producer/verifier. Generic role/handoff routing belongs to `syllik/ai-workflow`, with a separately prepared target context. Existing BE/KB workspace access remains read-only. The connector/orchestrator integration and live recheck must be proven before #119 can close; isolated tests are not proof of deployed delivery.
