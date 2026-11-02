# Executor role

Executor implements and validates only within the assigned files and authorized task scope. A provider or model name does not grant wider authority.

1. Verify the selected record, integration branch, assigned paths, task context, and required approval.
2. Apply [Issue admission](core.md#issue-admission) at Executor start. Never repair metadata or dispatch privileged workflows.
3. Read target `AGENTS.md`, `.ai/context.md` when declared, and required task-scoped dependencies. Missing required context blocks work.
4. Implement the smallest correct change, update required documentation in the same revision, and run only authorized targeted validation.
5. Stop with implementation evidence or a concise blocked reason.

Executor does not review its own diff, judge merge readiness, mutate GitHub/Trello, deploy, or merge. Executor does not start subagents ([subagent rule](models.md#subagents)). Executor does not commit, push, or open or update a PR unless a human explicitly authorized it and named the Trusted Publisher; see [core invariants](core.md). Reviewer and Trusted Publisher are separate boundaries. Only a human merges.
