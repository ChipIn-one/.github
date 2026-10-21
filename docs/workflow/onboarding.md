# Onboarding a repository

How to connect a new repository to [ChipIn Workflow Standard v1](README.md). A new repository is one registry record plus two caller files.
Steps 2 and 6 depend on [#153](https://github.com/ChipIn-one/.github/issues/153) and [#154](https://github.com/ChipIn-one/.github/issues/154); until they land, use the
existing caller workflows of `chipin-frontend` as the template and verify the result by hand.

1. **Register.** Add a record to [`workflow-registry.yaml`](../../workflow-registry.yaml) (kind, owner, branches, capabilities) and run
   `node automation/registry.mjs --validate` and `node --test automation/*.test.mjs`. Open the PR in `ChipIn-one/.github`; a patch or minor tag follows the merge.
2. **Callers.** Copy `templates/caller-pr-gate.yml` (and `caller-create-milestone.yml` when `milestones: enabled`) into the repository, set the integration branch
   from the registry and pin the tagged SHA with a version comment (`@<sha> # v1.x.y`).
3. **Dependabot.** Add `.github/dependabot.yml` with ecosystem `github-actions` (weekly, target = integration branch) plus the repository's package ecosystem.
4. **Secret.** Add the read-only org token as `CHIPIN_DEV_READ_TOKEN` in the repository.
5. **Agent context.** Add the routing block to `AGENTS.md` and a `.ai/context.md` following `templates/ai-context.md`.
6. **Verify.** Dispatch `conformance-audit` for the repository and expect `CONFORMANT`.

Do not change build/deploy workflows as part of onboarding. Branch protection for private repositories is available only after the Team plan upgrade
([#161](https://github.com/ChipIn-one/.github/issues/161)); until then the registry records `protection: unavailable`.
