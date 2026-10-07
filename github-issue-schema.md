# ChipIn GitHub issue schema

Last reviewed: 2026-10-07

This document defines the shared GitHub task metadata model for ChipIn repositories.
It does not define repository-specific implementation, review, build, test, deploy, or agent-execution rules.

## Authorities

Keep the axes separate:

| Concern | Canonical GitHub source | Values / rule |
| --- | --- | --- |
| Task specification | Issue body | Problem, Outcome, Acceptance, Dependencies, References |
| Work kind | Organization Issue Type | `Task`, `Feature`, `Bug` |
| Priority | Organization Issue Field `Priority` | `P0`, `P1`, `P2`, `P3` |
| Severity | Organization Issue Field `Severity` | `Critical`, `Major`, `Minor`; use only when relevant |
| Release target | Native repository Milestone | Optional concrete product release target |
| Workflow position / completion mirror | ChipIn Project #5 `Status` | `Backlog`, `Todo`, `In Progress`; `Done` mirrors `closed/completed` only |
| Completion state | Native GitHub Issue state/reason | open = unfinished; closed/completed = complete; closed/not planned = cancelled |
| Parent / decomposition | Native GitHub issue relationships | Parent is optional; cross-repo product parent lives in KB when decomposition is needed |
| PR implementation relationship | Native GitHub Development relationship | Do not use plain URLs or closing-keyword inference as a substitute for a required manual/native link |

Organization Issue Fields and Project fields are different objects. Do not create same-named Project custom fields as fallbacks for Organization Issue Fields.

A missing Milestone is valid and means the issue is not committed to a concrete release. Milestone membership never authorizes execution or completion.

GitHub Milestones are repository-scoped. Same-named milestones in FE/BE/KB represent the same product release by convention and must use the same product-level name. Do not derive the name from repository-local package/API versions unless product versioning explicitly adopts that scheme.

## Release-target rules

- Use concrete release targets such as the existing `POST RELEASE 1.1`.
- Do not create generic `PRE-PROD` or `POST-PROD` milestones to replace the retired field.
- Existing Milestone assignments are human-owned release intent. Intake/reconciliation preserves them and does not infer, add, clear, or rename Milestones.
- Release progress is based on release issues. Linked implementation PRs do not need the issue's milestone solely to inflate progress.
- Project #5 `Status` remains secondary to native Issue state. `Done` is a derived Project mirror of `closed/completed`, never the authority that makes an Issue complete.

## Legacy metadata

The Organization Issue Field `Release scope` and its `PRE-PROD` / `POST-PROD` values are historical migration evidence only. They are not active canonical schema and must not be written for new work.

Legacy priority/severity/type labels and the historical `PRE-PROD` milestone semantics are also migration-only. Historical migration tooling may retain old terminology when explicitly marked historical.

Retirement order is fail-closed:

1. Snapshot current legacy values and current native Milestones.
2. Update active readers/writers/contracts so the legacy field is no longer required.
3. Pilot on explicitly approved issues and re-read Priority, Severity, Issue Type, Milestone, Project membership/Status, and native relationships.
4. Reconcile the approved mapping without overwriting human-owned values.
5. Only after clean read-back, retire/remove the legacy organization field.

A failed or unavailable structured read blocks destructive cleanup. Do not guess a replacement.

## Issue body shape

Use only the relevant durable subset of these sections, in this order: `Problem`, `Outcome`, `Acceptance`, `Dependencies`, `References`.

Use checkable acceptance criteria. Use GitHub-native relationships for real blocking/decomposition semantics. References are informational only.

## Issue Forms and complete intake

Shared forms live in `.github/ISSUE_TEMPLATE/` and set only native Issue Type.

Issue Forms do not encode Priority, Severity, or Milestone as body dropdowns. Body values are Markdown, not canonical metadata.

A UI-created issue is canonically complete after the manual `Issue metadata finalizer` has received explicit Issue Type, Priority, applicable Severity, ensured exactly one Project #5 membership, preserved any existing Status, initialized `Backlog` only when Status is absent, and returned a clean read-back receipt. Milestone is optional and is preserved as-is.

API/agent creation uses `automation/issue-intake.mjs apply create` with the same classification. `apply reconcile` repairs an existing incomplete issue. Existing human canonical values, native Milestone, relationships, and Project Status are preserved; conflicts, duplicate membership, permission failures, and unreadable state fail closed.

## Relationships and workflow

Use GitHub-native relationships for workflow meaning:

- A parent is optional for standalone FE/BE work.
- Cross-repository product decomposition uses native parent/sub-issue relationships.
- Native `blocked by` / `blocking` relationships represent true dependencies.
- A Development-linked PR is implementation evidence for its specific issue or sub-issue.
- A plain issue/PR URL is a reference, not a workflow relationship.

Project #5 Status tracks active work as `Backlog -> Todo -> In Progress`. `Done` is retained only as a derived display state for an Issue already `closed/completed`. Do not use or recreate `DEV` or `PROD`; `Done` must never authorize Issue closure.

Native Issue state is the completion authority. Closing as completed means the task is complete; closing as not planned means it was cancelled or intentionally abandoned. Reopening makes the task unfinished again.

Development-linked PRs are implementation evidence. Their merge state must not be copied into Project Status.

For frontend code work, merge to integration branch `dev` is not completion. Close only after the required implementation is merged to production branch `main`.

Repository-specific completion triggers other than the frontend rule above are outside this shared change and remain repository-owned.

Knowledge-base and standalone non-code work close when their accepted durable outcome is complete on the canonical source of truth. Ambiguous completion evidence fails closed.
