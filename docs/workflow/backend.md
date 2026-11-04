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

Valid evidence:

- a Deployment created by the post-success job `record-receipt` of `deploy-production` ([chipin-backend#213](https://github.com/ChipIn-one/chipin-backend/issues/213)): `environment: production-receipt` (the `production` branch policy rejects a raw-SHA ref), `task: deploy:image-receipt`, `sha` = the resolved image tag, payload `run_id`; or
- the production tag from [#173](https://github.com/ChipIn-one/.github/issues/173) on the deployed SHA.

The record alone is not trusted: anyone with write access can create an identical Deployment. The engine must verify that `run_id` is a successful `workflow_dispatch` run of `.github/workflows/deploy-production.yml` on `develop` whose `record-receipt` outputs name this `deployment.id` and `sha`, reject a `run_id` cited twice, and treat the **latest** valid receipt as what runs in production (a rollback creates a newer receipt for an older SHA). Details: [chipin-backend#184](https://github.com/ChipIn-one/chipin-backend/issues/184#issuecomment-6522374443).

### Rollout

1. **Now:** `completion: manual` stays in `workflow-registry.yaml`. A human closes a backend Issue only after its Development-linked PR is merged, never before.
2. [chipin-backend#213](https://github.com/ChipIn-one/chipin-backend/issues/213): the evidence step in `deploy-production`, reviewed and merged by olegbal.
3. Before the engine is turned on, olegbal disables "Auto-close issues with merged linked pull requests" in chipin-backend.
4. Registry switch to `completion: deployment-receipt` with `productionEvidence`, plus a completion caller using the same fail-closed read-back model as `frontend-production-completion`, as a separate PR merged by olegbal.

Step **A1** of [chipin-backend#184](https://github.com/ChipIn-one/chipin-backend/issues/184), the engine, is done once its `.github` PR merges: `deployment-receipt` accepts `productionEvidence.verifier: workflow-run` and verifies the receipt against its run as described in [completion.md](completion.md#workflow-run-verifier-backend) (only the latest receipt counts, and its run must be the newest Deploy Production dispatch run on `develop`, of any status; an untrusted latest receipt keeps Issues open as `production-evidence-untrusted`). It changes no backend behaviour: the record stays `completion: manual` / `capabilities.completion: manual`. What remains:

- **Precondition before the registry switch: `develop` must require review.** Today `develop` in chipin-backend is unprotected (`protected: false`): rulesets and branch protection need a paid plan for this private repository ([#161](https://github.com/ChipIn-one/.github/issues/161)). Until `develop` requires a reviewed PR, anyone with write access can push a changed `deploy-production.yml` (or a commit whose `record-receipt` writes any notice) to `develop`, dispatch it, and every check of the verifier passes: the verifier proves that the receipt came from a successful Deploy Production run on a `develop` commit, not that this commit was reviewed. This is a known, unmet limit of the threat model; switching the engine on before it is closed means accepting it explicitly;
- **Remaining limit, also after `develop` is protected:** a writer who deletes the newer Deploy Production runs themselves (runs can be deleted with write access), together with their receipt Deployments, makes the previous deploy look current again, so Issues contained only in that previous deploy could close although a rollback removed them. The verifier cannot see deleted records; the audit log can. Accepted with the switch unless repository roles are narrowed;
- before the switch, verify that the runner's token can read Actions runs and jobs and check-run annotations on chipin-backend (a failed read leaves every Issue `production-evidence-unreadable`);
- step 3 (olegbal disables native auto-close in chipin-backend);
- the registry switch of step 4 with exactly this evidence line:
  `productionEvidence: { environment: production-receipt, creator: "github-actions[bot]", task: "deploy:image-receipt", verifier: workflow-run, workflow: .github/workflows/deploy-production.yml, branch: develop, job: record-receipt }`;
- the runner of step 4 (repository caller or org sweep): its fast trigger must be `workflow_run` `completed` of Deploy Production (plus `push` to `develop` and a schedule as usual), not `deployment_status`, because the receipt's status is written while the run is still `in_progress` and the run check would fail ([completion.md](completion.md#workflow-run-verifier-backend)); and a token with Deployments read, Actions read and check-run annotation read on chipin-backend, plus Issues write;
- an org tag containing A1, pinned by that caller.
