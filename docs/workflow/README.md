# ChipIn Workflow Standard v1

Approved by the owner on 2026-10-21 (epic [#149](https://github.com/ChipIn-one/.github/issues/149)).
Owned by `ChipIn-one/.github`; this directory is the first entry point for every ChipIn repository.

| Page | Purpose |
| --- | --- |
| this page | the standard: principles, registry, reusable workflows, pins, relationships, conformance, routing |
| [onboarding.md](onboarding.md) | connect a repository to the standard |
| [relationships.md](relationships.md) | native Issue relationships contract and blocker gate |
| [release.md](release.md) | release policy: tags, GitHub Releases, version from `Version impact` |
| [conformance.md](conformance.md) | what the conformance audit checks |
| [completion.md](completion.md) | completion policy: which merge closes an Issue per registry strategy, the evidence required, when the engine leaves it open |

Task metadata (Issue Type, Priority, Severity, Project #5 Status, Milestone) stays defined by [github-issue-schema.md](../../github-issue-schema.md).
Automation reference: [automation/README.md](../../automation/README.md).

Tests: `node --test automation/*.test.mjs` (the form `node --test automation/` fails on Node 24+; CI pins 24.21.0).

## Implementation status

The standard is specified in full; implementation lands task by task. Statements below describe the target unless marked.

| Part | State | Tracked in |
| --- | --- | --- |
| Registry `workflow-registry.yaml` + loader `automation/registry.mjs` | implemented | [#150](https://github.com/ChipIn-one/.github/issues/150) |
| Admission and intake scope from the registry (`.github` admitted, owner per record) | implemented | [#183](https://github.com/ChipIn-one/.github/issues/183) |
| Release tags and SHA pins, Dependabot in all repositories | implemented (tags by hand until #175) | [#151](https://github.com/ChipIn-one/.github/issues/151) |
| Release engine, reusable `release.yml`, `.github` tag and Release on merge to `master` | implemented | [#169](https://github.com/ChipIn-one/.github/issues/169), [#175](https://github.com/ChipIn-one/.github/issues/175) |
| Native relationships reconciler and blocker gate | implemented; live acceptance passed 2026-10-22; scheduled apply once `RELATIONSHIPS_RECONCILE_APPLY` is set (#188) | [#136](https://github.com/ChipIn-one/.github/issues/136), [#152](https://github.com/ChipIn-one/.github/issues/152) |
| Reusable `pr-gate` / `issue-gate` | planned | [#153](https://github.com/ChipIn-one/.github/issues/153) |
| Conformance audit | implemented; scheduled runs plan only until `CONFORMANCE_AUDIT_APPLY` is set | [#154](https://github.com/ChipIn-one/.github/issues/154) |
| Backend / knowledge-base conformance packages | planned | [#155](https://github.com/ChipIn-one/.github/issues/155), [#158](https://github.com/ChipIn-one/.github/issues/158) |
| Docs consolidation and routing blocks | planned | [#160](https://github.com/ChipIn-one/.github/issues/160) |
| Completion engine by registry strategy (`.github` and knowledge base close after the integration merge) | implemented | [#179](https://github.com/ChipIn-one/.github/issues/179) |

## 1. Purpose and principles

The standard describes how any repository of the `ChipIn-one` organization joins the single GitHub task workflow:
intake → admission → implementation → PR publication → review → human merge → completion, plus relationships between tasks.
It does not describe product logic, build/deploy or code rules; those stay in the repositories.

Principles (fixed inside v1):

1. The source of truth is native GitHub objects: Issue state/reason, Issue Type, org fields Priority/Severity, Project #5 Status,
   native relationships (blocked by, relates to, parent/sub-issue, Development link). Markdown, labels and comments only transport intent; they are not state.
2. Fail closed: unreadable, ambiguous or stale state blocks instead of being guessed.
3. Only a human merges. Automation never closes an Issue because of Status `Done` and never changes Status because a PR merged.
4. One writer per kind of metadata: intake — `automation/issue-intake.mjs`; relationships — `automation/relationships.mjs`;
   Project — `pr-project-writer.mjs`; completion — `automation/completion.mjs`, driven by the registry strategy ([completion.md](completion.md)). Executor agents have no write rights.
5. Extensibility: a new repository is one registry record plus two caller files. Logic knows `kind` and capabilities, not the names FE/BE/KB.
6. Cost: $0 of infrastructure beyond GitHub; CI minutes are saved with path filters and self-hosted runners where they exist.

## 2. Repository registry — `workflow-registry.yaml`

One file in the root of `ChipIn-one/.github`. `automation/registry.mjs` validates it (unknown keys, bad enum values, duplicate repositories and a null owner outside `docs`
all fail) and returns a profile by `owner/repo` through `loadRegistry()` and `getRepositoryProfile(fullName)`. Check it locally with:

```bash
node automation/registry.mjs --validate
```

The file is read by a strict built-in YAML subset reader, so the repository needs no dependencies. See the header of the file for the supported syntax.

| Field | Meaning |
| --- | --- |
| `repository` | `ChipIn-one/<name>` |
| `kind` | `code`, `docs` or `meta` |
| `visibility` | `public` or `private` |
| `owner` | required native assignee; `null` is allowed for `docs` only (owner chosen at intake) |
| `branches` | `default`, `integration`, optional `promotion` |
| `deploymentProfile` | `none`, `staging`, `production` |
| `completion` | `production-merge`, `integration-merge`, `deployment-receipt`, `manual` |
| `protection` | `ruleset`, `protection`, `unavailable` (Free plan + private) |
| `requiredChecks` | names of checks the integration branch must require |
| `release` | `strategy` (`semver-by-impact`, `deploy-tag`, `none`), `trigger` (`promotion-merge`, `integration-merge`, `production-deploy`; none for `none`), `tagPrefix` (default `v`); see [release.md](release.md) |
| `capabilities` | `admission` (required/advisory/off), `developmentLink` (required/advisory/off), `prMetadata`, `relationships`, `dependabot`, `agentRouting` (required/off), `completion` (automatic/manual), `milestones` (enabled/off) |

Defaults by `kind` apply to capabilities a record does not list: `code` — everything required/automatic/enabled; `docs` — no `prMetadata` and no `milestones`;
`meta` — no `prMetadata`. A record overrides the default. A capability `completion: automatic` contradicts a top-level `completion: manual` and fails validation.

Repositories outside the registry are not managed by the standard. The conformance audit lists organization repositories that are not registered
(currently `slack-rofls` and `chipin-backend-python`, excluded by owner decision) as `UNREGISTERED` and takes no action.

Consumers that used to hardcode repository names read the registry: the Development-link allowlist, task-identity pattern and integration-branch check
(`development-link.mjs`), the milestone allowlist (`create-milestone.mjs`), and the PR-metadata owner, branches and Project number (`pr-metadata.mjs`).
The admission/intake modules (`issue-admission.mjs`, `issue-admission-pr.mjs`, `issue-intake.mjs`, `issue-admission-preflight.mjs`, the evidence and human-orchestrator checks) read their scope from the registry too ([#183](https://github.com/ChipIn-one/.github/issues/183)): every repository with `admission` not `off`, owner from the record.

## 3. Reusable workflows and callers

Planned in [#153](https://github.com/ChipIn-one/.github/issues/153). `ChipIn-one/.github/.github/workflows/` gets two `workflow_call` workflows that wrap the existing composite actions:

- `pr-gate.yml` — inputs `pull-request-number`, `head-sha`; secret `admission-token`. Steps by registry capability: admission (`issue-admission-action`) →
  relationships gate (read-only: an open `blockedBy` on the Task identity → `BLOCKED_BY_DEPENDENCY`, exit 1) → development link (`development-link-action`) →
  PR metadata (`pr-metadata-action`, when `prMetadata: required`). It never checks out PR code. Output: one job `pr-gate` with a summary receipt artifact.
- `issue-gate.yml` — input `issue-number`; read-only check of declared relationships (format, direction, target existence, cycles) and intake completeness;
  used by the conformance audit and manual dispatch.

A caller in a repository is a template (`templates/caller-pr-gate.yml`, about 12 lines):

```yaml
name: PR gate
on:
  pull_request:
    branches: [dev]          # integration branch from the registry
    types: [opened, reopened, edited, synchronize, ready_for_review]
permissions: { contents: read, issues: write, pull-requests: write }
jobs:
  pr-gate:
    if: github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.user.login != 'dependabot[bot]'
    uses: ChipIn-one/.github/.github/workflows/pr-gate.yml@<sha>   # v1.0.0
    secrets: { admission-token: ${{ secrets.CHIPIN_DEV_READ_TOKEN }} }
```

Existing frontend callers (`frontend-ci` admission step, `native-development-link.yml`, `pr-metadata.yml`) are replaced gradually: `pr-gate` is added first,
and after two green weeks the old callers are removed. The required check name `frontend-ci` is kept (admission stays inside it until protection is switched).
Composite actions remain the units of logic and tests; direct action calls from repositories stay allowed only for milestones and completion.

## 4. Versioning and pins

- `.github` gets semantic tags `v1.0.0`, `v1.1.0`, …. Since [#175](https://github.com/ChipIn-one/.github/issues/175) the tag and the GitHub Release are created automatically:
  `.github/workflows/release-on-master.yml` runs after every push to `master` (a human merge) and calls the reusable release workflow pinned to an org tag;
  the version is the previous tag bumped by the maximum `## Version impact` of the pull requests merged since that tag ([release.md](release.md)).
  Merges whose PRs all declare `none` create nothing; a head that is already tagged is a no-op. The engine that runs is the pinned one, never the `master` being
  released, so after a release that changes the engine the pin in the caller is raised (Dependabot `github-actions` or by hand). Tags placed by hand before #175 (`v1.0.0`–`v1.2.1`) stay valid.
- Choosing `## Version impact` in a `.github` PR (the first non-empty line of the section is one keyword; a mixed PR takes the highest):
  - `none` — nothing a consumer pins changes: documentation, tests, Issue forms, templates, evidence, and org-internal workflows (`.github/workflows/*` that are not `workflow_call`).
  - `patch` — a fix inside `automation/` (modules, composite actions), in a reusable `workflow_call` workflow or in a registry value, without new inputs and without behaviour a consumer must adopt.
  - `minor` — a backward-compatible addition: a new module, action or reusable workflow, a new optional input or output, a new registry field or record.
  - `major` — a removed or renamed input, a changed meaning of an existing one, a new required input, a registry schema change (`v2`); an explicit owner decision.
  - Unsure between `none` and `patch`: if a consumer that moves its pin to the new tag gets different behaviour, it is `patch`.
- A merged PR without a valid section blocks the run (`INVALID_VERSION_IMPACT`, red run on `master`), and the block persists for every later merge because the
  range is "everything since the previous tag". Remedy: edit the body of the *merged* PR (add `## Version impact` with the keyword), then re-run the failed
  `Release on master` run (the engine re-reads PR bodies on every run); placing the tag by hand is the fallback. Dependabot PRs have no such section: a PR authored
  by `dependabot[bot]` without the section gets a default from its head branch (receipt `impactRaw: dependabot-default`): `dependabot/github_actions/…` counts
  as `none` (an action pin bump changes nothing a consumer pins), any other ecosystem (`dependabot/npm_and_yarn/…`, `pip`, `docker`, …) counts as `patch`
  (a runtime dependency bump ships code to production and needs a version). A Dependabot PR whose head branch is not `dependabot/<ecosystem>/…` still blocks.
  To choose another value, add the section to its body (an explicit section always wins and is validated like any other). The remedy above stays for human PRs.
- Consumers pin a **SHA** with a version comment: `@<sha> # v1.0.0`. This keeps the fail-closed pin policy and lets Dependabot (ecosystem `github-actions`) raise the pin.
  Dependabot `github-actions` is enabled in every registry repository (`dependabot: required`), weekly, targeting the integration branch.
- Compatibility inside v1: inputs of actions and reusable workflows are never removed and never change meaning; new inputs are optional.
- The conformance audit treats a pin as stale when it is older than the latest tag that touches a capability the repository uses.

## 5. Task relationships

Summary; the full contract is in [relationships.md](relationships.md).

| Edge | Native object | Meaning | Gate |
| --- | --- | --- | --- |
| `Blocked by: owner/repo#N` | `blockedBy` (reverse: `blocking`) | true ordering dependency | admission `BLOCKED_BY_DEPENDENCY` while the blocker is open |
| `Blocks: owner/repo#N` | `blocking` | same, declared from the blocker | as above, for the target |
| `Relates to: owner/repo#N` | `relatesTo` | paired work without order (FE↔BE of one feature) | none |
| `Parent: owner/repo#N` | `parent` / `subIssues` | decomposition; cross-repository product parents live in KB (per schema), process epics in `.github` | none; Project shows `Sub-issues progress` |
| Development link | `closedByPullRequestsReferences` | implementation | already exists |

## 6. Conformance audit

Implemented in [#154](https://github.com/ChipIn-one/.github/issues/154); the checks are listed in [conformance.md](conformance.md).
A weekly org workflow reports one `conformance-<repo>.json` artifact per registry repository and keeps one drift Issue per repository in `.github`.

## 7. Documentation and routing

`ChipIn-one/.github/docs/workflow/` holds this standard, `onboarding.md`, `relationships.md`, `conformance.md`; profile pages `backend.md`, `frontend.md`,
`knowledge-base.md` describe repository-specific differences and link to local rules (added by [#160](https://github.com/ChipIn-one/.github/issues/160)).
`github-issue-schema.md` and `automation/*.md` stay and link here.

Routing: the managed `ai-workflow:agents-routing` block in each registry repository's `AGENTS.md` will start with a link to this README and then point to the role canon.
Until [#15](https://github.com/ChipIn-one/.github/issues/15) is done the role canon stays `syllik/ai-workflow`; afterwards its copy lives in `docs/workflow/roles/`.
Backend gets `.ai/context.md` and the routing block; in `workspace.yaml` the backend stays `read-only` for the owner's managed agents, which does not prevent coordinator PRs (olegbal merges them).
Reading order: this standard → role canon → repository `AGENTS.md` → `.ai/context.md`.

## 8. Onboarding a repository

See [onboarding.md](onboarding.md).

## 9. Out of scope for v1

An external service or GitHub App for cross-repository events; shadow relationship databases; automatic merge; replacing the role canon; product CI/deploy; Trello.

## 10. Open owner decisions

- [#161](https://github.com/ChipIn-one/.github/issues/161): upgrade the organization to GitHub Team for rulesets on private BE/KB (2 seats).
- [#156](https://github.com/ChipIn-one/.github/issues/156): backend completion contract (what closes a backend Issue) — with olegbal.
- Pin policy for `actions/*` in backend (SHA, as in frontend) — part of [#155](https://github.com/ChipIn-one/.github/issues/155), confirmed by olegbal.
