# Workflow role index

Reference page; the mandatory reading order and the task type → role → tier → publication table are in [FLOW.md](../FLOW.md#roles-and-publication). Always read the shared [core invariants](core.md) and only the role needed for the task; a role name does not select a provider or grant additional authority.

- [Planner](planner.md) — read-only task scope, acceptance, approval, and dependencies; the default when no role is assigned.
- [Architect](architect.md) — read-only architecture and risk decisions when triggered.
- [Executor](executor.md) — implementation and validation within assigned paths; no self-review, no subagents, no publication without authorization.
- [Reviewer](reviewer.md) — independent, read-only review of the complete current diff.
- [Auditor](auditor.md) — read-only policy and evidence audit.
- [Trusted Publisher](publisher.md) — separate authorized publication boundary, not an AI role grant.
- [Model tiers](models.md) — capability guidance and subagent rule, not authority.
- [Documentation contract](documentation.md) — same-change documentation rules.
- [Context policy](context.md) — project context and dependency handling.

This role index and the core invariants are maintained by `ChipIn-one/.github`. Repository-specific policy remains in each target's `AGENTS.md` and `.ai/context.md`.
