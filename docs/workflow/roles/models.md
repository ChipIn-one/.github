# Capability tiers

Roles refer to capability tiers, not model names. A model name never grants a role or additional authority. Keep subagents within the parent session's provider and the task's allowed scope.

- `deep` — orchestration, architecture, or high-risk independent review.
- `standard` — normal implementation or review.
- `fast` — search, reading, mechanical work, and summarizing evidence; not code implementation.

Select the smallest capability that safely satisfies the task. Escalate when risk, ambiguity, or required reasoning exceeds that capability; do not choose a provider merely because a role name suggests it.
