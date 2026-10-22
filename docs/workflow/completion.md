# Completion policy

When automation closes a ChipIn Issue as completed. Owner decisions of the completion epic [#177](https://github.com/ChipIn-one/.github/issues/177), task [#179](https://github.com/ChipIn-one/.github/issues/179); the per-repository rule is the top-level `completion` field and `capabilities.completion` of each record in [`workflow-registry.yaml`](../../workflow-registry.yaml).

## Rules

1. **Native Issue state is the completion authority.** An Issue is complete when it is `closed` with `state_reason=completed`; Project #5 `Done` is only a derived mirror and is never completion evidence (see [`github-issue-schema.md`](../../github-issue-schema.md)).
2. **One engine, one strategy per repository.** [`automation/completion.mjs`](../../automation/completion.mjs) reads the registry record and runs only when `capabilities.completion: automatic`; the record's `completion` picks the strategy.
3. **Evidence is the native Development link plus merged PRs.** The engine reads GitHub's native `closedByPullRequestsReferences` (Development links), which GitHub also creates from closing keywords in a PR body; the engine never parses text itself, and plain references, branch names and Milestones are never evidence. Every linked PR must be a same-repository PR (`headRepository` and base repository are the Issue's repository) with readable merge evidence. Project convention: PRs carry a `Task identity:` line and no closing keywords, so the link is created by the development-link reconciler, not by keyword inference.
4. **Fail closed.** Open blockers, incomplete or invisible sub-issues, ambiguous links, unmerged PRs, a scope change after the last merge or unreadable history leave the Issue open with a diagnostic code. Nothing is guessed.
5. **One mutation.** The engine only sets `state=closed`, `state_reason=completed`, after re-reading the Issue (`stale-snapshot` if it changed). It never reopens an Issue and never writes Project Status, except the existing repair of an open Issue still showing derived `Done` → `In Progress` and, for `production-merge`, `Todo`/`In Progress` → `Awaiting release` ([below](#awaiting-release-frontend)), both only when Project reconciliation is on.
6. **Registry rule.** `capabilities.completion: automatic` is valid only with `completion: production-merge` or `integration-merge` (`AUTOMATIC_COMPLETION_STRATEGIES` in [`registry.mjs`](../../automation/registry.mjs)); anything else fails validation with `REGISTRY_VALUE`.
7. **Status is not an input.** The engine never reads Project Status for its close decision; `Todo`, `In Progress`, `Awaiting release` and `Done` neither allow nor block a close. For `production-merge` it writes `Awaiting release` after the decision ([#180](https://github.com/ChipIn-one/.github/issues/180), [below](#awaiting-release-frontend)); `integration-merge` never writes it, because the merge itself is terminal.
8. **Schema wording.** [`github-issue-schema.md`](../../github-issue-schema.md) says "Completion triggers per repository are defined by the registry `completion` strategy" and points here (owner-approved in #180).

## Native auto-close and the engine

In `.github` and `chipin-knowledge-base` the integration branch is the default branch, so GitHub itself closes a linked Issue about 2 s after a linked PR merges into it (KB Issues #28, #32, #33, #35 and #41 were closed this way). That native close checks none of the engine's gates: open blockers, incomplete sub-issues and scope changes are ignored.

- The repository setting **Settings → General → Issues → "Auto-close issues with merged linked pull requests"** must be **disabled** in every `integration-merge` repository, so that the engine, with its fail-closed gates, is the only closer.
- Disabling it is an owner action tracked in [#179](https://github.com/ChipIn-one/.github/issues/179); no automation changes repository settings.
- Until it is disabled, GitHub closes first and the engine only acts on leftovers: Issues linked after the merge and Issues whose native close was prevented.

**This page describes the engine with the setting disabled.**

## Per repository

| Repository | Strategy | Where it runs | What closes the Issue |
| --- | --- | --- | --- |
| `chipin-frontend` | `production-merge` | Repository-local `frontend-production-completion-action` caller (push to `main`, repository token, Project repair off) and the privileged org fallback `.github/workflows/frontend-production-completion.yml` (`completion.mjs --repository ChipIn-one/chipin-frontend`, push to `master` and schedule every 15 min, org write PAT, Project repair and `Awaiting release` on) | Every linked PR has production evidence: merged into `dev` and contained in a merged `dev -> main` release PR, or the canonical `dev -> main` PR itself. |
| `.github` | `integration-merge` | `.github/workflows/integration-completion.yml` (push to `master`, schedule every 30 min, org write PAT, Project repair on); PRs get their Development link from `.github/workflows/native-development-link.yml` (`Task identity:` line; pinned to the current org tag SHA) | Every linked PR merged into `master` and its merge commit is still in the `master` head. Today GitHub's native auto-close closes first (see above). |
| `chipin-knowledge-base` | `integration-merge` | Caller from `templates/caller-completion-integration.yml` (push to `master`, repository token), once adopted | Same as `.github`. Today GitHub's native auto-close closes KB Issues on merge; the engine takes over once the setting is disabled and the caller is adopted. |
| `chipin-backend` | `manual` | Nothing until [#156](https://github.com/ChipIn-one/.github/issues/156) | A human closes the Issue. |
| `chipin-notifications` | `manual` | Nothing | A human closes the Issue. |

## Strategies

### `production-merge` (frontend)

A merge to `dev` is integration evidence, not completion. A linked PR is production-complete when its merge commit is contained in the `dev` head snapshot recorded by a merged same-repository `dev -> main` release PR, or when the linked PR is itself the canonical `dev -> main` PR. The engine delegates to [`frontend-production-completion.mjs`](../../automation/frontend-production-completion.mjs) unchanged (rule and scope refinements: [`frontend-production-completion.md`](../../automation/frontend-production-completion.md)). The module is bound to `dev`/`main`; any other branch layout in the registry is refused with `STRATEGY_BRANCH_MISMATCH`. A reopen that undoes an early manual close made after the merge is ignored here, because the release comes later.

### Awaiting release (frontend)

Project #5 Status `Awaiting release` ([#180](https://github.com/ChipIn-one/.github/issues/180)) shows that the work is merged into `dev` and waits for the `dev -> main` release. It is display only: nothing closes an Issue because of it, and the close still follows the production evidence above.

- **Writer.** [`completion.mjs`](../../automation/completion.mjs) (`reconcileAwaitingRelease` / `setAwaitingReleaseStatus`), after the `production-merge` sweep, when Project reconciliation is on and `CHIPIN_COMPLETION_AWAITING_RELEASE=1`. Only the org workflow [`.github/workflows/frontend-production-completion.yml`](../../.github/workflows/frontend-production-completion.yml) sets it, with the org write PAT; the repository-local `frontend-production-completion-action` cannot (a repository token cannot write the org Project). The built-in Project workflows stay disabled for this purpose ([#157](https://github.com/ChipIn-one/.github/issues/157)). The fallback runs only while the frontend registry record says `capabilities.completion: automatic`; the engine refuses any other record (`COMPLETION_NOT_AUTOMATIC`), so the Awaiting release writer depends on it too.
- **Which Issues.** Only results with the decision `awaiting-production`: every linked PR merged into `dev`, none yet contained in a merged `dev -> main` release PR, and all other gates passed. The writer re-verifies every linked PR and the scope-freshness rule itself (`evaluateAwaitingReleaseCandidate`), because the `awaiting-production` code alone is not sufficient (the frontend evaluator stops at the first unreleased PR); a candidate that fails is left unchanged as `awaiting-release-skipped:<code>`. Other decision codes never change Status (the existing `open + Done → In Progress` repair keeps running inside the frontend sweep, unchanged).
- **Transition.** The Project #5 snapshot is read once per run (only when there is a candidate), with the same membership checks as the `Done` repair (`project-membership-missing`, `project-membership-ambiguous`); the item's Status is read fresh. `Todo` or `In Progress` → `Awaiting release`, then read back (a missing or ambiguous `Awaiting release` option stops the run before any write; a read-back mismatch or another per-Issue error is recorded as `awaiting-release-failed: …`, the run continues and exits 1 after the summary). `Awaiting release` → no-op (`awaiting-release-current`), so a rerun writes nothing. `Done`, `Backlog`, any other value or no Status → left untouched (`awaiting-release-skipped:<status>`, `none` for no Status).
- **Stale rule.** Right before the write the Issue is re-read; when it is no longer open (`issue-no-longer-open`) or its `updated_at` differs from the snapshot (`stale-snapshot`) nothing is written and the next run retries.
- **Order with the `Done` repair.** An open `awaiting-production` Issue that still shows derived `Done` is first repaired to `In Progress` by the frontend sweep, then moved to `Awaiting release` in the same run.
- **After the release.** The close (`closed/completed`) happens as before; `Done` stays the derived mirror of the close, so `Awaiting release` turns into `Done` the same way `In Progress` did.
- **Latency.** The Status is written by the `.github` sweep (push to `master` and the schedule every 15 minutes), not by a frontend event, so `Awaiting release` appears within about 15 minutes of the merge into `dev`.
- **Receipt.** `awaitingRelease: { enabled, updated: [Issue numbers], skipped: n, failed: [Issue numbers] }` (`skipped` counts every `awaiting-production` Issue left unchanged, including `awaiting-release-current`); the outcome code is appended to the Issue's `decision.detail` and the summary shows `Awaiting release: on (set N, unchanged M, failed K)`.

### `integration-merge` (`.github`, knowledge base)

Every Development-linked PR must be a same-repository PR (`headRepository` is the repository; a merged fork PR gives `ambiguous-development`) merged into `branches.integration`, and its merge commit must still be contained in the current head of that branch (checked with the compare API). A merge commit no longer reachable from the head (force-push, history rewrite) gives `integration-history-diverged`; a failed compare or read gives `integration-evidence-unreadable` for that Issue only.

Sub-issues fail closed: the engine compares the Issue's `sub_issues_summary.total` with the sub-issues it could list; a mismatch (private cross-repository sub-issues hidden from the token) or a missing summary gives `required-relationships-unreadable`.

Scope freshness is stricter than #178. There is no later release: a merge into the integration branch is the terminal evidence, so **any reopen after the last merge counts as a scope change** (`scope-changed-after-implementation`, reason `reopened at …`). The engine never closes a reopened Issue again until a fresh linked PR merges. Checkbox-only body edits are still ignored; a title rename still counts.

### `deployment-receipt`

Declared in the registry vocabulary, not implemented. The registry rejects `capabilities.completion: automatic` with it; the engine stops with `STRATEGY_NOT_IMPLEMENTED`.

### `manual`

No automation. With `capabilities.completion: manual` the engine refuses to run (`COMPLETION_NOT_AUTOMATIC`).

## When the engine leaves an Issue open

`integration-complete` is the internal decision code; the summary and receipt show `closed-completed` once the close succeeds.

| Code | Meaning | What a human does |
| --- | --- | --- |
| `closed-completed` | The Issue was closed as completed by the engine. | Nothing. |
| `already-closed` | The Issue is closed (manual or native close is preserved). | Nothing; reopen by hand if the close was wrong. |
| `required-relationships-unreadable` | Sub-issues or `blocked by` could not be read, or `sub_issues_summary` is missing or does not match the listed sub-issues. | Check token permissions; the next run retries. |
| `required-sub-issue-incomplete` | A native sub-issue is not `closed/completed`. | Finish or close the sub-issue. |
| `blocked-by-open-issue` | A native blocker is still open. | Resolve the blocker or remove the relationship. |
| `development-branch-pending` | Development lists linked branches. | Open a PR for the work or unlink the branch. |
| `missing-development` | No native Development-linked PR. | Link the PR in Development (`Task identity:` line + development-link caller, or by hand in the PR sidebar). |
| `ambiguous-development` | Incomplete pagination, duplicate, cross-repository or fork PR, unsupported base. | Fix the links; cross-repository work is closed by hand. |
| `implementation-not-merged` | A linked PR is not merged or its merge commit is unreadable. | Merge or unlink the PR. |
| `awaiting-production` | FE only: merged to `dev`, not yet in a merged release PR. With the writer on, Project Status moves to `Awaiting release` (outcome appended to the diagnostic). | Merge the `dev -> main` release PR. |
| `ambiguous-production` | FE only: release evidence cannot be resolved unambiguously. | Inspect the release PR; close by hand if justified. |
| `integration-history-diverged` | `integration-merge` only: merge commit not in the branch head. | Decide by hand whether the work still ships. |
| `integration-evidence-unreadable` | `integration-merge` only: the compare or a read failed for this Issue; the Issue is skipped, the sweep continues. | Nothing; the next run retries. |
| `scope-history-unreadable` | Timeline or body edit history incomplete or unreadable. | Check token scope; close by hand if justified. |
| `scope-changed-after-implementation` | Reopen, body text edit or title change after the last merge. Checkbox-only edits are ignored and a rename always counts; FE (#178) also ignores a reopen undoing an early manual close, `integration-merge` counts every reopen. | Link and merge a fresh implementation PR, or close by hand. |
| `stale-snapshot` | The Issue changed between evaluation and close. | Nothing; the next run re-evaluates. |

## Engine

```bash
CHIPIN_COMPLETION_WRITE=1 CHIPIN_CANONICAL_WRITE_TOKEN=<token> [CHIPIN_COMPLETION_PROJECT_RECONCILE=0] [CHIPIN_COMPLETION_AWAITING_RELEASE=1] \
  node automation/completion.mjs --repository ChipIn-one/<repo> [--output receipt.json]
```

- `CHIPIN_COMPLETION_WRITE=1` and a token are mandatory; `--repository` falls back to `GITHUB_REPOSITORY`.
- `CHIPIN_COMPLETION_PROJECT_RECONCILE=0` disables Project #5 reads and writes. Repository-local runs always set it, because a repository `GITHUB_TOKEN` cannot read org Projects; the org-PAT runs (frontend fallback and `.github`) keep the `open + Done` repair.
- `CHIPIN_COMPLETION_AWAITING_RELEASE=1` turns on the `Awaiting release` writer; it has an effect only for `production-merge` with Project reconciliation on (the frontend org fallback sets it; `.github` and the composite action do not).
- Receipt (`--output`): `contract: chipin-completion/v1`, `repository`, `strategy`, `branch`, `projectNumber`, `projectReconciliation`, `awaitingRelease` (`enabled`, `updated`, `skipped`), `results[]` (`issue`, `decision.action` / `code` / `detail`). The Markdown summary goes to stdout and to the step summary.
- A blocked run (`COMPLETION_NOT_AUTOMATIC`, `STRATEGY_NOT_IMPLEMENTED`, `STRATEGY_BRANCH_MISMATCH`, unreadable branch head, API failure) exits 1. Issues left open are a normal result.

### Token and visibility

The engine sees only what its token sees. Hidden sub-issues are caught by the `sub_issues_summary` check, but blockers in repositories the token cannot read are **not** detectable: the `blocked by` list simply omits them. The org PAT sees private BE and KB blockers and sub-issues. A repository token sees only its own repository, so a KB Issue blocked only by a private BE Issue could be closed; the owner may later supply an org read token to the KB caller (future option, not part of #179).

Paths:

- Composite action [`automation/completion-action`](../../automation/completion-action/action.yml): input `token` (repository token with `issues: write`), Project repair off.
- Org workflow [`.github/workflows/integration-completion.yml`](../../.github/workflows/integration-completion.yml): `.github` itself, push to `master` and schedule, no `workflow_dispatch`. It passes the org write PAT `CHIPIN_ISSUE_WRITE_TOKEN` as `CHIPIN_CANONICAL_WRITE_TOKEN`, like the frontend fallback, so it sees private BE/KB blockers and sub-issues and keeps Project #5 reconciliation on; the workflow's own `permissions` are `contents: read` only.
- Org workflow [`.github/workflows/frontend-production-completion.yml`](../../.github/workflows/frontend-production-completion.yml): the frontend fallback, push to `master` and schedule every 15 minutes, no `workflow_dispatch`, org write PAT as `CHIPIN_CANONICAL_WRITE_TOKEN`; runs `completion.mjs --repository ChipIn-one/chipin-frontend` with `CHIPIN_COMPLETION_AWAITING_RELEASE=1` and Project #5 reconciliation on.
- Template [`templates/caller-completion-integration.yml`](../../templates/caller-completion-integration.yml): KB-like callers, the action pinned to an org tag SHA, repository token (`github.token`, limitation above). KB already has its development-link caller.
- [`development-link.mjs`](../../automation/development-link.mjs) accepts `meta` repositories since `v1.3.0`, so `Task identity: ChipIn-one/.github#N` parses; [`.github/workflows/native-development-link.yml`](../../.github/workflows/native-development-link.yml) is the `.github` caller (same shape as the frontend and knowledge-base callers, `workflow_dispatch` with the exact head SHA for a PR opened before the caller existed).

## Rollout

| Step | Task |
| --- | --- |
| Scope-change refinements of the frontend policy | [#178](https://github.com/ChipIn-one/.github/issues/178), merged in [#194](https://github.com/ChipIn-one/.github/pull/194) |
| Shared engine, `integration-merge`, `.github` and KB set to automatic, this page | [#179](https://github.com/ChipIn-one/.github/issues/179) |
| Disable native auto-close in `.github` and KB (owner) | [#179](https://github.com/ChipIn-one/.github/issues/179) |
| `Awaiting release` Status (contracts, writer in `completion.mjs`, frontend org workflow on the shared engine) | [#180](https://github.com/ChipIn-one/.github/issues/180) |
| Frontend pin bump of the completion action | [chipin-frontend#479](https://github.com/ChipIn-one/chipin-frontend/issues/479) |
| Org pin bump to `v1.3.0` + `.github` development-link caller | [#179](https://github.com/ChipIn-one/.github/issues/179) follow-up PR |
| Knowledge base adopts the completion caller | follow-up after a tag with #179 |
| Backend completion decision | [#156](https://github.com/ChipIn-one/.github/issues/156) |
