# ChipIn-one/.github

Organisation-wide defaults and GitHub coordination tooling for `ChipIn-one`.

| Path | Purpose |
| --- | --- |
| `.github/ISSUE_TEMPLATE/` | shared Issue Forms: bug, enhancement, docs, tests, research |
| `.github/workflows/issue-metadata-finalize.yml` | manual UI finalizer for canonical issue metadata and Project #5 membership/Status |
| `github-issue-schema.md` | canonical task metadata model |
| `automation/` | fail-closed coordination, issue-intake, and metadata migration tooling |

## Shared templates and repository overrides

Supported Issue Forms are owned here and set only native GitHub Issue Type: `Bug`, `Feature`, or `Task`. Priority and Severity remain Organization Issue Fields; native repository Milestones are the optional concrete release target; Project #5 Status remains the workflow field.

GitHub uses the organization-profile Issue Forms only when a repository does not provide its own local template file. A repository-local template is therefore an explicit override and must remain compatible with the canonical schema or document why it differs.

Audited 2026-09-27:
- `chipin-frontend` `dev` and `main`: no local Issue Forms; shared forms apply.
- `chipin-backend` `develop`: no local Issue Forms; shared forms apply.
- `chipin-knowledge-base` `master`: no local Issue Forms; shared forms apply.

CODEOWNERS and GitHub Actions workflows are repository-local. They are not inherited as organization defaults and must be created/maintained in the repository whose ownership or execution policy they control.

Product/domain documentation lives in [chipin-knowledge-base](https://github.com/ChipIn-one/chipin-knowledge-base). Frontend/backend implementation and review policy stays in those repositories.


## Issue intake and finalization

`automation/issue-intake.mjs` completes new issue intake and repairs incomplete canonical metadata without guessing values.

- explicit inputs are required for Issue Type, Priority, and applicable Severity; missing Milestone is valid and intake preserves any existing Milestone;
- existing human Issue Type/Issue Field values and Project Status are preserved;
- missing Project #5 membership is added; duplicate membership fails closed for manual reconciliation;
- `Backlog` is initialized only when the sole Project item has no Status;
- every apply path performs fresh reads and final read-back before reporting success; receipts include the preserved native Milestone;
- API/agent create mode checkpoints the created issue identity before later stages so a retry cannot create a duplicate issue;
- apply mode requires both `--activate issue-intake-v1` and `CHIPIN_ISSUE_WRITE=1`.

For the UI path, create the issue from a shared Issue Form, then run the manual `Issue metadata finalizer` workflow with explicit canonical values. The workflow has no sibling-repository event subscription and performs no write unless `apply=true` and the separate `CHIPIN_ISSUE_WRITE_TOKEN` is configured.

See [automation/issue-intake.md](automation/issue-intake.md) for CLI examples, reconciliation rules, credential requirements, and activation steps.

## Workflow and completion

Project #5 `Status` tracks active workflow position only:

- `Backlog`
- `Todo`
- `In Progress`

There is no terminal Project status. Do not use or recreate `DEV`, `PROD`, or `Done` as completion state.

Native GitHub Issue state is the terminal source of truth:

- open = unfinished;
- closed as completed = completed;
- closed as not planned = cancelled / intentionally not completed.

Development-linked PRs and their merge state remain implementation evidence and are not copied into Project Status.

For frontend code work, merge to `dev` is integration only. Close the Issue only after the required implementation is merged to production branch `main`.

Repository-specific completion triggers outside frontend are out of scope for this change and remain owned by their repositories.

Knowledge-base and standalone non-code work close when their accepted durable outcome is complete; they do not need a synthetic terminal Project status.
