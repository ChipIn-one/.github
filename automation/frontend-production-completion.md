# Frontend production completion

This is the frontend-only terminal completion automation for `.github#40`.

The primary completion path is repository-local and event-driven: the frontend repository calls the shared completion action after a trusted push to production branch `main`, using only that repository's `GITHUB_TOKEN` with `issues: write`. That path deliberately skips Organization Project reads/writes. The privileged workflow in this repository remains the fallback/reconciliation path: it runs on trusted `master` pushes and on its scheduled cadence, uses `CHIPIN_ISSUE_WRITE_TOKEN`, and retains Project #5 reopen repair. It intentionally has no branch-selectable `workflow_dispatch`.

Both paths use native GitHub Development linkage as implementation identity. A frontend PR merged to `dev` is integration evidence only. The automation closes an open Issue as `completed` only after every Development-linked implementation PR has unambiguous production evidence.

For a PR merged to `dev`, production evidence means its merge commit is an ancestor of the exact `dev` head snapshot recorded by a merged same-repository `dev -> main` release PR. A canonically linked `dev -> main` PR is itself production evidence.

Fail-closed conditions include required native sub-issues that are not explicitly closed/completed, open native blockers, unreadable required relationships, remaining linked branches, missing/incomplete/cross-repository Development links, unmerged PRs, unsupported bases, unreadable merge evidence, missing ancestry, and Issue edits/reopens after all current implementation PRs merged. After an edit or reopen, at least one fresh linked implementation PR must merge before automatic completion is allowed again.

Before writing, the runner re-reads the Issue and abandons the terminal mutation if state or update time changed. The only Issue terminal mutation is `state=closed` with `state_reason=completed`; it never reopens manually closed Issues. When an Issue remains open but Project #5 still shows derived `Done`, the runner re-reads that project item and normalizes it to the documented deterministic fallback `In Progress`. Project Status is never used as completion evidence.

Milestone and Project #5 Status are not completion gates. Project Status is mutated only to repair the invalid `open + Done` reopen state; backend completion policy is out of scope.

The privileged fallback workflow uses the existing `CHIPIN_ISSUE_WRITE_TOKEN` through `CHIPIN_CANONICAL_WRITE_TOKEN`. The repository-local action accepts the frontend caller's `github.token` and disables Project reconciliation, so it needs no cross-repository or Organization Project secret.
