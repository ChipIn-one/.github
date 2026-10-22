# Onboarding a repository

How to connect a new repository to [ChipIn Workflow Standard v1](README.md). A new repository is one registry record plus two caller files.
Steps 2 and 6 depend on [#153](https://github.com/ChipIn-one/.github/issues/153) and [#154](https://github.com/ChipIn-one/.github/issues/154); until they land, use the
existing caller workflows of `chipin-frontend` (on its canonical `master` since [#216](https://github.com/ChipIn-one/.github/issues/216)) as the template and verify the result by hand.

1. **Register.** Add a record to [`workflow-registry.yaml`](../../workflow-registry.yaml) (kind, owner, branches, capabilities) and run
   `node automation/registry.mjs --validate` and `node --test automation/*.test.mjs`. Open the PR in `ChipIn-one/.github`; a patch or minor tag follows the merge.
2. **Callers.** Copy `templates/caller-pr-gate.yml` (and `caller-create-milestone.yml` when `milestones: enabled`) into the repository, set the integration branch
   from the registry and pin the tagged SHA with a version comment (`@<sha> # v1.x.y`). Admission, the Development link and PR metadata accept only the
   routes the record allows: an implementation PR into `branches.integration`, plus `integration -> promotion` release PRs when `branches.promotion` is set;
   every other base is rejected. A repository with `capabilities.completion: automatic` also needs its completion caller ([completion.md](completion.md)),
   unless its record says `completionRunner: org-sweep` (an org sweep in `ChipIn-one/.github` runs the engine, e.g. `chipin-frontend` since
   [#217](https://github.com/ChipIn-one/.github/issues/217)); with `manual` none is required.
3. **Dependabot.** Add `.github/dependabot.yml` with ecosystem `github-actions` (weekly, target = integration branch) plus the repository's package ecosystem.
4. **Secret.** Add the read-only org token as `CHIPIN_DEV_READ_TOKEN` in the repository.
5. **Agent context.** Add the routing block to `AGENTS.md` and a `.ai/context.md` following `templates/ai-context.md`.
6. **Verify.** Dispatch `conformance-audit` for the repository and expect `CONFORMANT`.

Do not change build/deploy workflows as part of onboarding. Branch protection for private repositories is available only after the Team plan upgrade
([#161](https://github.com/ChipIn-one/.github/issues/161)); until then the registry records `protection: unavailable`.
