# Conformance audit

Checks that a repository matches its record in [`workflow-registry.yaml`](../../workflow-registry.yaml). Specified by the
[ChipIn Workflow Standard v1](README.md#6-conformance-audit); implemented by [#154](https://github.com/ChipIn-one/.github/issues/154) in `automation/conformance.mjs`
and `.github/workflows/conformance-audit.yml`.

```bash
# read-only audit of everything (or --repository owner/name); writes artifacts, never Issues
GITHUB_TOKEN=... node automation/conformance.mjs audit --dir conformance --output conformance-report.json --summary conformance-summary.md
# plan, then apply, the drift Issues (apply needs --activate conformance-v1 and CHIPIN_CONFORMANCE_WRITE=1)
GITHUB_TOKEN=... node automation/conformance.mjs upsert --report conformance-report.json
```

## Result and severity

Per repository `conformance-<repo>.json` (`.github` is `conformance-dot-github.json`) plus the combined report and a job summary. Status: `CONFORMANT`, `DRIFT` (at least one `drift` finding) or
`UNREADABLE` (a read failed; the audit job fails, nothing is opened, edited or closed for that repository). Findings are either `drift` (counts, drives the Issue) or `note` (reported only).
Organization repositories that are not in the registry are listed once as `UNREGISTERED` in the summary (full runs only); no action is taken.

Repositories are audited on their **integration branch** (`branches.integration`). Meta repositories (`kind: meta`) host the shared actions, so the caller checks do not apply to them until they adopt `pr-gate` (#153).

`chipin-frontend` is audited on canonical `master` since [#216](https://github.com/ChipIn-one/.github/issues/216) (default = integration = `master`, no promotion branch): `requiredChecks: [frontend-ci]` must be enforced by the ruleset on `master`, Dependabot `github-actions` must target `master` (or the default branch), and `AGENTS.md` / `.ai/context.md` are read from `master`. Its record says `completion: deployment-receipt`, `capabilities.completion: automatic` and `completionRunner: org-sweep` since [#217](https://github.com/ChipIn-one/.github/issues/217) (owner decision: no FE completion caller), so `CALLER_MISSING` does not require a completion caller; instead `COMPLETION_SWEEP_MISSING` requires the org sweep `.github/workflows/frontend-production-completion.yml` to keep running `completion.mjs --repository ChipIn-one/chipin-frontend` on a schedule. If a `completion-action` caller is added anyway (immediate close), `COMPLETION_TRIGGER_MISSING` checks its triggers. A leftover `frontend-production-completion-action` caller is not a finding (the audit only checks required callers); it is removed in the frontend cutover ([chipin-frontend#497](https://github.com/ChipIn-one/chipin-frontend/issues/497)).

## Checks, remediation

| Check id | Severity | Meaning | Remediation |
| --- | --- | --- | --- |
| `CALLER_MISSING` | drift | a capability that is not `off` has no workflow using the matching `ChipIn-one/.github` action (`issue-admission-action` or `development-link-action` or `pr-gate` for admission; `development-link-action`/`pr-gate`; `pr-metadata-action`/`pr-gate` when `prMetadata: required`; `create-milestone-action`; `frontend-production-completion-action` for `completion: automatic` with strategy `production-merge`, `completion-action` for `integration-merge` and `deployment-receipt`; not for completion when the record says `completionRunner: org-sweep`) | add the caller ([onboarding](onboarding.md) step 2) |
| `COMPLETION_SWEEP_MISSING` | drift | `completionRunner: org-sweep` with `completion: automatic`: no workflow on the `ChipIn-one/.github` integration branch has a `schedule` trigger and a job step whose own `run:` key is `node automation/completion.mjs --repository <repository>` (repository optionally quoted, trailing comment allowed; text inside a block scalar or a nested key does not count), without a constant-false `if:` on the step or job, with `CHIPIN_COMPLETION_WRITE=1` and `CHIPIN_COMPLETION_AWAITING_RELEASE=1` and without `CHIPIN_COMPLETION_PROJECT_RECONCILE=0` (workflow, job or step env). The sweep replaces the repository caller ([completion.md](completion.md#deployment-receipt)). The shared workflows are read once per audit, only when an audited record uses `org-sweep`; a failed read makes only those records `UNREADABLE` | restore the org sweep, or set `completionRunner: repository` and add the caller |
| `COMPLETION_TRIGGER_MISSING` | drift | `completion: deployment-receipt` with `completion: automatic`: the workflow that uses `completion-action` (when there is one; with `org-sweep` it is optional) has no `deployment_status` or no `push` trigger in its top-level `on:` (the receipt event closes the Issue, the push writes `Awaiting release`; [completion.md](completion.md#deployment-receipt)) | use `templates/caller-completion-deployment-receipt.yml` |
| `PIN_NOT_SHA`, `PIN_NO_VERSION`, `PIN_VERSION_MISMATCH`, `PIN_UNTAGGED_SHA` | drift | pin is not a 40-character SHA, lacks the `# vX.Y.Z` comment, the comment disagrees with the tag of the SHA, or claims a version that is not a tag | pin the SHA of a published tag with its version comment |
| `PIN_STALE` | drift | a newer tag changes files the pinned capability uses (action directory, shared admission/registry/relationship modules; tests and `.md` files are ignored), or the pin is not on the history of the latest tag | bump to the latest tag (Dependabot or one PR) |
| `PIN_BEHIND` / `PIN_AHEAD_OF_TAG` | note | older than the latest tag but nothing relevant changed / newer than the latest tag | routine update / tag the commit |
| `PIN_UNKNOWN` | drift | the pinned SHA cannot be compared with the latest tag | pin a SHA of `ChipIn-one/.github` |
| `DEPENDABOT_MISSING`, `DEPENDABOT_NO_ACTIONS`, `DEPENDABOT_TARGET` | drift | no `dependabot.yml`, no `github-actions` ecosystem, or updates do not target the integration branch | add/fix it (weekly, `target-branch` = integration) |
| `ROUTING_BLOCK_MISSING`, `AI_CONTEXT_MISSING` | drift | no `ai-workflow:agents-routing` block in `AGENTS.md` / no `.ai/context.md` (when `agentRouting: required`) | add both ([onboarding](onboarding.md) step 5) |
| `REQUIRED_CHECKS_MISSING` | drift | registry `requiredChecks` are not enforced by a ruleset or classic branch protection on the integration branch | add them or fix the registry |
| `RULESET_NO_PULL_REQUEST` | drift | `protection: ruleset` but the ruleset has no `pull_request` rule | add the rule |
| `PROTECTION_MISSING` | drift | registry says `ruleset`/`protection` but nothing applies, or the plan forbids it | create it, or record `unavailable` |
| `PROTECTION_REGISTRY_STALE` | drift | registry says `unavailable` but the API now answers (plan upgraded) | create the ruleset and set `protection: ruleset` (#161) |
| `PROTECTION_UNAVAILABLE` | note | `protection: unavailable` as recorded (Free plan + private); required checks are advisory | upgrade to Team (#161) |
| `PROTECTION_MECHANISM` | note | enforced by classic protection while the registry says ruleset (or the reverse); the required checks are satisfied | align the registry or migrate |
| `PROTECTION_UNVERIFIABLE` | note | the audit token cannot read rulesets or classic protection, so required checks that were not found cannot be judged | grant administration:read or verify by hand |
| `CHECKS_UNVERIFIABLE` | note | neither check runs nor Actions jobs of the merged head are readable, so merges past a red required check could not be verified (the rest of the audit is valid) | grant the token `Actions: Read-only` (fine-grained tokens have no Checks permission; the audit falls back to Actions jobs) |
| `PROJECT_HAS_PULL_REQUESTS` | drift | pull requests are items of Project #5 | remove them and disable the built-in workflows that add them (#157) |
| `CLOSED_WITH_OPEN_PR` | drift | among the 100 most recently updated closed Issues, one has an open Development-linked PR | reopen the Issue or merge/close the PR; close only after the PR merged |
| `MERGED_PAST_RED_CHECK` | drift | for `protection: unavailable` with `requiredChecks`: a PR merged into the integration branch in the last 14 days had a failed/cancelled required check on its head | fix forward; enforce the check after the plan upgrade |
| `INTAKE_GAPS` | note | counts of open Issues without Type, Priority or Project #5 (or with duplicate items) | repair through the canonical intake writer with owner-approved values (#159) |

## Drift Issues

One Issue per non-conformant repository in `ChipIn-one/.github`: first line `Conformance: ChipIn-one/<repo>`, Type Task, assignee = the registry owner (a `docs` repository without an owner falls back to the owner of the
`.github` record), Priority P2, Project #5 Status `Backlog`, no labels, body with `## Problem`, `## Outcome` and one `## Acceptance` checkbox per finding. A rerun with the same findings changes nothing
(the audit time alone never rewrites the Issue); changed findings update the body; at zero drift the Issue is closed as completed and its Project Status is set to `Done` (the derived mirror). A new drift
episode after closure creates a new Issue; a second open Issue with the same marker is reported as a duplicate and never created.

## Rollout

Scheduled runs (Mondays 05:17 UTC) audit and only print the planned Issue actions until the repository variable `CONFORMANCE_AUDIT_APPLY` is `true`; a dispatch applies only with `apply=true`.
The audit reads other repositories with `CHIPIN_DEV_READ_TOKEN` (contents, rules, protection, checks, Project #5); a repository the token cannot read is `UNREADABLE`, never silently conformant.
Writes use the separate `CHIPIN_ISSUE_WRITE_TOKEN`.
