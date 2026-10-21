# Conformance audit

Checks that a repository matches its record in [`workflow-registry.yaml`](../../workflow-registry.yaml). Specified by the
[ChipIn Workflow Standard v1](README.md#6-conformance-audit); implemented by [#154](https://github.com/ChipIn-one/.github/issues/154). Until then this page is the checklist, and
the only automated check is registry validation (`node automation/registry.mjs --validate`, run by `automation-tests` on every pull request).

## Checks per registry repository

1. Caller workflows exist for every capability that is not `off` (PR gate, milestones when enabled).
2. Pins of `ChipIn-one/.github` are SHAs with a version comment and are not older than the latest tag that touches a capability the repository uses.
3. `.github/dependabot.yml` exists with ecosystem `github-actions` (when `dependabot: required`).
4. The `ai-workflow:agents-routing` block in `AGENTS.md` and `.ai/context.md` exist (when `agentRouting: required`).
5. Branch protection / ruleset and required checks match `protection` and `requiredChecks`.
6. No pull requests are present in Project #5.
7. Counts of Issues without Type, Priority or Project (count only, no repair).
8. Closed Issues with open Development PRs.
9. For `protection: unavailable`: merges past a red required check during the period.

## Result

Per repository an artifact `conformance-<repo>.json` and one upserted Issue in `.github` (Type Task, owner from the registry, no labels). With zero drift the Issue is
closed as completed. Registered status is `CONFORMANT`; organization repositories not in the registry are listed in the summary as `UNREGISTERED` with no action.
