# ChipIn-one/.github

Organisation-wide defaults and GitHub coordination tooling for `ChipIn-one`.

| Path | Purpose |
| --- | --- |
| `.github/ISSUE_TEMPLATE/` | shared Issue Forms: bug, enhancement, docs, tests, research |
| `.github/workflows/issue-metadata-finalize.yml` | manual UI finalizer for canonical issue metadata and Project #5 membership/Status |
| `github-issue-schema.md` | canonical task metadata model |
| `automation/` | fail-closed coordination, issue-intake, and metadata migration tooling |

## Shared templates and repository overrides

Supported Issue Forms are owned here and set only native GitHub Issue Type: `Bug`, `Feature`, or `Task`. Priority, Severity, and Release scope remain Organization Issue Fields; Project #5 Status remains the workflow field.

GitHub uses the organization-profile Issue Forms only when a repository does not provide its own local template file. A repository-local template is therefore an explicit override and must remain compatible with the canonical schema or document why it differs.

Audited 2026-09-27:
- `chipin-frontend` `dev` and `main`: no local Issue Forms; shared forms apply.
- `chipin-backend` `develop`: no local Issue Forms; shared forms apply.
- `chipin-knowledge-base` `main`: no local Issue Forms; shared forms apply.

CODEOWNERS and GitHub Actions workflows are repository-local. They are not inherited as organization defaults and must be created/maintained in the repository whose ownership or execution policy they control.

Product/domain documentation lives in [chipin-knowledge-base](https://github.com/ChipIn-one/chipin-knowledge-base). Frontend/backend implementation and review policy stays in those repositories.


## Issue intake and finalization

`automation/issue-intake.mjs` completes new issue intake and repairs incomplete canonical metadata without guessing values.

- explicit inputs are required for Issue Type, Priority, Release scope, and applicable Severity;
- existing human Issue Type/Issue Field values and Project Status are preserved;
- missing Project #5 membership is added; duplicate membership fails closed for manual reconciliation;
- `Backlog` is initialized only when the sole Project item has no Status;
- every apply path performs fresh reads and final read-back before reporting success;
- API/agent create mode checkpoints the created issue identity before later stages so a retry cannot create a duplicate issue;
- apply mode requires both `--activate issue-intake-v1` and `CHIPIN_ISSUE_WRITE=1`.

For the UI path, create the issue from a shared Issue Form, then run the manual `Issue metadata finalizer` workflow with explicit canonical values. The workflow has no sibling-repository event subscription and performs no write unless `apply=true` and the separate `CHIPIN_ISSUE_WRITE_TOKEN` is configured.

See [automation/issue-intake.md](automation/issue-intake.md) for CLI examples, reconciliation rules, credential requirements, and activation steps.

## DEV readiness automation

`automation/dev-readiness-live.mjs` is the fail-closed live reader for Project #5. The writer in `automation/dev-readiness-write.mjs` is intentionally narrower:

- the only mutation is Project #5 `Status -> DEV`;
- a write requires a fresh live evaluator result of `READY_FOR_DEV`;
- `PROD`, `Done`, closure and regression are never automated;
- a second fresh read is performed immediately before the single allowed write;
- each run can write at most one Project item;
- post-write state is read back; inconsistent read-back is reported for manual handling and is never auto-regressed;
- apply mode requires both `--activate dev-status-v1` and `CHIPIN_DEV_WRITE=1`.

The workflow `.github/workflows/dev-readiness-dev-transition.yml` supports manual dry-run/apply and an hourly scheduled scan. Scheduled writes remain disabled unless repository variable `CHIPIN_DEV_WRITE_ENABLED=1` is explicitly configured. Read-only runs use `CHIPIN_DEV_READ_TOKEN`; mutations use the separate `CHIPIN_DEV_WRITE_TOKEN`.
