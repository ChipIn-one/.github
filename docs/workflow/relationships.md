# Task relationships

Contract for native Issue relationships in the [ChipIn Workflow Standard v1](README.md#5-task-relationships).
The reconciler, gate and receipt format are implemented by [#136](https://github.com/ChipIn-one/.github/issues/136); this page is the contract they implement.
Nothing here is enforced until that task lands.

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

URLs, "see #123", bare numbers without a repository and Milestones are not declarations. The intake CLI gets repeatable `--blocked-by`, `--blocks`, `--relates-to`
and `--parent` flags that write both the lines and the native edges in one apply with read-back.

## Reconciler

`automation/relationships.mjs`, run by the org workflow `relationships-reconcile.yml` (`schedule */30` and `workflow_dispatch`, token `CHIPIN_ISSUE_WRITE_TOKEN`):

- reads open Issues of registry repositories whose `relationships` capability is not `off`, parses the declarations and compares them with the native state;
- **only adds** missing edges. Native edges without a declaration are kept and appended to `## Dependencies` as lines (read-back → text, never the other way);
- never removes or reverses an edge. A cycle, self-reference, unreachable target or ambiguous declaration ends in `BLOCKED` with a receipt artifact and exactly one upserted comment on the Issue;
- is idempotent: a rerun without changes performs 0 writes.

## Gate

With `relationships: required`, admission (`pr-gate` and `issue-admission-preflight`) reads `blockedBy` for the Task identity; any open blocker fails with `BLOCKED_BY_DEPENDENCY`.
The only ways to clear it are closing the blocker or a human removing the edge. Automation never closes an Issue and never moves Status when a blocker clears.
Legacy Issues without declarations are not touched in bulk; an edge appears only from an explicit declaration or a manual action.

## Visibility

Issue sidebar "Relationships"; Project #5 fields `Parent issue` and `Sub-issues progress`. A "Blocked" view is built only after live verification that the board shows open
blockers; otherwise the table with `Parent issue` stays, with no shadow fields or labels. Labels are never used as relationships.
