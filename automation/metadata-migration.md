# Metadata migration runbook

Task authority: [ChipIn-one/.github#6](https://github.com/ChipIn-one/.github/issues/6). Approved backend mapping: [ChipIn-one/chipin-backend#117](https://github.com/ChipIn-one/chipin-backend/issues/117).

## Safety model

`plan` is read-only. It reads the organization Issue Fields and Issue Types, Project #5, issue field values, Project membership/Status, native dependency relationships, parent/sub-issues, labels, and milestone state.

Organization Issue Field IDs are authoritative:
- Priority: `46621432`
- Severity: `46621453`
- Release scope: `46621522`

Issue Type IDs are also pinned and re-verified before mutation:
- Task: `26867545`
- Bug: `26867546`
- Feature: `26867547`

Project #5 is expected to contain 98 items at activation time. The migration verifies that the Project fields named Priority, Severity, and Release scope are issue-field projections whose `issueField.fullDatabaseId` matches the organization field ID. Empty Project option arrays are not used to infer anything and are not a reason to recreate a field. A count change, duplicate/missing field, unreadable field relationship, missing Project membership, unreadable Status, or unreadable native relationship blocks cleanup.

`apply` is intentionally double-gated and is not run by CI:

```sh
GITHUB_TOKEN=... node automation/metadata-migration.mjs plan \
  --output /tmp/chipin-metadata-plan.json

CHIPIN_METADATA_APPLY=1 GITHUB_TOKEN=... \
  node automation/metadata-migration.mjs apply \
  --activate issue-117 \
  --state /tmp/chipin-metadata-state.json \
  --output /tmp/chipin-metadata-apply.json
```

Apply writes canonical Issue Fields / Issue Type first, re-reads them, and only then removes legacy labels or the PRE-PROD milestone. After cleanup it performs a final read-back. The state file checkpoints completed issues; a resumed run re-reads completed issues and skips them only while they remain clean.

The token used for an operator run needs read access to organization Issue Fields, Issue Types and Project #5, plus issue write access for the backend repository. No credential is stored in this repository.

## Migration diff prepared from the 2026-09-26 read-only audit

The mapping file is the auditable source for all 24 issues. Current live issue reads show:

- already canonical and cleanup-free: #115.
- canonical Priority/Release scope already present, but Issue Type and legacy cleanup remain: #91, #94, #96, #101, #102.
- remaining mapped issues require canonical field/type writes before legacy cleanup: #9, #92, #93, #95, #97-#100, #103-#112.
- #91 and #96 additionally require canonical Severity before their legacy severity labels can be removed.
- `question` on #110-#112 is explicitly preserved because it is orthogonal to the organization schema.
- no Project Status is changed by this migration.
- native dependencies, parent/sub-issues, Project membership, and Project Status are read and reported independently; they are never inferred from labels or issue state.

The committed diff is intentionally a plan, not an activation record. Live Project membership/Status and the Project-to-organization field links are re-read at operator time before any cleanup.

## Repository ownership

Shared Issue Forms live here in `ChipIn-one/.github`. A repository-local file of the same template kind overrides the shared default.

At this audit point:
- `chipin-frontend`: no local Issue Forms; shared forms apply.
- `chipin-backend`: no local Issue Forms; shared forms apply.
- `chipin-knowledge-base`: no local `.github` override was found.

Workflows and CODEOWNERS are repository-local GitHub files and are not standardized by copying them into the organization profile repository. Repository-specific workflow/review policy stays with its repository.
