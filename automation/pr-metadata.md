# PR metadata reconciliation — FE #381

FE-only rollout. Reuses shared GitHubClient from github-metadata.mjs and the existing native Development linker, which verifies userLinkedOnly relationship read-back. No backend or KB workflow is enabled.

## Contract

Implementation PR: same-repo source → dev, **one** exact "Task identity: ChipIn-one/chipin-frontend#381" body line. Native link is required and read back; free-text mentions, matching numbers, branch names and closing keywords are never substitutes. Single-Issue implementation identity only; multi-Issue implementation PRs are intentionally unsupported and fail closed.

Release PR: same-repo dev → main, no "Task identity" marker. Body includes one each of:
- "Included implementation PRs: ChipIn-one/chipin-frontend#123, ChipIn-one/chipin-frontend#124"
- "Included Issues: ChipIn-one/chipin-frontend#21, ChipIn-one/chipin-frontend#22"

The referenced implementation PRs must be merged into dev; their Task identities must exactly match the listed Issue set. Existing #379 release source policy and CI reject closing keywords. Use non-closing references only. Keep both PR bodies concise with **## Summary**, **## Tests**, **## Version impact**, **## Dependencies**. Missing headings are diagnosed, not filled with unverified claims. Human-written PR body, title and manual labels are never overwritten.

## Ownership and review

Existing PR assignees and requested reviewers are retained. For an otherwise unassigned implementation PR, precisely one Issue assignee is an acceptable owner; otherwise configure explicit implementationOwner. Release PRs need an approved releaseOwner. Both are null by default: OWNER_POLICY diagnostic is intentional, not permission to guess the PR author. Author fallback is opt-in and disabled. GitHub assignability is checked before adding an assignee.

Requested reviewers use a **separate approved list**, currently empty by design. Choose exactly one eligible configured reviewer, validate collaborator write-or-higher permission, never self-request; only request after frontend-ci success on exact PR head SHA. Existing reviewer requests remain untouched. This does not approve review or invoke paid review bots.

Taxonomy: additive pr:implementation / pr:release category label, no duplication of Issue Priority/Severity/Type/Milestone/Project Status. Frontend is implicit in FE-only rollout. Missing category labels are created deterministically. Read-back required.

Project #5: PR content item added only if absent; full paginated check before and after, duplicate PR items block. No PR Project Status changes. The Issue remains authoritative for completed/open; no Issue state write anywhere in this reconciler, and existing Issue Project memberships are not modified.

## Deployment and blocker policy

Trusted FE pull_request metadata events only: opened, edited, reopened, synchronize, ready_for_review; manual workflow_dispatch retry. No PR-head code checkout. Shared composite action pinned to exact commit. Serialized per PR. Requires Issues write and PR write plus **org Projects v2 read/write** for Project #5; GITHUB_TOKEN alone often cannot write org Projects. FE secret CHIPIN_PR_METADATA_TOKEN must have the approved limited permissions. Missing project rights fail closed. Review requests are deferred until current-SHA CI; do not pay for bot review on metadata events. New FE implementation/release PRs need live read-back after token/owner/reviewer approval; human-only merge remains unchanged.
