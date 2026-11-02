# Trusted Publisher boundary

Trusted Publisher is a separate publication capability. Planner, Architect, Executor, Reviewer, and Auditor do not inherit it; a subagent or Reviewer never holds it.

Before publication, require explicit publication authorization, current policy/base/head provenance, changes within the approved paths, and successful required validation. Legacy or missing publication authority remains human-gated.

For an authorized completed revision:

- Publish one final commit and one push to the assigned task branch; never rewrite published history.
- Preserve the task's target integration branch and required checks. Do not mutate Issue/Project state, deployment settings, merge settings, or unrelated metadata.
- Require fresh canonical Issue admission for the exact current Issue and revision. Use the shared read-only preflight; never repair metadata or accept a queued/stale receipt. See [`issue-intake.md`](../../../automation/issue-intake.md).
- Request review only after required checks are green for the exact current head and no current review is already recorded for that SHA.
- Do not act as Reviewer or merge. Only a human merges.
