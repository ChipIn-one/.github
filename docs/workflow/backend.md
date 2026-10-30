# Backend profile (`ChipIn-one/chipin-backend`)

Repository-specific differences from the [ChipIn Workflow Standard v1](README.md). Owner: olegbal.

## ADR: completion and promotion contract ([#156](https://github.com/ChipIn-one/.github/issues/156))

Decided 2026-10-30 by olegbal with the owner (syllik), [decision comment](https://github.com/ChipIn-one/.github/issues/156).

### Decision

- **Completion strategy: `deployment-receipt`** (option b). A backend Issue becomes `closed/completed` when every Development-linked PR is merged into `develop` and contained in a successful production deployment of an exact commit.
- **No promotion branch.** `develop` stays the default and integration branch; production stays the manual `Deploy Production` dispatch.

### Rationale

Production already promotes an exact, immutable image, `olegbal/chipin-backend:<full sha>`, that staging ran ([chipin-backend#153](https://github.com/ChipIn-one/chipin-backend/issues/153), `deploy/README.md` §9). A promotion branch would duplicate that guarantee with extra merge PRs and the risk of branches drifting apart. Closing on staging (option a) would mark work done before it reaches users; staying manual (option c) keeps the premature-close risk that blocks PR admission.

### Evidence source and precondition

The receipt must carry the **deployed image SHA**. The `production` Deployment that the job's `environment:` key creates implicitly is not valid evidence: its `sha` is the `develop` head at dispatch time, so a rollback (`image_tag` = an older SHA) or a failed newest staging deploy would attest commits that are not in production.

Valid evidence, once implemented in [chipin-backend#184](https://github.com/ChipIn-one/chipin-backend/issues/184):

- a Deployment created by a post-success step of `deploy-production` with `sha` = the resolved image tag and creator `github-actions[bot]` (which also separates it from the implicit Deployments created by whoever dispatched); or
- the production tag from [#173](https://github.com/ChipIn-one/.github/issues/173) on the deployed SHA.

### Rollout

1. **Now:** `completion: manual` stays in `workflow-registry.yaml`. A human closes a backend Issue only after its Development-linked PR is merged, never before.
2. [chipin-backend#184](https://github.com/ChipIn-one/chipin-backend/issues/184): the evidence step in `deploy-production`, reviewed and merged by olegbal.
3. Before the engine is turned on, olegbal disables "Auto-close issues with merged linked pull requests" in chipin-backend.
4. Registry switch to `completion: deployment-receipt` with `productionEvidence`, plus a completion caller using the same fail-closed read-back model as `frontend-production-completion`, as a separate PR merged by olegbal.
