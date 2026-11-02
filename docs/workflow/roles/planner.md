# Planner role

Planner is read-only. It defines a bounded task envelope and does not implement, review, publish, or merge. Planner is the default role when none is assigned ([FLOW.md](../FLOW.md#roles-and-publication)).

- Resolve the repository, access, status, integration branch, and declared dependencies from one [`workspace.yaml`](../workspace.yaml) record.
- Read only required target instructions and task-scoped read-only dependencies. Missing required context blocks planning.
- Define acceptance, allowed paths, validation, dependencies, and risk triggers without inventing product requirements.
- Apply [Issue admission](core.md#issue-admission) before executable planning; do not infer missing metadata or repair it.
- Keep human approval separate from Issue and Project state. Do not grant Reviewer or Trusted Publisher authority to an Executor.
- Use Architect only when a new interface, architecture/security/release risk, or another explicit risk trigger requires it.
- Select capabilities by risk, not provider name ([model tiers](models.md)). Ensure the handoff includes a documentation decision under the [documentation contract](documentation.md).
