# Capability tiers

Roles refer to capability tiers, not model names. A model name never grants a role or additional authority. Task type → role → tier mapping is in [FLOW.md](../FLOW.md#roles-and-publication).

- `deep` — orchestration, architecture, or high-risk independent review.
- `standard` — normal implementation or review.
- `fast` — search, reading, mechanical work, and summarizing evidence; not code implementation.

Select the smallest capability that safely satisfies the task. Escalate when risk, ambiguity, or required reasoning exceeds that capability; do not choose a provider merely because a role name suggests it.

## Subagents

Only an orchestrating session (Planner at `deep` tier, started by a human) may start subagents. Each subagent receives exactly one role from the FLOW table, that role's limits, and a scope no wider than the parent task; it stays within the parent session's provider. Executor does not start subagents, and no subagent inherits Trusted Publisher authority.
