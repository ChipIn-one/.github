# Frontend production completion

This is the frontend-only terminal completion automation for `.github#40`.

The scheduled workflow runs every 15 minutes and may also be rerun manually. It uses native GitHub Development linkage as implementation identity. A frontend PR merged to `dev` is integration evidence only. The automation closes an open Issue as `completed` only after every Development-linked implementation PR has unambiguous production evidence.

For a PR merged to `dev`, production evidence means its merge commit is an ancestor of the exact `dev` head snapshot recorded by a merged same-repository `dev -> main` release PR. A canonically linked `dev -> main` PR is itself production evidence.

Fail-closed conditions include open required native sub-issues, open native blockers, unreadable required relationships, remaining linked branches, missing/incomplete/cross-repository Development links, unmerged PRs, unsupported bases, unreadable merge evidence, missing ancestry, and Issue edits/reopens after all current implementation PRs merged. After an edit or reopen, at least one fresh linked implementation PR must merge before automatic completion is allowed again.

Before writing, the runner re-reads the Issue and abandons the mutation if state or update time changed. The only terminal mutation is `state=closed` with `state_reason=completed`. It never reopens manually closed Issues.

Milestone and Project #5 Status are not completion gates and are never mutated. Backend completion policy is out of scope.

The workflow uses the existing `CHIPIN_ISSUE_WRITE_TOKEN` through `CHIPIN_CANONICAL_WRITE_TOKEN`.
