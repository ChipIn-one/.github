# Task relationships

Contract for native Issue relationships in the [ChipIn Workflow Standard v1](README.md#5-task-relationships).
Implemented by [#136](https://github.com/ChipIn-one/.github/issues/136): `automation/relationships.mjs` (reconciler and CLI), the org workflow
`.github/workflows/relationships-reconcile.yml`, and the blocker gate inside `readAdmission()`.
Live acceptance on real FE↔BE pairs is [#152](https://github.com/ChipIn-one/.github/issues/152); until then scheduled runs only plan (see Rollout).

## Edges

| Declaration | Native object | Gate |
| --- | --- | --- |
| `Blocked by: owner/repo#N` | `blockedBy` | open blocker → `BLOCKED_BY_DEPENDENCY` (fail) |
| `Blocks: owner/repo#N` | `blocking` | same, for the target |
| `Relates to: owner/repo#N` | `relatesTo` | none |
| `Parent: owner/repo#N` | `parent` / `subIssues` | none |

GitHub exposes them through GraphQL (`blockedBy`, `blocking`, `relatesTo`, `parent`, `subIssues`; mutations `addBlockedBy`, `addRelatesTo`, `addSubIssue`) and REST
(`/issues/{n}/dependencies/blocked_by`, `/blocking`, `/sub_issues`). Cross-repository edges inside the organization and the Project #5 "blocked" rendering are verified
by the live acceptance step of [#152](https://github.com/ChipIn-one/.github/issues/152).

## Declaring

Put one declaration per line in the `## Dependencies` section of the Issue body, with the target always in the form `owner/repo#number`:

```markdown
## Dependencies

Blocked by: ChipIn-one/chipin-backend#143
Relates to: ChipIn-one/chipin-backend#157
Parent: ChipIn-one/chipin-knowledge-base#40
```

URLs, "see #123", bare numbers without a repository and Milestones are not declarations. Two supported writers put the line and the native edge together with read-back:

```bash
# new Issue: lines go into the created body, edges are added after creation (create only)
node automation/issue-intake.mjs apply create ChipIn-one/chipin-frontend --type Task --priority P2 --title "…" --body-file body.md \
  --state state.json --activate issue-intake-v1 --blocked-by ChipIn-one/chipin-backend#143 --relates-to ChipIn-one/chipin-backend#157

# existing Issue: plan first (default), then apply
node automation/relationships.mjs declare --issue ChipIn-one/chipin-frontend#271 --blocked-by ChipIn-one/chipin-backend#143
CHIPIN_RELATIONSHIPS_WRITE=1 node automation/relationships.mjs declare --issue ChipIn-one/chipin-frontend#271 \
  --blocked-by ChipIn-one/chipin-backend#143 --apply --activate relationships-v1
```

Flags are repeatable: `--blocked-by`, `--blocks`, `--relates-to`, `--parent`. `issue-intake.mjs reconcile` does not take them (it never edits bodies).

## Reconciler

`automation/relationships.mjs`, run by the org workflow `relationships-reconcile.yml` (`schedule */30` and `workflow_dispatch`, token `CHIPIN_ISSUE_WRITE_TOKEN`):

- reads open Issues of registry repositories whose `relationships` capability is not `off`, parses the declarations and compares them with the native state;
- **only adds** missing edges. Native edges without a declaration are kept and appended to `## Dependencies` as lines (read-back → text, never the other way). The body is re-read right before the edit and left alone (`STALE_TEXT`, retried next run) if a human changed it meanwhile. After edges were added, the other endpoints are mirrored in the same run (`mirror` in the receipt) so an immediate rerun writes nothing;
- never removes or reverses an edge. A cycle, self-reference, unreachable target or ambiguous declaration ends in `BLOCKED` with a receipt artifact and exactly one upserted comment on the Issue;
- is idempotent: a rerun without changes performs 0 writes.

Validations per Issue (any failure → status `BLOCKED`, **no** edge of that Issue is written): malformed, duplicate or multi-target declaration, several `Parent:` lines, several `## Dependencies` sections,
self-reference, target outside the registry (or `relationships: off`), target missing or not visible, closed target for `blocked by`/`blocks`, dependency cycle (including a reversal of an existing edge and
two contradictory declarations of the same Issue), a second parent (never re-parented), more than 50 native edges of one kind (cannot be verified). Every write is read back; a missing edge after the
write is `READBACK_MISMATCH` (status `FAILED`).

### Receipt

`--output` (the workflow uploads it as `relationships-receipt-<run>`) is JSON with `contract: chipin-relationships/v1`, `mode` (`plan`/`apply`), `generatedAt`, `standardVersion`, `repositories`,
`summary` (`examined`, `clean`, `planned`, `applied`, `blocked`, `failures`), `outcome` and one entry per examined Issue:
`issue`, `status` (`CLEAN`, `PLANNED`, `APPLIED`, `BLOCKED`, `FAILED`, `UNREADABLE`), `declared`, `add` (edge keys such as `blocked_by|<blocked>|<blocker>`), `added`, `textLines`, `textAppended`, `textSkipped`, `blockers`.
`outcome` is `OK`, `ATTENTION` (only declaration-level `BLOCKED`) or `FAILED` (operational failure: unreadable repository, write or read-back failure). The process exits non-zero only for `FAILED`, so an
Issue with a bad declaration does not turn every 30-minute run red; it gets one upserted comment (marker `<!-- chipin:relationships:v1 -->`) and a workflow warning annotation. When the cause is fixed the same
comment is updated to "Resolved". Issues that were never blocked get no comment.

### Rollout

`relationships-reconcile.yml` runs `*/30` and on `workflow_dispatch`. Scheduled runs are **read-only plans** until the repository variable `RELATIONSHIPS_RECONCILE_APPLY` is `true`; a dispatch applies only
with `apply=true`. Writes use `CHIPIN_ISSUE_WRITE_TOKEN` and need `--activate relationships-v1` plus `CHIPIN_RELATIONSHIPS_WRITE=1`. Do not set the variable before the live acceptance in #152 confirmed that
the token can write cross-repository edges; a 403 ends as a `FAILED` receipt with the diagnostic and is never worked around.

## Gate

With `relationships: required`, admission reads `blockedBy` for the Task identity; any blocker that is not positively `closed` (open or unreadable) fails with `BLOCKED_BY_DEPENDENCY`.
The check lives in `readAdmission()` (`dependencyBlockers()` in `relationships.mjs`), so `issue-admission.mjs`, `issue-admission-preflight.mjs`, `issue-admission-pr.mjs` (and through it the Development link and PR
metadata) and the future `pr-gate` all fail the same way, with diagnostic code `BLOCKED_BY_DEPENDENCY`. Intake completeness (`verifyAdmission()` without the execution gate) deliberately ignores blockers: an
Issue can be fully admitted metadata-wise and still blocked from execution.
The only ways to clear it are closing the blocker or a human removing the edge. Automation never closes an Issue and never moves Status when a blocker clears.
Legacy Issues without declarations are not touched in bulk; an edge appears only from an explicit declaration or a manual action.

## Visibility

Issue sidebar "Relationships"; Project #5 fields `Parent issue` and `Sub-issues progress`. A "Blocked" view is built only after live verification that the board shows open
blockers; otherwise the table with `Parent issue` stays, with no shadow fields or labels. Labels are never used as relationships.
