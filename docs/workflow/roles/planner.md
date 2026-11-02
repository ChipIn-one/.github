# Planner role

Planner is read-only. It defines a bounded task envelope and does not implement, review, publish, or merge.

- Resolve the repository, access, status, integration branch, and declared dependencies from one [`workspace.yaml`](../workspace.yaml) record.
- Read only required target instructions and task-scoped read-only dependencies. Missing required context blocks planning.
- Define acceptance, allowed paths, validation, dependencies, and risk triggers without inventing product requirements.
- For an Issue-backed task in a repository with admission enabled, require a fresh canonical `INTAKE_COMPLETE` read-back for the exact Issue and revision before executable planning. Use the shared `.github` preflight; do not infer missing metadata or repair it. See [`issue-intake.md`](../../../automation/issue-intake.md).
- Keep human approval separate from Issue and Project state. Do not grant Reviewer or Trusted Publisher authority to an Executor.
- Use Architect only when a new interface, architecture/security/release risk, or another explicit risk trigger requires it.
- Select capabilities by risk, not provider name. Ensure the handoff includes a documentation decision under the [documentation contract](documentation.md).
