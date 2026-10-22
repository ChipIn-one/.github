# PR metadata reconciliation — FE #381

FE-only rollout. Reuses shared GitHubClient from github-metadata.mjs and the existing native Development linker, which verifies userLinkedOnly relationship read-back. No backend or KB workflow is enabled.

## Contract

Implementation PR: same-repo source → dev, **one** exact "Task identity: ChipIn-one/chipin-frontend#381" body line. Native link is required and read back; free-text mentions, matching numbers, branch names and closing keywords are never substitutes. Single-Issue implementation identity only; multi-Issue implementation PRs are intentionally unsupported and fail closed.

Release PR: same-repo dev → main, no "Task identity" marker. Body includes one each of:
- "Included implementation PRs: ChipIn-one/chipin-frontend#123, ChipIn-one/chipin-frontend#124"
- "Included Issues: ChipIn-one/chipin-frontend#21, ChipIn-one/chipin-frontend#22"

The referenced implementation PRs must be merged into dev; their Task identities must exactly match the listed Issue set. Existing #379 release source policy and CI reject closing keywords. Use non-closing references only. Keep both PR bodies concise with **## Summary**, **## Tests**, **## Version impact**, **## Dependencies**. Missing headings are diagnosed, not filled with unverified claims. Human-written PR body, title and manual labels are never overwritten.

## Ownership and review

Existing PR assignees and requested human/team reviewers are retained. For an otherwise unassigned implementation PR, precisely one Issue assignee is an acceptable owner; otherwise use the explicitly selected implementationOwner (`syllik`, as required for FE by #53) when present in multiple native Issue assignees. Additional human Issue owners are preserved; ambiguous owners lacking approved selection block. The approved releaseOwner is `syllik`; do not infer PR authors or replace human-selected assignees. Author fallback is opt-in and disabled. GitHub assignability is checked before adding an assignee.

Requested reviewers use a **separate approved list**, currently empty by design because there is only one maintainer. Never self-request or fabricate a reviewer. If a distinct reviewer is later explicitly approved, validate collaborator write-or-higher permission. A review request is permitted only after **all** required checks of the target branch are successful on the exact PR head SHA and current base revision.

Required checks are the union of classic branch protection (`GET /branches/{branch}`) and active rulesets (`GET /rules/branches/{branch}`, rules of type `required_status_checks`); a ruleset-only branch reports no checks on the branch endpoint, so both are read. Identical context/app pairs from several sources count once; the same context with a different app is ambiguous. The union must be non-empty, and every check must be in the trusted map with the GitHub Actions app (id 15368) as producer: `frontend-ci` → `.github/workflows/frontend-ci.yml` for target `master` or `dev`, `main-ci` → `.github/workflows/main-ci.yml` for target `main` (`dev`/`main` stay until the rollback window of chipin-frontend#497 ends). Each check must come from that workflow's run linked to this PR. Ruleset rules of type `workflows` or `code_scanning` also gate merges but are not verified here, so their presence fails closed; other rule types are ignored.

Missing/pending/failing/stale results, a changed required-check policy, an unexpected workflow or unreadable run fail closed. `frontend-ci=success` does not authorize release review while required `main-ci` fails or is pending. Existing reviewer requests remain untouched. This does not approve review or invoke paid review bots.

Taxonomy: additive pr:implementation / pr:release category label, no duplication of Issue Priority/Severity/Type/Milestone/Project Status. Frontend is implicit in FE-only rollout. Missing category labels are created deterministically. Read-back required.

Project #5: exclusively written by the trusted .github Project worker using CHIPIN_ISSUE_WRITE_TOKEN; FE cannot read or write org Project membership. The worker performs a fresh canonical admission check, native Development/release verification, SHA/body re-read and idempotent one-item Project read-back. No PR Project Status changes. The Issue remains authoritative for completed/open; no Issue state write anywhere in this reconciler, and existing Issue Project memberships are not modified.

## Deployment and blocker policy

Trusted FE pull_request metadata events only: opened, edited, reopened, synchronize, ready_for_review; manual workflow_dispatch retry. No PR-head code checkout. Shared composite action pinned to exact commit. Serialized per PR. FE uses its local GITHUB_TOKEN (PR/Issue metadata) and CHIPIN_DEV_READ_TOKEN (read-only canonical admission). No org Project credential is ever copied into FE. The .github scheduled/manual Project reconciler alone uses org CHIPIN_ISSUE_WRITE_TOKEN, performs a fresh positive Issue admission and complete one-item read-back. Missing org permissions block Project writes. Review requests are deferred until current-SHA CI; do not pay for bot review on metadata events. New FE implementation/release PRs require live admission/native-link receipt and separate org Project item read-back. Human-only merges remain unchanged, and independent code review does not impersonate native GitHub approval.

## Dependabot skip — #138

Automated dependency PRs never carry a Task identity, so the reconciler treats a PR whose author is `dependabot[bot]` **or** whose head branch matches `dependabot/**` as an explicit SKIP, not a BLOCK. `reconcilePR` returns `{status:"SKIPPED", kind:"dependabot", ...}` right after the PR read, before the head-SHA gate (a dependabot rebase must not become a `SHA:` failure either) and before any admission, Development-link, label, owner, reviewer or Project step. The CLI prints `PR METADATA SKIPPED: ...` plus a `::notice::` annotation and exits 0. The skip grants nothing: no `pr:*` category label is written, so the org Project writer never admits a dependabot PR, and merges remain human-only. Every other PR without exactly one Task identity line is still blocked. The FE caller additionally filters `dependabot[bot]` on `pull_request` events; the shared skip is what covers the `workflow_run` path and must be picked up by bumping the action pin.

## Admission dependency — org #53

This #381 reconciler is not a replacement for canonical issue intake. The shared `automation/issue-intake.mjs` and its versioned fresh `INTAKE_COMPLETE` read-back remain sole admission authority. Org #53 is deployed in the shared org, FE dev and FE main. Each current task publication/handoff and release acceptance must fail closed without a fresh read-only gate; an Issue URL or a queued connector bridge event is not a valid receipt. The existing #381 Issue is a scoped pre-#53 bootstrap; do not bulk-fix historic tasks or silently manufacture receipts. The PR metadata adapter never writes Issue Type/Priority/Severity/Status.

## Audit reproduction

`node --test evidence/pr54-ci-gate-reproduction.test.mjs` reproduces and guards the former `frontend-ci=success` / required `main-ci=failure/pending` release reviewer bypass. The same cases run via `automation/pr-metadata.test.mjs`. Review cycle is bounded to one independent current-SHA review and no more than two correction batches; requested human reviewers and prior same-SHA reviews are never deleted or multiplied.


## Trusted Project writer (#381 variant B)

The .github workflow `.github/workflows/pr-metadata-project-reconcile.yml` polls current open FE PRs every 15 minutes and may be manually dispatched with optional `pr_number` to reconcile just one PR. It never checks out untrusted FE PR code. A FE-side category label is only a request to inspect: it is not admission. The org reader verifies current SHA, exact native Issue linkage or release references, and fresh canonical Issue/Project revision immediately before the org-only Project membership write. Retries are idempotent. Project #5 write secrets remain in `.github`.
