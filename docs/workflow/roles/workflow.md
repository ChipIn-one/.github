# Workflow role index

Read the [canonical workflow](../FLOW.md) and shared [core invariants](core.md). Load only the role needed for the task; a role name does not select a provider or grant additional authority.

- [Planner](planner.md) — read-only task scope, acceptance, approval, and dependencies.
- [Architect](architect.md) — read-only architecture and risk decisions when triggered.
- [Executor](executor.md) — implementation and validation within assigned paths; no self-review or publication.
- [Reviewer](reviewer.md) — independent, read-only review of the complete current diff.
- [Auditor](auditor.md) — read-only policy and evidence audit.
- [Trusted Publisher](publisher.md) — separate authorized publication boundary, not an AI role grant.
- [Model tiers](models.md) — capability guidance, not authority.
- [Documentation contract](documentation.md) — same-change documentation rules.
- [Context policy](context.md) — project context and dependency handling.

This role index and the core invariants are maintained by `ChipIn-one/.github`. Repository-specific policy remains in each target's `AGENTS.md` and `.ai/context.md`.
