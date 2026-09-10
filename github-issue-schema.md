# ChipIn GitHub issue schema

Last reviewed: 2026-09-10

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
| Release scope | Organization Issue Field `Release scope` | `PRE-PROD`, `POST-PROD` |
| Workflow state | ChipIn Project #5 `Status` | Project workflow only; never infer from issue open/closed state |
| Parent / decomposition | Native GitHub issue relationships | Parent is optional; cross-repo product parent lives in KB when decomposition is needed |
| PR implementation relationship | Native GitHub Development relationship | Do not use plain URLs or universal closing keywords as a substitute |

Organization Issue Fields and Project fields are different objects. Do not create same-named Project custom fields as fallbacks for Organization Issue Fields.

If Organization Issue Fields are unavailable because of visibility or permission, the value is `UNKNOWN/BLOCKED`. Do not infer it from legacy labels, milestones, title text, issue state, or Project Status.

## Legacy metadata

The following are migration-only and MUST NOT be created for new work:

- priority labels `P0`, `P1`, `P2`, `P3`;
- `severity:*` labels;
- `type:*` labels;
- the `PRE-PROD` milestone as release-scope metadata.

During migration, preserve meaning before cleanup:

1. Read the current issue and structured Organization Issue Fields.
2. Resolve the intended canonical value from the approved migration mapping.
3. Write and re-read the canonical field / Issue Type.
4. Verify Project membership and the existing Project Status independently.
5. Only then remove the corresponding legacy label or milestone.

A failed or unavailable structured-field read blocks cleanup. Do not guess a replacement.

Repository labels may still be used for orthogonal repository-local classification when explicitly documented by that repository. They are not substitutes for the axes above.

## Issue body shape

Use only the relevant durable subset of these sections, in this order:

### Problem

State the current problem, constraint, or reason for the task. For defects, include enough reproduction/evidence here to make the problem verifiable.

### Outcome

Describe the observable state that should be true when the task is complete. Do not prescribe incidental implementation details unless they are constraints.

### Acceptance

Use checkable acceptance criteria.

### Dependencies

Use GitHub-native relationships when available. Put only real blocking/required dependencies here; do not duplicate Project Status.

### References

Link historical Trello cards, specs, ADRs, PRs, evidence, and related non-blocking work. Trello is historical/read-only and is never synchronized back.

## Issue Forms

Shared forms live in `.github/ISSUE_TEMPLATE/` and set only the canonical Organization Issue Type:

| Form | Issue Type |
| --- | --- |
| `bug.yml` | `Bug` |
| `enhancement.yml` | `Feature` |
| `docs.yml` | `Task` |
| `research.yml` | `Task` |
| `tests.yml` | `Task` |

Issue Forms do not create Priority/Severity/Release-scope labels or milestones. After creation, an organization member with access to Organization Issue Fields sets those structured values. If the fields are not visible, leave them unresolved and report the task as blocked for metadata completion.

## Relationships and workflow

Use GitHub-native relationships for workflow meaning:

- A parent is optional for standalone FE/BE work.
- When one product change is decomposed across repositories, its cross-repository product parent lives in `ChipIn-one/chipin-knowledge-base`.
- Native sub-issues are required decomposition work under that parent.
- Native `blocked by` / `blocking` relationships represent true dependencies.
- A Development-linked PR is implementation evidence for its specific issue or sub-issue.
- `References` are informational only and never gate status.
- A plain issue/PR URL is a reference, not a workflow relationship.
- Closing keywords are not a universal integration signal because their behavior depends on the PR target being the repository default branch.

`DEV` means every required implementation-bearing change is integrated into its configured integration branch: frontend to `dev`, backend to `develop`, and knowledge-base change to `main` when the product specification itself must change. Deployment is separate evidence and does not gate `DEV`.

Code/product work terminates at `PROD`. Standalone non-code research, documentation, and external work may terminate at `Done`. `PROD`, `Done`, and product-parent closure remain manual in v1.

If required work is reopened or required scope changes after `DEV`, report the state as inconsistent for manual review; do not automatically regress status. Ambiguous structured state fails closed.
