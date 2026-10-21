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
