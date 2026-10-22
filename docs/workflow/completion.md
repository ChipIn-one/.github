# Completion policy

When automation closes a ChipIn Issue as completed. Owner decisions of the completion epic [#177](https://github.com/ChipIn-one/.github/issues/177), task [#179](https://github.com/ChipIn-one/.github/issues/179); the per-repository rule is the top-level `completion` field and `capabilities.completion` of each record in [`workflow-registry.yaml`](../../workflow-registry.yaml).

## Rules

1. **Native Issue state is the completion authority.** An Issue is complete when it is `closed` with `state_reason=completed`; Project #5 `Done` is only a derived mirror and is never completion evidence (see [`github-issue-schema.md`](../../github-issue-schema.md)).
2. **One engine, one strategy per repository.** [`automation/completion.mjs`](../../automation/completion.mjs) reads the registry record and runs only when `capabilities.completion: automatic`; the record's `completion` picks the strategy.
3. **Evidence is the native Development link plus merged PRs.** Plain references, closing keywords, branch names and Milestones are never evidence; every linked PR must be a same-repository PR with readable merge evidence.
4. **Fail closed.** Open blockers, incomplete sub-issues, ambiguous links, unmerged PRs, a scope change after the last merge or unreadable history leave the Issue open with a diagnostic code. Nothing is guessed.
5. **One mutation.** The engine only sets `state=closed`, `state_reason=completed`, after re-reading the Issue (`stale-snapshot` if it changed). It never reopens an Issue and never writes Project Status, except the existing repair of an open Issue still showing derived `Done` → `In Progress`, and only when Project reconciliation is on.
6. **Registry rule.** `capabilities.completion: automatic` is valid only with `completion: production-merge` or `integration-merge` (`AUTOMATIC_COMPLETION_STRATEGIES` in [`registry.mjs`](../../automation/registry.mjs)); anything else fails validation with `REGISTRY_VALUE`.
7. **Status is not an input.** The future `Awaiting release` Status ([#180](https://github.com/ChipIn-one/.github/issues/180)) is not part of this task; the engine does not read or write Status for its decision.

## Per repository

| Repository | Strategy | Where it runs | What closes the Issue |
| --- | --- | --- | --- |
| `chipin-frontend` | `production-merge` | Repository-local `frontend-production-completion-action` caller (push to `main`, repository token, Project repair off) and the privileged org fallback `.github/workflows/frontend-production-completion.yml` (Project repair on); unchanged by #179 | Every linked PR has production evidence: merged into `dev` and contained in a merged `dev -> main` release PR, or the canonical `dev -> main` PR itself. |
| `.github` | `integration-merge` | `.github/workflows/integration-completion.yml` (push to `master`, schedule every 30 min) | Every linked PR merged into `master` and its merge commit is still in the `master` head. |
| `chipin-knowledge-base` | `integration-merge` | Caller from `templates/caller-completion-integration.yml` (push to `master`), once adopted | Same as `.github`. |
| `chipin-backend` | `manual` | Nothing until [#156](https://github.com/ChipIn-one/.github/issues/156) | A human closes the Issue. |
| `chipin-notifications` | `manual` | Nothing | A human closes the Issue. |

## Strategies

### `production-merge` (frontend)

A merge to `dev` is integration evidence, not completion. A linked PR is production-complete when its merge commit is contained in the `dev` head snapshot recorded by a merged same-repository `dev -> main` release PR, or when the linked PR is itself the canonical `dev -> main` PR. The engine delegates to [`frontend-production-completion.mjs`](../../automation/frontend-production-completion.mjs) unchanged (rule and scope refinements: [`frontend-production-completion.md`](../../automation/frontend-production-completion.md)). The module is bound to `dev`/`main`; any other branch layout in the registry is refused with `STRATEGY_BRANCH_MISMATCH`.

### `integration-merge` (`.github`, knowledge base)

Every Development-linked PR must be a same-repository PR merged into `branches.integration`, and its merge commit must still be contained in the current head of that branch (checked with the compare API). A merge commit no longer reachable from the head (force-push, history rewrite) gives `integration-history-diverged`. The scope-freshness rule of [#178](https://github.com/ChipIn-one/.github/issues/178) applies unchanged.

### `deployment-receipt`

Declared in the registry vocabulary, not implemented. The registry rejects `capabilities.completion: automatic` with it; the engine stops with `STRATEGY_NOT_IMPLEMENTED`.

### `manual`

No automation. With `capabilities.completion: manual` the engine refuses to run (`COMPLETION_NOT_AUTOMATIC`).

## When the engine leaves an Issue open

| Code | Meaning | What a human does |
| --- | --- | --- |
| `already-closed` | The Issue is closed (manual close is preserved). | Nothing; reopen by hand if the close was wrong. |
| `required-relationships-unreadable` | Sub-issues or `blocked by` could not be read. | Check token permissions; the next run retries. |
| `required-sub-issue-incomplete` | A native sub-issue is not `closed/completed`. | Finish or close the sub-issue. |
| `blocked-by-open-issue` | A native blocker is still open. | Resolve the blocker or remove the relationship. |
| `development-branch-pending` | Development lists linked branches. | Open a PR for the work or unlink the branch. |
| `missing-development` | No native Development-linked PR. | Link the PR in Development (`Task identity:` line + development-link caller). |
| `ambiguous-development` | Incomplete pagination, duplicate or cross-repository PR, unsupported base. | Fix the links; cross-repository work is closed by hand. |
| `implementation-not-merged` | A linked PR is not merged or its merge commit is unreadable. | Merge or unlink the PR. |
| `awaiting-production` | FE only: merged to `dev`, not yet in a merged release PR. | Merge the `dev -> main` release PR. |
| `ambiguous-production` | FE only: release evidence cannot be resolved unambiguously. | Inspect the release PR; close by hand if justified. |
| `integration-history-diverged` | `integration-merge` only: merge commit not in the branch head. | Decide by hand whether the work still ships. |
| `scope-history-unreadable` | Timeline or body edit history incomplete or unreadable. | Check token scope; close by hand if justified. |
| `scope-changed-after-implementation` | Reopen, body text edit or title change after the last merge (#178: a reopen undoing an early manual close and checkbox-only edits are ignored; a rename always counts). | Link and merge a fresh implementation PR, or close by hand. |
| `stale-snapshot` | The Issue changed between evaluation and close. | Nothing; the next run re-evaluates. |

## Engine

```bash
CHIPIN_COMPLETION_WRITE=1 CHIPIN_CANONICAL_WRITE_TOKEN=<token> [CHIPIN_COMPLETION_PROJECT_RECONCILE=0] \
  node automation/completion.mjs --repository ChipIn-one/<repo> [--output receipt.json]
```

- `CHIPIN_COMPLETION_WRITE=1` and a token are mandatory; `--repository` falls back to `GITHUB_REPOSITORY`.
- `CHIPIN_COMPLETION_PROJECT_RECONCILE=0` disables Project #5 reads and writes. Repository-local runs always set it, because a repository `GITHUB_TOKEN` cannot read org Projects; only the privileged frontend fallback (PAT) keeps the `open + Done` repair.
- Receipt (`--output`): `contract: chipin-completion/v1`, `repository`, `strategy`, `branch`, `projectNumber`, `projectReconciliation`, `results[]` (`issue`, `decision.action` / `code` / `detail`). The Markdown summary goes to stdout and to the step summary.
- A blocked run (`COMPLETION_NOT_AUTOMATIC`, `STRATEGY_NOT_IMPLEMENTED`, `STRATEGY_BRANCH_MISMATCH`, unreadable branch head, API failure) exits 1. Issues left open are a normal result.

Paths:

- Composite action [`automation/completion-action`](../../automation/completion-action/action.yml): input `token` (repository token with `issues: write`), Project repair off.
- Org workflow [`.github/workflows/integration-completion.yml`](../../.github/workflows/integration-completion.yml): `.github` itself, push to `master` and schedule, repository `GITHUB_TOKEN`, Project repair off, no `workflow_dispatch`.
- [`.github/workflows/native-development-link.yml`](../../.github/workflows/native-development-link.yml): gives `.github` PRs the Development link (PR body line `Task identity: ChipIn-one/.github#N`; the Issue must pass admission).
- Template [`templates/caller-completion-integration.yml`](../../templates/caller-completion-integration.yml): KB-like callers, the action pinned to an org tag SHA, repository token. KB already has its development-link caller.

## Rollout

| Step | Task |
| --- | --- |
| Scope-change refinements of the frontend policy | [#178](https://github.com/ChipIn-one/.github/issues/178), merged in [#194](https://github.com/ChipIn-one/.github/pull/194) |
| Shared engine, `integration-merge`, `.github` and KB set to automatic, this page | [#179](https://github.com/ChipIn-one/.github/issues/179) |
| `Awaiting release` Status | [#180](https://github.com/ChipIn-one/.github/issues/180) |
| Frontend pin bump of the completion action | [chipin-frontend#479](https://github.com/ChipIn-one/chipin-frontend/issues/479) |
| Knowledge base adopts the completion caller | follow-up after a tag with #179 |
| Backend completion decision | [#156](https://github.com/ChipIn-one/.github/issues/156) |
