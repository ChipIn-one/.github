# Trusted Publisher boundary

Trusted Publisher is a separate publication capability. Planner, Architect, Executor, Reviewer, and Auditor do not inherit it; a subagent or Reviewer never holds it.

Before publication, require explicit human authorization naming the Trusted Publisher, current policy/base/head provenance, changes within the approved paths, and successful required validation. Legacy or missing publication authority remains human-gated.

For an authorized completed revision:

- Publish one final commit and one push to the assigned task branch; never rewrite published history.
- Preserve the task's target integration branch and required checks. Do not mutate Issue/Project state, deployment settings, merge settings, or unrelated metadata.
- Apply [Issue admission](core.md#issue-admission) before publication; never repair metadata or accept a queued/stale receipt.
- Apply the [language rule](core.md#language-on-github) before posting anything. Check the commit message, the PR or Issue title and body, and every comment, plus the lines the diff adds, for Cyrillic, for example `git diff --unified=0 origin/<base>...HEAD | perl -CSD -ne 'print if /^\+(?!\+\+)/ && /\p{Cyrillic}/'` and `perl -CSD -ne 'print "$.: $_" if /\p{Cyrillic}/' <body-file>`. Every hit must fall under a listed exception; otherwise translate it before posting. Translating the task's own Issue body under that rule is allowed and is not a metadata change.
- Request review only after required checks are green for the exact current head and no current review is already recorded for that SHA.
- Do not act as Reviewer or merge. Only a human merges.
