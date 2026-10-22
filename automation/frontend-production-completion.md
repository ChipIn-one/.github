# Frontend production completion

This is the frontend-only terminal completion automation for `.github#40`.

Since `.github#179` this module is also the `production-merge` strategy of the shared completion engine `completion.mjs` (see [docs/workflow/completion.md](../docs/workflow/completion.md)), which delegates to it for `ChipIn-one/chipin-frontend`. Its behaviour, entry points and tests are unchanged.

Since `.github#216` the frontend registry record is canonical `master` with `completion: deployment-receipt` (engine on since `.github#217`, run only by the org sweep `.github/workflows/frontend-production-completion.yml`), so the shared engine no longer delegates here; the module and its dev/main rules stay for the rollback record of the cutover window (chipin-frontend#497). The composite `frontend-production-completion-action` runs this module directly and does not read the registry: its repository-local caller in `chipin-frontend` (`.github/workflows/frontend-production-completion.yml`, push to `main`) stays only on the frozen `main` rollback ref and is removed from `master` by the FE cutover PR; pushes to `main` are frozen during the 14-day rollback window. Rollback of the registry side is a `git revert` of the whole `.github#216` commit.

The rest of this page describes the legacy dev/main rollback record only (`production-merge`); it is not how the live canonical-`master` frontend completes (that is `deployment-receipt` through the org sweep, docs/workflow/completion.md). In that legacy record the primary completion path is repository-local and event-driven: the frontend repository calls the shared completion action after a trusted push to production branch `main`, using only that repository's `GITHUB_TOKEN` with `issues: write`. That path deliberately skips Organization Project reads/writes. The privileged workflow in this repository remains the fallback/reconciliation path: it runs on trusted `master` pushes and on its scheduled cadence, uses `CHIPIN_ISSUE_WRITE_TOKEN`, and retains Project #5 reopen repair. It intentionally has no branch-selectable `workflow_dispatch`.

Both paths use native GitHub Development linkage as implementation identity. A frontend PR merged to `dev` is integration evidence only. The automation closes an open Issue as `completed` only after every Development-linked implementation PR has unambiguous production evidence.

For a PR merged to `dev`, production evidence means its merge commit is an ancestor of the exact `dev` head snapshot recorded by a merged same-repository `dev -> main` release PR. A canonically linked `dev -> main` PR is itself production evidence.

Fail-closed conditions include required native sub-issues that are not explicitly closed/completed, open native blockers, unreadable required relationships, remaining linked branches, missing/incomplete/cross-repository Development links, unmerged PRs, unsupported bases, unreadable merge evidence, missing ancestry, and scope changes after all current implementation PRs merged. After a scope change, at least one fresh linked implementation PR must merge before automatic completion is allowed again.

Scope changes are read from native history (`.github#178`), not guessed from `lastEditedAt` alone:

- a **reopen** is ignored when the close it reverts happened after every PR that had merged by then (an early manual close after the merge to `dev`, undone so that automation can finish after the release); a reopen whose preceding close was before the merge, or with another merge between the close and the reopen, still counts as a scope change;
- a **body edit** counts only when the text changed beyond `- [ ]` / `- [x]` checkbox toggles, compared revision by revision through the Issue edit history (`userContentEdits`);
- a **title change** always counts.

Boundary rule: a close in the same second as the last merge (the shape a closing keyword produces) still counts as "after the merge", so the reopen that reverts it is ignored; a merge in the same second as a reopen counts as merged before the reopen and does not refresh evidence. The edit history must contain the original body (`includesCreatedEdit`, earliest revision at `createdAt`); otherwise it is unreadable.

The timeline (closed, reopened, renamed events, `last: 100` per Issue, so the candidate query cost grows with the number of open Issues) is read with the candidate list; the edit history is read only for an edited Issue whose implementation evidence is otherwise complete. The repository-local action reads it with the caller's `GITHUB_TOKEN`; if that token cannot read `userContentEdits` the Issue stays open as `scope-history-unreadable` (fail closed), never closed. A truncated timeline, a deleted or missing revision, a revision set that does not match `lastEditedAt`, or an edit made while the sweep runs leaves the Issue open with `scope-history-unreadable`.

Before writing, the runner re-reads the Issue and abandons the terminal mutation if state or update time changed. The only Issue terminal mutation is `state=closed` with `state_reason=completed`; it never reopens manually closed Issues. When an Issue remains open but Project #5 still shows derived `Done`, the runner re-reads that project item and normalizes it to the documented deterministic fallback `In Progress`. Project Status is never used as completion evidence.

Milestone and Project #5 Status are not completion gates. Project Status is mutated only to repair the invalid `open + Done` reopen state; backend completion policy is out of scope.

The privileged fallback workflow uses the existing `CHIPIN_ISSUE_WRITE_TOKEN` through `CHIPIN_CANONICAL_WRITE_TOKEN`; since .github#180 it runs this module through the shared engine `completion.mjs --repository ChipIn-one/chipin-frontend`, which afterwards sets `Awaiting release` for `awaiting-production` Issues ([docs/workflow/completion.md](../docs/workflow/completion.md)); this module itself is unchanged. The repository-local action accepts the frontend caller's `github.token` and disables Project reconciliation, so it needs no cross-repository or Organization Project secret.
