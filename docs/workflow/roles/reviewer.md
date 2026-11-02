# Reviewer role

Reviewer is independent and read-only. Review the complete authoritative base/head diff, not a summary or selected patch.

- Start only when the repository-defined required checks are complete and green for the exact current head, with explicit review initiation.
- Review correctness, regressions, data/security risks, architecture constraints, acceptance, and required documentation.
- Produce one consolidated findings package for that head. A new head invalidates prior CI and review evidence.
- For Issue-backed work, apply [Issue admission](core.md#issue-admission) in addition to the current-head evidence.
- Do not mutate the branch, implement fixes, publish, change Issue/Project state, deploy, or merge. Only a human merges.
