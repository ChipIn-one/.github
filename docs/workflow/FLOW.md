# ChipIn canonical workflow

## Authority and reading order

The organization-owned workflow canon is authoritative for shared routing. Follow this order:

1. Read the organization workflow [README](README.md) and this `FLOW.md`.
2. Select exactly one repository record from [`workspace.yaml`](workspace.yaml), using the human-readable [project index](projects/index.md) as an aid. Never discover projects by scanning repositories.
3. Read the [role index](roles/workflow.md), the shared [core invariants](roles/core.md), and only the role selected for the task.
4. On that record's `integrationBranch`, read the target repository's `AGENTS.md`, then `.ai/context.md` when the record declares it.
5. Read only relevant local decisions, task files, and declared `contextDependencies`. Treat dependencies as read-only; unavailable required context blocks work.

Repository ownership, integration branches, access, and context dependencies come from the selected record. Active `managed` records may receive normal work. `read-only` records are context sources only. Product behavior, repository engineering rules, build, deployment, and completion policy remain in their owning repositories and the organization workflow documentation.

## ChipIn Issue admission

For an Issue-backed task in a registered repository whose admission capability is enabled, require a fresh, read-only `INTAKE_COMPLETE` result for the exact Issue and current revision before executable planning, execution, publication, or review. Use `automation/issue-admission-preflight.mjs --issue ChipIn-one/<repository>#<number>` from the `.github` checkout; knowledge-base checks require an explicit `--owner`. Refresh admission at each controlled boundary. Missing or stale Organization Issue Fields, Project #5 membership, permissions, owner, or revision blocks work; do not repair metadata as an Executor.

`automation/issue-intake.mjs` is the canonical metadata writer. See [`automation/issue-intake.md`](../../automation/issue-intake.md) for the intake and read-back contract. Issue content specifies the task, structured Organization Issue Fields carry metadata, and Project #5 Status is workflow state rather than execution authority. A raw Issue URL, queued request, PR, or Project Status is not admission or approval.

## Role and publication boundaries

Roles are provider-independent. Planner scopes, Architect handles triggered risk, Executor implements and validates, Reviewer independently reviews a pinned diff, and Auditor evaluates evidence. Trusted Publisher is a separate capability; role names do not grant it. Executors do not review or publish their own work. Review requires the repository's required checks to be green for the current head. Only a human merges.

Human approval, Issue admission, and required context are independent gates. Missing approval or required context blocks the relevant work. Keep repository-specific decisions in the target repository and do not broaden the selected task's scope.
