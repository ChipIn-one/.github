# Shared workflow invariants

## Invariants

- GitHub is the project registry. Select one exact record from [`workspace.yaml`](../workspace.yaml); do not discover or infer repositories.
- Resolve repository instructions and work against the selected record's `integrationBranch`. Every record is `access: managed` and may receive approved work within the task scope.
- `contextDependencies` are explicit, task-scoped, `read-only` sources: read them on their own integration branch and never write to them as part of the task. Missing required context blocks work.
- Preserve target repository rules and the approved task scope. Shared workflow policy does not define product behavior, APIs, build, deployment, or repository-specific engineering rules.
- Admission, task approval, and context completeness are separate gates. None substitutes for another. Project #5 Status is workflow state, not authorization.
- Planner, Architect, Executor, Reviewer, and Auditor do not inherit Trusted Publisher authority. Executor implements and validates but never reviews its own changes. Executor does not commit, push, or publish without explicit human authorization naming the Trusted Publisher. Reviewer is independent and read-only.
- Required checks must be green for the exact current head before review. A head change makes prior CI and review evidence stale. Only a human merges.

## Never

- Never store secrets, credentials, tokens, environment-file content, or conversation dumps in files, PR bodies, or Issue bodies, including the canon and task artifacts.
- Never push directly to `master` or `develop`; work reaches an integration branch only through a reviewed PR.
- Never force-push or bypass required checks, branch protection, or rulesets.

## Issue admission

This is the only statement of the admission rule; other files link here. For an Issue-backed task, read `capabilities.admission` from the target's record in [`workflow-registry.yaml`](../../../workflow-registry.yaml):

- `required` — a fresh `INTAKE_COMPLETE` for the exact current Issue revision is needed before executable planning, execution, publication, or review; a missing or stale result blocks work.
- `advisory` — run the preflight, report the result in the handoff, warn when it is not `INTAKE_COMPLETE`, and proceed.
- `off` — skip admission.

The preflight is the read-only [`issue-admission-preflight.mjs`](../../../automation/issue-admission-preflight.mjs) `--issue ChipIn-one/<repository>#<number>`, run from the `ChipIn-one/.github` checkout (a declared context dependency); knowledge-base checks need an explicit `--owner`. Refresh it at each controlled boundary. The only canonical metadata writer is [`issue-intake.mjs`](../../../automation/issue-intake.mjs); its contract is in [`issue-intake.md`](../../../automation/issue-intake.md). No role repairs Issue metadata or dispatches privileged workflows. A raw Issue URL, queued request, PR, or Project Status is not admission or approval.
