# ChipIn canonical workflow

This file is the entry point for every ChipIn AI agent. The [workflow standard README](README.md), the [role index](roles/workflow.md), and the [project index](projects/index.md) are reference material: read them on demand, not as part of the mandatory path.

## Reading order

1. Read this `FLOW.md`.
2. Select exactly one repository record from [`workspace.yaml`](workspace.yaml). Never discover projects by scanning repositories.
3. Read the shared [core invariants](roles/core.md) (`roles/core.md`) and only the role file selected in [Roles and publication](#roles-and-publication). For an Issue-backed task, also read the target's record in [`workflow-registry.yaml`](../../workflow-registry.yaml) for its admission capability.
4. On that record's `integrationBranch`, read the target repository's `AGENTS.md`, then `.ai/context.md` when the record declares it.
5. Read only relevant local decisions and tasks, then the declared `contextDependencies` the task needs, on their own integration branches.

Legacy/pre-canon contexts are migration-only and never authoritative; this organization-owned canon is the source of truth for shared routing.

## Precedence and availability

- The canon wins for roles, gates and routing.
- The repository's own docs win for product, engineering, build and deploy rules.
- On a real conflict between the two, stop and report it; do not pick a side silently.
- If the canon cannot be read, stop: fail closed. This covers this file, `workspace.yaml`, `roles/core.md`, the selected role, and `workflow-registry.yaml` for Issue-backed tasks. Do not fall back to local copies, caches, or legacy contexts. Unavailable required context blocks work in the same way.

## Repository access

Repository ownership, integration branches, and context dependencies come from the selected record. Every record is `access: managed` and may receive approved work. `read-only` is a property of `contextDependencies` entries only: a dependency is read for context and never written as part of the task. `ChipIn-one/.github` is a declared dependency of the other repositories because it holds the Issue admission tooling and this canon.

## Issue admission

Issue admission (`required` / `advisory` / `off` from `workflow-registry.yaml`) is defined once in [core invariants](roles/core.md#issue-admission).

## Roles and publication

| Task type | Role | Capability tier | Publication authorized by |
| --- | --- | --- | --- |
| No role assigned, triage, scoping, acceptance | [Planner](roles/planner.md) (read-only) | `standard`; `deep` when orchestrating | not applicable |
| New interface, architecture, security, or release risk | [Architect](roles/architect.md) (read-only) | `deep` | not applicable |
| Implement and validate an approved task | [Executor](roles/executor.md) | `standard` | n/a (hands off to Trusted Publisher) |
| Review a pinned current-head diff | [Reviewer](roles/reviewer.md) (read-only) | `standard`; `deep` for high risk | not applicable |
| Policy, process, or evidence audit | [Auditor](roles/auditor.md) (read-only) | `standard` | not applicable |
| Commit, push, open or update a PR | [Trusted Publisher](roles/publisher.md) | `standard` | human, explicitly |

Tiers are defined in [model tiers](roles/models.md); `fast` is only for search, reading, and summarizing evidence. If no role is assigned, default to Planner, read-only (fail closed). Publication (commit, push, PR) requires explicit human authorization naming the Trusted Publisher; a role or model name never grants it. Executors do not review or publish their own work. Review requires the repository's required checks to be green for the current head. Only a human merges.

Human approval, Issue admission, and required context are independent gates. Keep repository-specific decisions in the target repository and do not broaden the selected task's scope.
