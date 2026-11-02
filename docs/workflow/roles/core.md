# Shared workflow invariants

- GitHub is the project registry. Select one exact record from [`workspace.yaml`](../workspace.yaml); do not discover or infer repositories.
- Resolve repository instructions and work against the selected record's `integrationBranch`. Active managed repositories may receive normal work; read-only repositories are context sources, not write targets.
- `contextDependencies` are explicit, task-scoped, read-only sources. Missing required context blocks work.
- Preserve target repository rules and the approved task scope. Shared workflow policy does not define product behavior, APIs, build, deployment, or repository-specific engineering rules.
- For admitted Issue work, use the read-only [`issue-admission-preflight.mjs`](../../../automation/issue-admission-preflight.mjs) flow and require `INTAKE_COMPLETE` for the exact current Issue revision at the required boundary. The only canonical metadata writer is [`issue-intake.mjs`](../../../automation/issue-intake.mjs); its contract is in [`issue-intake.md`](../../../automation/issue-intake.md).
- Admission, task approval, and context completeness are separate gates. None substitutes for another. Project #5 Status is workflow state, not authorization.
- Planner, Architect, Executor, Reviewer, and Auditor do not inherit Trusted Publisher authority. Executor implements and validates but never reviews its own changes, commits, pushes, or publishes. Reviewer is independent and read-only. Publisher is separate and requires explicit authorization.
- Required checks must be green for the exact current head before review. A head change makes prior CI and review evidence stale. Only a human merges.
- Do not store secrets, credentials, `.env` content, or conversation dumps in the canon or task artifacts.
