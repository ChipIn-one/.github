# Issue create/finalize and reconciliation

Last reviewed: 2026-09-27

`issue-intake.mjs` completes ChipIn issue creation without guessing metadata. It supports the three canonical repositories only:

- `ChipIn-one/chipin-frontend`
- `ChipIn-one/chipin-backend`
- `ChipIn-one/chipin-knowledge-base`

It reuses the organization Issue Field / Issue Type IDs and schema verification from `metadata-migration.config.json` and `metadata-migration.mjs`. The historical fixed backend mapping from migration #117 is not used for new issues.

## Safety contract

Every run requires explicit `Issue Type`, `Priority`, `Release scope`, and Severity when applicable. `Bug` requires Severity. Missing classification returns an actionable incomplete receipt; there are no title/body/label/milestone defaults.

Existing canonical values are human-owned. If a requested value differs from an existing Issue Type or Issue Field value, the tool stops and refuses to overwrite it. Existing Project Status is also preserved. The only Status initialization is `Backlog`, and only when the issue has exactly one Project #5 item with no Status.

Project membership is read independently from metadata. Missing membership is added with `addProjectV2ItemById`; GitHub returns the existing item when the content is already present, making retry safe. Duplicate Project items are not deleted automatically: the run is incomplete and requires manual reconciliation because duplicate items can contain conflicting human Status values.

No native dependency, parent, sub-issue, label, milestone, assignee, body, or Development relationship is modified. Issue title/body content is treated only as untrusted API data and is never evaluated or executed as shell code. Final success requires read-back of the Issue Type, required Issue Fields, exactly one Project #5 membership, and a readable Status. The receipt also records the native relationships read back from the issue.

Apply mode is double-gated:

```text
--activate issue-intake-v1
CHIPIN_ISSUE_WRITE=1
```

## UI path: shared Issue Form -> manual finalizer

The organization Issue Forms continue to set only native Issue Type. Form-body dropdowns would be converted to Markdown and are therefore not canonical Issue Field values. The forms also deliberately do not use the top-level `projects:` key: GitHub requires the issue creator to have project write access, and that mechanism would not repair issues created through API/agents.

After creating an issue with the shared form, open `ChipIn-one/.github` -> Actions -> `Issue metadata finalizer` and provide the exact issue identity plus explicit canonical metadata. Run with `apply=false` first to inspect the read-only plan. `apply=true` uses the separately configured write credential and returns a receipt artifact.

This workflow is intentionally `workflow_dispatch` only. A workflow stored in the organization `.github` repository does not subscribe to issue events emitted by sibling FE/BE/KB repositories, so no misleading organization-wide event automation is claimed here.

## API / agent create path

Create mode uses GitHub's issue REST API with explicit `type` and `issue_field_values`, persists the returned issue identity before Project mutations, and then runs the same reconciliation/read-back path.

Example for a non-Bug task:

```sh
GITHUB_TOKEN=... CHIPIN_ISSUE_WRITE=1 \
node automation/issue-intake.mjs apply create ChipIn-one/chipin-frontend \
  --title "Short task title" \
  --body-file /tmp/issue-body.md \
  --type Task \
  --priority P2 \
  --release-scope POST-PROD \
  --severity none \
  --state /tmp/chipin-issue-create.json \
  --activate issue-intake-v1 \
  --output /tmp/chipin-issue-receipt.json
```

For a Bug, pass one of `Critical`, `Major`, or `Minor` as Severity.

`--state` is mandatory for `apply create`. Immediately after the REST create returns, the tool atomically stores `issueRef` and `issueUrl` before any later Project stage. Retrying the same command with the same state file resumes that issue rather than creating another one. Partial metadata or membership writes are safe to retry because each later stage is freshly read before mutation and the final state is read back again.

## Existing issue reconciliation

Read-only plan example:

```sh
GITHUB_TOKEN=... node automation/issue-intake.mjs plan reconcile \
  ChipIn-one/chipin-backend#145 \
  --type Bug \
  --priority P3 \
  --release-scope '<explicit operator choice>' \
  --severity Minor \
  --output /tmp/145-plan.json
```

Do not copy the placeholder literally. The operator must choose the missing Release scope after reviewing the issue.

Fresh REST reads on 2026-09-27 show:

| Issue | Canonical REST state observed | Reconciliation rule |
| --- | --- | --- |
| FE #279, #282, #283, #285, #287 | Issue Type missing; organization Issue Fields empty | choose Type/Priority/Release scope and applicable Severity explicitly; do not infer from title/body |
| BE #145 | `Bug`, `P3`, `Minor`; Release scope missing | preserve those existing human values and explicitly choose Release scope |
| KB #3, #4, #5 | Issue Type missing; organization Issue Fields empty | legacy `P*` / `type:*` labels are not canonical; choose all canonical values explicitly |

Project membership/Status for those named issues must be re-read by the tool with a Project-capable token immediately before any apply. No bulk mapping is supplied. Run one reviewed issue at a time. Legacy migration #117 remains closed and is not extended into a guessing engine.

## Credentials and activation

Read-only plans can reuse `CHIPIN_DEV_READ_TOKEN` if it can read organization Issue Fields/Issue Types, Project #5, issues, and native relationships.

Apply uses a separate `CHIPIN_ISSUE_WRITE_TOKEN`. Use the narrowest credential that can:

- read organization Issue Fields and Issue Types;
- write Issues in FE/BE/KB (needed for Issue Type / issue-field values and API creation);
- read/write ChipIn Project #5.

Do not store the credential in the repository. The workflow itself retains only `contents: read` permissions and receives the external token through the secret.

No repository secret, variable, Project workflow, or settings change is performed by this code change. Live acceptance remains pending until `CHIPIN_ISSUE_WRITE_TOKEN` is explicitly configured and an operator authorizes a test issue or named reconciliation.

## Validation

Repository gate:

```sh
node --test automation/*.test.mjs
```

Focused coverage includes explicit intake, missing Release scope, preservation of human values, Bug Severity requirements, missing/duplicate membership, retry after partial create, API permission failure, and read-back failure.
