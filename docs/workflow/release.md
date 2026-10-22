# Release policy

Native tags and GitHub Releases for ChipIn repositories. Owner decisions of 2026-10-21 (epic [#167](https://github.com/ChipIn-one/.github/issues/167)); the per-repository rule lives in the
`release` block of [`workflow-registry.yaml`](../../workflow-registry.yaml). This page is the policy; the automation is built by the tasks listed under Rollout and is not active until they land.

## Rules

1. **The version is a git tag** `vX.Y.Z` (prefix from `release.tagPrefix`, default `v`) plus a native GitHub Release. No task changes a version; `package.json` does not carry the release version.
2. **The increment comes from `## Version impact`** of the PRs included since the previous tag: the maximum of `major` > `minor` > `patch` > `none`. A missing or invalid value blocks the release (no guessing). `major` from 0.x is rejected: `1.0.0` is an explicit owner decision.
3. **All `none` means no new version:** no tag and no Release are created; the change ships as part of the previous version.
4. **Only a human merges.** Tags and Releases are created automatically *after* a human merge (or a successful production deploy), never before, and never by merging.
5. **Release notes are generated:** native GitHub generated notes from the merged PRs plus an "Included Issues" block built from the inventory (`Task identity` of the included PRs). Nothing is written by hand.
6. **Sentry** gets a release only for a tag build (frontend `main`); dev and preview builds get no separate Sentry release.
7. **Unchanged:** production completion still closes FE Issues after the merge to `main`; `Version impact` stays in every task PR; Milestones stay product goals and are not versions.

## Per repository (registry `release` block)

| Repository | Strategy | Trigger | What happens |
| --- | --- | --- | --- |
| `chipin-frontend` | `semver-by-impact` | `promotion-merge` | A bot keeps one open `dev -> main` release PR (inventory, computed version, notes). After a human merges it, the tag and Release are created on the merge commit. |
| `chipin-backend` | `deploy-tag` | `production-deploy` | After every successful `Deploy Production` the deployed SHA gets the tag and Release; a rollback to an older SHA creates none. The deploy workflow change is reviewed and merged by olegbal (relates to [#156](https://github.com/ChipIn-one/.github/issues/156)). |
| `.github` | `semver-by-impact` | `integration-merge` | A merge to `master` that changes `automation/`, reusable workflows or the registry produces the tag and Release; documentation-only merges (`none`) create nothing. |
| `chipin-knowledge-base`, `chipin-notifications` | `none` | — | Documents: no versions, no releases. `chipin-notifications` is registered for this policy only; every other capability is off until the owner opts in. |
| `chipin-backend-python`, `slack-rofls` | — | — | Outside the standard (owner decision); reported as `UNREGISTERED`. |

Registry rules: `none` has no trigger; `semver-by-impact` uses `promotion-merge` (needs `branches.promotion`) or `integration-merge`; `deploy-tag` uses `production-deploy` (needs `deploymentProfile: production`); `tagPrefix` is 0-8 lowercase letters.

## Frontend specifics

- The release PR body is generated in the existing inventory format (`Included implementation PRs:` / `Included Issues:`), so `release-source-policy`, admission, `pr-metadata` and production completion keep working unchanged.
- A bot-created PR does not trigger `pull_request` workflows when it uses the default `GITHUB_TOKEN`; the rolling release PR therefore needs a repository secret supplied by the owner (human action, tracked in [#170](https://github.com/ChipIn-one/.github/issues/170)).
- Builds: `main` resolves the tag of its commit; other builds are `<last tag>-dev-<sha>`. How a Vercel build learns its tag is verified in [#172](https://github.com/ChipIn-one/.github/issues/172) (deferred by the owner).
- Cleanup of the old flow (`version:bump`, `version:check`, the version resolver, lockfile sync, the related rules) is [#172](https://github.com/ChipIn-one/.github/issues/172).
- Historical versions 1.0.2-1.0.8 are backfilled as tags on the matching `main` merge commits after the owner approves a dry-run list ([#171](https://github.com/ChipIn-one/.github/issues/171)).

## Engine (`automation/release.mjs`, task #169)

One engine for every `semver-by-impact` and `deploy-tag` repository; the registry profile decides the release branch and the tag prefix.

```bash
# read-only plan (prints the decision, writes nothing)
node automation/release.mjs plan --repository ChipIn-one/.github --ref master [--output receipt.json]
# apply: explicit activation and env switch; the token needs contents: write on the repository
CHIPIN_RELEASE_WRITE=1 node automation/release.mjs apply --repository ChipIn-one/.github --ref <sha> --activate release-v1
```

Steps, all fail-closed:

1. Resolve `--ref` to a commit. For `promotion-merge` it must be contained in `branches.promotion`, for `integration-merge` in `branches.integration` (`COMMIT_NOT_ON_RELEASE_BRANCH` otherwise); `production-deploy` takes the deployed SHA as is.
2. Previous tag: the highest `<prefix>X.Y.Z` tag that is an ancestor of the commit. Tags on other branches are skipped; if tags exist but none is an ancestor → `PREVIOUS_TAG_UNREACHABLE`. A repository without tags needs `--initial-version X.Y.Z` (`NO_PREVIOUS_TAG`); that first release has no inventory and the flag is rejected once a tag exists.
3. Inventory: the commits between the previous tag and the release commit; for each, the merged pull requests whose base is `branches.integration` and whose merge commit is in that range (for the frontend these are the implementation PRs merged into `dev`). PRs merged into the promotion branch (the `dev -> main` release PR itself, a hotfix straight into `main`) are never counted and are reported as `excludedPullRequests`; commits covered by neither (direct pushes) are `unattributedCommits` and carry no impact. Commits in the range but **no** included PR (a squash-merged promotion, a hotfix-only range, direct pushes only) → `NO_INCLUDED_PULL_REQUESTS`: nothing is guessed, a human decides.
4. Impact: the first non-empty line of `## Version impact` of every included PR must start with `none`, `patch`, `minor` or `major` (list markers, backticks and bold are ignored, so "- `patch`: …" and "Patch: …" parse). A missing section or any other text → `INVALID_VERSION_IMPACT` with the offending PRs; nothing is guessed. The version is the previous one bumped by the maximum impact; `major` from `0.x` → `MAJOR_FROM_ZERO`.
5. Idempotency: the release commit already tagged → `ALREADY_RELEASED` (no-op; a tag without a Release → `RELEASE_MISSING`, apply creates only the Release, with the inventory taken from the next lower ancestor tag so the "Included Issues" block is right). The computed tag on another commit → `TAG_CONFLICT`. All included impacts `none` → `NO_RELEASE`. `## Version impact` lines that name more than one keyword ("minor/patch") are invalid; HTML-comment placeholders, checkbox lists and a heading with a trailing colon are not recognised either (fail closed), so PR templates must keep the plain form.
6. Apply: create the tag ref on the exact SHA, read it back, create the Release with native generated notes plus the "Included Issues" block (from the `Task identity` lines of the included PRs), read it back as published. Any read-back mismatch → `READBACK_MISMATCH`.

Receipt (`--output`, uploaded by the workflow as `release-receipt-<run>`): `contract: chipin-release/v1`, `mode`, `repository`, `strategy`, `trigger`, `sha`, `releaseBranch`, `previousTag`, `includedPullRequests` (`number`, `impact`, `impactRaw`, `taskIdentity`, `mergedAt`), `unattributedCommits`, `impact`, `version`, `tag`, `outcome` (`PLANNED`, `NO_RELEASE`, `ALREADY_RELEASED`, `RELEASE_MISSING`, `RELEASED`, `BLOCKED` + `code`), `detail`. The process exits 1 only for `BLOCKED`.

Callers: the reusable workflow `.github/workflows/release.yml` (`workflow_call`, inputs `ref`, `initial-version`, `apply`; secret `token`) checks out this repository at the SHA the caller pinned (`job.workflow_sha`, verified after checkout; an empty value fails the job) and runs `automation/release-action`. Permissions are inherited from the caller job, which grants `contents: write`; tags and Releases created with the default `GITHUB_TOKEN` do not trigger other workflows (a PAT or App token is needed if something must react to the tag). The templates serialise runs per repository with a `concurrency` group. The inventory relies on `/commits/{sha}/pulls`, which lists merged PRs only for commits reachable from the default branch (true for every registry release branch today). Templates: `templates/caller-release-promotion.yml` (frontend-like, push to the promotion branch) and `templates/caller-release-integration.yml` (`.github`-like, push to the integration branch). `.github` adopted the integration template in [#175](https://github.com/ChipIn-one/.github/issues/175) (`.github/workflows/release-on-master.yml`: push to `master`, `apply: true`, pinned to the `v1.2.0` SHA, `pull-requests: read` added for the inventory); frontend adoption is [#170](https://github.com/ChipIn-one/.github/issues/170). The caller pins a tag SHA, so a merge that changes the engine is released by the previous engine; the pin is then raised (Dependabot `github-actions` or by hand) and the next merge runs the new one. How to choose the impact of a `.github` PR: [README §4](README.md#4-versioning-and-pins).

## Rollout

| Step | Task |
| --- | --- |
| Registry `release` block, `chipin-notifications`, this page | [#168](https://github.com/ChipIn-one/.github/issues/168) |
| `release-action`: version from impact, tag, Release (idempotent, fail-closed) | [#169](https://github.com/ChipIn-one/.github/issues/169) |
| Frontend rolling release PR | [#170](https://github.com/ChipIn-one/.github/issues/170) |
| Frontend backfill of historical tags | [#171](https://github.com/ChipIn-one/.github/issues/171) |
| Frontend: version from the tag, remove the old flow, Sentry on tags only | [#172](https://github.com/ChipIn-one/.github/issues/172) |
| Backend tag after `Deploy Production` | [#173](https://github.com/ChipIn-one/.github/issues/173) |
| Conformance checks for the release flow | [#174](https://github.com/ChipIn-one/.github/issues/174) |
| `.github` replaces its manual tagging | [#175](https://github.com/ChipIn-one/.github/issues/175) |
