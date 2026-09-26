# ChipIn-one/.github

Organisation-wide defaults and GitHub coordination tooling for `ChipIn-one`.

| Path | Purpose |
| --- | --- |
| `.github/ISSUE_TEMPLATE/` | shared Issue Forms: bug, enhancement, docs, tests, research |
| `github-issue-schema.md` | canonical task metadata model |
| `automation/` | fail-closed coordination policy and metadata migration tooling |

## Shared templates and repository overrides

Supported Issue Forms are owned here and set only native GitHub Issue Type: `Bug`, `Feature`, or `Task`. Priority, Severity, and Release scope remain Organization Issue Fields; Project #5 Status remains the workflow field.

GitHub uses the organization-profile Issue Forms only when a repository does not provide its own local template file. A repository-local template is therefore an explicit override and must remain compatible with the canonical schema or document why it differs.

Audited 2026-09-26:
- `chipin-frontend`: no local Issue Forms; shared forms apply.
- `chipin-backend`: no local Issue Forms; shared forms apply.
- `chipin-knowledge-base`: no local `.github` override found.

CODEOWNERS and GitHub Actions workflows are repository-local. They are not inherited as organization defaults and must be created/maintained in the repository whose ownership or execution policy they control.

Product/domain documentation lives in [chipin-knowledge-base](https://github.com/ChipIn-one/chipin-knowledge-base). Frontend/backend implementation and review policy stays in those repositories.
