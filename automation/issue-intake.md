# Canonical issue intake

This tooling completes or reconciles canonical ChipIn issue metadata for every repository of `workflow-registry.yaml` whose `admission` capability is not `off` (#183), today:

- `ChipIn-one/chipin-frontend` (owner `syllik`)
- `ChipIn-one/chipin-backend` (owner `olegbal`)
- `ChipIn-one/chipin-knowledge-base` (explicit `--owner`)
- `ChipIn-one/.github` (owner `syllik`)

Active schema configuration is in `metadata-migration.config.json`; shared GitHub transport/schema/readers are in `github-metadata.mjs`. The old backend #117 mapping is retained only under `historicalMigration`.

## Safety contract

Every run requires explicit Issue Type and Priority, plus Severity when applicable. `Bug` requires Severity. There is no Release-scope input.

Native Milestone is optional. Missing milestone is valid and means “not scheduled for a concrete release”. Intake never infers, writes, clears, or renames Milestones.

Existing canonical values are human-owned. If requested Issue Type/Priority/Severity conflicts with an existing value, reconciliation stops rather than overwriting it. Existing Project Status is also preserved. Project Status values are `Backlog`, `Todo`, `In Progress`, `Awaiting release` (written only by the completion engine), and `Done`; `Done` is valid only when the Issue is already `closed/completed` and is never completion authority. `DEV`/`PROD` are retired. The initial Status (`Backlog`, or `Todo` with `apply create --status Todo`) is initialized only when the issue has exactly one Project #5 item with no Status. Intake never writes `In Progress` (the development-link reconciler does, .github#218), `Awaiting release` or `Done`. Intake never closes or reopens an Issue.

Project membership is read independently. Missing membership may be added by the guarded writer; duplicate membership is fail-closed and requires manual reconciliation. Native dependency, parent/sub-issue, Milestone, assignee, body, labels, and Development relationships are not modified.

Final success requires read-back of Issue Type, required Issue Fields, exactly one Project #5 membership, readable Status, preserved Milestone, and native relationships.

Apply mode is double-gated:

```text
--activate issue-intake-v1
CHIPIN_ISSUE_WRITE=1
```

## UI path: shared Issue Form -> manual finalizer

After creating an issue with a shared form, run `ChipIn-one/.github -> Actions -> Issue metadata finalizer`.

Provide exact issue identity, Issue Type, Priority, applicable Severity, and `apply=false` first. For KB Issues, choose an explicit native GitHub login in the workflow `owner` input for both plan and apply. FE/BE use their required owner policies; leaving KB owner blank fails closed. No release target is required. Existing Milestone state is left untouched.

The workflow is intentionally `workflow_dispatch` only. Organization-profile workflows do not subscribe to sibling-repository issue events.

## Connector bridge

A connector that can create an ordinary issue but cannot complete Issue Fields/Issue Type/Project #5 uses one control issue in `ChipIn-one/.github`.

Title:

```text
[issue-intake] ChipIn-one/<repository>#<number>
```

Body:

```markdown
<!-- chipin-issue-intake-request:v1
{"target":"ChipIn-one/chipin-frontend#308","issueType":"Feature","priority":"P2","severity":"none"}
-->
```

Rules:

- `target` is the exact existing issue identity in a registry repository with admission on (FE/BE/KB/`.github`), canonical spelling;
- `issueType`, `priority`, and applicable `severity` are explicit;
- `"severity":"none"` is used when not applicable;
- retired `releaseScope` is rejected as an unsupported request key;
- Bug requires `Critical`, `Major`, or `Minor`;
- title and payload target must match;
- trusted actor/trigger checks, unsupported repositories, malformed/duplicate markers, extra keys, and conflicting human values fail closed.

Validated requests are durably queued before the shared serialized drain. Manual finalizer and connector bridge use the same `canonical-issue-intake-writes` concurrency group and the same guarded intake implementation.

Result comments include canonical read-back for Issue Type, Priority, Severity, native Milestone, Project #5 membership and Status. Milestone is release targeting only; it is not workflow or completion authority.

### Read-back lag, pending retry and the manual requeue path (#182)

On 2026-10-20 seven requests ended BLOCKED although every write succeeded: the Project #5 items listing showed the new membership only after more than a minute (six cases), and in one case the item set grew while the pages were read (`read 191 of 190`). Both are consistency races of the read-back, handled as follows:

- `readProjectSnapshot` re-reads the Project from the first page (up to two more times) when `items.length > totalCount`; `items.length < totalCount` still fails.
- Before adding a membership the writer reads the Issue's own `projectItems`; an item already visible there is never added again (`project-membership:already-present`), two items are a duplicate and block.
- The initial Status (`Backlog`, or `Todo` from `apply create --status Todo`) is initialised right after the add on the item id the mutation returned (or on the item the Issue side already shows, when its Status is absent), so a lagging listing cannot turn the Status step into a blocker.
- The membership wait is a time budget (4 minutes, 2 s between full Project reads, hard cap 120 reads). If the listing has still not caught up, the writer returns `action: pending-readback` with `pending.code = PROJECT_MEMBERSHIP_READBACK_PENDING` (or `PROJECT_STATUS_READBACK_PENDING` when the item is visible but its freshly set Status is not) and no blockers (exit 2 for the CLI). It is a distinct, retryable state: the bridge/finalizer post a **PENDING** result comment, the control Issue stays open, the drain summary outcome is `pending` (exit 0, not `attention-required`), and `.github/workflows/issue-intake-drain-retry.yml` re-runs the drain for open control Issues every 30 minutes with the same `canonical-issue-intake-writes` concurrency group. The retry runs the same idempotent reconcile: metadata and assignee are already canonical, the add is skipped once the membership is visible, Status is initialised only when absent, and the control Issue is closed after `INTAKE_COMPLETE`.
- Cost: each full Project read is two GraphQL pages today (about 250 items), so one lagging request spends roughly 120–240 GraphQL points per drain run on the shared write token; several lagging requests in one run stay well under the 5 000 points/hour limit but are visible in the rate-limit budget.
- On a pending early return the relationships step of `apply create` (`--blocked-by` and friends) has not run yet; the create checkpoint keeps the Issue identity, so the retry resumes the same create and declares the relationships once the Project read-back is complete.
- A request that is still pending after `MAX_PENDING_RETRIES` (6) PENDING results, about three hours, is reported **BLOCKED** ("Read-back still pending after N retries") and its control Issue is closed, so a permanent divergence reaches a human instead of looping. Drain job timeouts are 30 minutes because one lagging request can wait up to 4 minutes.
- Manual requeue (still valid for a genuinely BLOCKED request): edit or reopen the control Issue; the bridge re-validates and enqueues a fresh request snapshot. A PENDING request needs no manual action; editing it only adds a second queue entry for the same target, which the drain processes in order. Closing a PENDING control Issue by hand does not cancel it: the scheduled drain (`--state open`) skips it, but the next event-driven drain (`--state all`) processes and closes it.

## API / agent create path

Example:

```sh
GITHUB_TOKEN=... CHIPIN_ISSUE_WRITE=1 \
node automation/issue-intake.mjs apply create ChipIn-one/chipin-frontend \
  --title "Short task title" \
  --body-file /tmp/issue-body.md \
  --type Task \
  --priority P2 \
  --severity none \
  --status Backlog \
  --state /tmp/issue-create-state.json \
  --activate issue-intake-v1 \
  --output /tmp/issue-intake.json
```

### Initial Status: `--status Backlog|Todo` (#218)

`apply create` (and `plan create`) accepts `--status Backlog` (the default) or `--status Todo`; any other value, and `--status` with `reconcile`, is rejected before any GitHub read.

- `Backlog` is for new work: it waits for owner triage.
- `Todo` is only for an Issue inside a scope the owner already approved, for example a sub-task of an approved plan or decomposition. It is not a priority signal and does not replace admission.
- The Status is written once, on the new item, and only when the item has no Status; a Status already visible on the item (human-set) is preserved as it is.
- The result carries `initialStatus` and `initialStatusApplied` (`true` when this run wrote it, then `applied` also names `status:<value>`); when a requested Status was not written because the item already had another one, `initialStatusNote` says so. The receipt's `project.status` is the read-back. When this run wrote the Status and the final read-back shows another value, the receipt is `BLOCKED`.
- The create checkpoint (`--state`) records `initialStatus`; a retry with a different `--status` fails closed.
- The UI finalizer, the connector bridge and the drain run `reconcile`, so they keep `Backlog`; they do not accept a Status input.

Read-only reconcile example:

```sh
GITHUB_TOKEN=... node automation/issue-intake.mjs plan reconcile \
  ChipIn-one/chipin-backend#145 \
  --type Bug \
  --priority P3 \
  --severity Minor \
  --output /tmp/145-plan.json
```

Existing human values are preserved. Fresh Project membership/Status must be read before apply. Do not bulk-classify or infer missing values from title/body/labels/Milestone.

## Credentials and activation

Apply uses `CHIPIN_ISSUE_WRITE_TOKEN` with the narrowest permissions that can:

- read active Organization Issue Fields and Issue Types;
- write issue metadata in the approved target repository;
- read/write ChipIn Project #5.

No credential is stored in the repository. Live writes require explicit operator approval and an approved target.

## Tests

```sh
node --test automation/*.test.mjs
```

Coverage includes explicit intake, optional Milestone behavior, rejection of retired Release-scope bridge payloads, preservation of human values, Bug Severity requirements, missing/duplicate Project membership, retry safety, permission failure, and read-back failure.

## Admission v1 and agent entrypoints

The sole canonical create/reconcile writer remains `issue-intake.mjs`. It now validates a substantive title/body, actual assignees (from the registry: FE and `.github` `syllik`, BE `olegbal`, KB explicitly supplied `--owner <login>`), Type/Priority/applicable Severity, Project #5 membership/Status and full native read-back before an `INTAKE_COMPLETE` receipt. Other native human assignees and Milestones are never cleared. Reads fail closed, and a writer checkpoint with unknown issue identity cannot be retried as a new create.

`apply create` also accepts repeatable `--blocked-by`, `--blocks`, `--relates-to` and `--parent` (`owner/repo#number`). The declaration lines are added to `## Dependencies` of the created body and the native edges are written after the Issue is created, with read-back; any relationship blocker makes the receipt `incomplete`. `reconcile` rejects these flags: it never edits bodies (use `relationships.mjs declare`). See [docs/workflow/relationships.md](../docs/workflow/relationships.md).

Read-only preflight (run again immediately before each execution/publication/handoff, not from a stored cache):

```sh
GITHUB_TOKEN=... node automation/issue-admission.mjs --issue ChipIn-one/chipin-frontend#123 --output /tmp/intake-readback.json
# KB additionally requires --owner <explicitly-selected-login>
```

On positive read-back the JSON has `contractVersion: chipin-issue-admission/v1`, `status: INTAKE_COMPLETE`, exact `issue`, `revision`, `checkedAt`, `issueUpdatedAt`, native `assignees`, `requiredAssignee`, Issue Type/fields and Project item/Status. A receipt is valid for no more than 120 seconds; after a revision change it is stale even inside the window. Use `--expected-revision` to ensure a pinned task revision remains current. For implementation PR and FE release PR use `issue-admission-pr.mjs` or the shared composite action: it resolves the single exact Task identity (or a release's explicit Included Issues list) before verifying each Issue. Native Development relationship is separate evidence. Never treat a completed intake as human execution approval.

The connector uses the existing `[issue-intake]` control issue; the request accepts optional `owner` (mandatory for KB), e.g. `{"target":"ChipIn-one/chipin-knowledge-base#32","issueType":"Task","priority":"P2","severity":"none","owner":"approved-login"}`. FE/BE owner is repository policy. `QUEUED` is **not** a completed receipt: only a subsequent canonical result comment with an `INTAKE_COMPLETE` admission payload can unblock work. The GitHub connector can still create an ordinary raw Issue directly; its tool cannot be intercepted by an org repository workflow. Agents must enforce the stop before continuing and must not report successful canonical creation until read-back. Permissions are required for organization Issue Fields and Project #5; missing credential/visibility blocks, without fallback. Manual Issue Forms require finalizer and the same read-back before execution.

Admission and intake scope is the registry (`workflow-registry.yaml`, #183): every repository whose `admission` capability is not `off`, with the required owner from its record (`owner: null` = explicit `--owner`). `ChipIn-one/.github` tasks are therefore admitted like FE/BE/KB (owner `syllik`); `chipin-notifications` (admission off) and unregistered repositories are rejected with `Unsupported admission repository`. The former `#53`-only governance bootstrap is retired. Milestone control issue commands in `create-milestone.mjs` remain narrow to FE/BE releases; they cannot authorize any LLM execution.

## Admission routing repair (#119) — execution, not metadata intake

The canonical read-only entry for task execution is now `automation/issue-admission-preflight.mjs --issue <exact Issue in a registry repository with admission on>`; `--owner <login>` remains mandatory for KB. It invokes the unchanged `readAdmission()` and `chipin-issue-admission/v1`. Missing shell `GITHUB_TOKEN` does not stop discovery: an authorized existing `gh api` session can perform the complete native Issue, org Issue Fields/Types and Project GraphQL reads without token extraction. Never substitute ordinary Issue GET, queued intake, Project Status alone, or a borrowed credential. Do not repair metadata from preflight.

A connector-only Executor may consume only fresh Actions evidence from the trusted preflight producer workflow, dispatched by a separate authorized orchestrator, with original timestamp <120 seconds, exact full revision, authenticated run/ref/SHA/actor/attempt/artifact digest, verified reader/config and single-use request identity. Reproduce a new read at each controlled boundary and compare the full revision even when Issue `updated_at` is unchanged. The consumer may bind initial revision only after trusted evidence verification; later checks require the pinned previous revision. Replay registry and trusted dispatch are orchestrator responsibilities; Executor cannot dispatch privileged Actions or create control Issues. `issue-intake.mjs` remains the sole canonical writer.
