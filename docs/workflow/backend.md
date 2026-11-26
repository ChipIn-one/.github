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

1. **Until [chipin-backend#184](https://github.com/ChipIn-one/chipin-backend/issues/184) (done):** `completion: manual` in `workflow-registry.yaml`; a human closed a backend Issue only after production.
2. [chipin-backend#213](https://github.com/ChipIn-one/chipin-backend/issues/213): the evidence step in `deploy-production`, reviewed and merged by olegbal.
3. Before the engine is turned on, olegbal disables "Auto-close issues with merged linked pull requests" in chipin-backend.
4. Registry switch to `completion: deployment-receipt` with `productionEvidence`, plus a completion caller using the same fail-closed read-back model as `frontend-production-completion`, as a separate PR merged by olegbal.

Step **A1** of [chipin-backend#184](https://github.com/ChipIn-one/chipin-backend/issues/184), the engine, is done once its `.github` PR merges: `deployment-receipt` accepts `productionEvidence.verifier: workflow-run` and verifies the receipt against its run as described in [completion.md](completion.md#workflow-run-verifier-backend) (only the latest receipt counts, and its run must be the newest run of `deploy-production.yml`, on any branch, of any event or status; an untrusted latest receipt keeps Issues open as `production-evidence-untrusted`). It changed no backend behaviour on its own.

Step **A3** (this record switch, [chipin-backend#184](https://github.com/ChipIn-one/chipin-backend/issues/184)): `completion: deployment-receipt`, `capabilities.completion: automatic`, the evidence line below, `release.productionSource` removed. The engine reads the registry of the org tag its caller pins, so the backend caller (`.github/workflows/completion.yml` in chipin-backend) pins the first tag that contains this switch and merges after it.

### Trust boundary

Users with write access to chipin-backend are trusted. The verifier stops forged or stray receipts: a Deployment written by hand, by another workflow or by a workflow on another branch or tag, a receipt the deploy run never wrote, a re-run citing an old run, an older deploy made to look current by deleting a newer receipt, and a re-run of an older Deploy Production run after the newest receipt (`rerun-after-receipt`, within the newest 100 runs). It does not stop a malicious writer. Known, accepted limits:

- a writer deletes the newer Deploy Production runs (with their receipt Deployments): the previous deploy looks current again, and Issues contained only in it could close although a rollback removed them (the audit log shows the deletion; the verifier cannot);
- a writer re-runs an older Deploy Production run that is no longer among the newest 100 runs of the workflow: a re-run keeps its `run_number`, and only the newest 100 runs are read, so the `rerun-after-receipt` check does not see it (GitHub allows re-runs for 30 days);
- a deploy outside Deploy Production, for example another workflow on the self-hosted production runner, writes no receipt and is invisible to the verifier;
- `develop` is unprotected (`protected: false`; rulesets and branch protection need a paid plan for this private repository, [#161](https://github.com/ChipIn-one/.github/issues/161)): a writer can push a changed `deploy-production.yml` or `record-receipt` to `develop` and dispatch it, and every check passes. The verifier proves that a receipt came from the newest Deploy Production run on a `develop` commit, not that the commit was reviewed.

### Preconditions before the registry switch (step A3)

- [ ] `develop` protected with required review ([#161](https://github.com/ChipIn-one/.github/issues/161); deferred: needs a paid plan).
- [x] Re-runs of Deploy Production: no deploy workflow change (olegbal, 2026-11-26). The engine instead keeps Issues open when any other listed run of the workflow is a re-run (`run_attempt > 1`) that ended after the cited run was created, or any other run that is not completed (`rerun-after-receipt`, [completion.md](completion.md#workflow-run-verifier-backend)): a re-run keeps its `run_number`, so an older run re-run after the receipt may have redeployed an older image without a newer run.
- [ ] The self-hosted production runner restricted to `deploy-production.yml` on `develop` (runner group with selected workflows, if the plan allows). Deferred with #161 (see known limits).
- [x] olegbal disables "Auto-close issues with merged linked pull requests" in chipin-backend (step 3 above).
- [x] The runner token can read Actions runs and jobs and check-run annotations (Checks read) on chipin-backend (plus Contents read, Pull requests read, Deployments read, Issues write and Project #5); a failed read leaves every Issue `production-evidence-unreadable`.
- [x] The backend caller (decided: a repository caller, not only the org sweep) triggers on `workflow_run` `completed` of Deploy Production (plus `push` to `develop`), not on `deployment_status`: the receipt's status is written while the run is still `in_progress` ([completion.md](completion.md#workflow-run-verifier-backend)), and it pins an org tag containing A1.

The switch itself (step A3) uses exactly this evidence line:
`productionEvidence: { environment: production-receipt, creator: "github-actions[bot]", task: "deploy:image-receipt", verifier: workflow-run, workflow: .github/workflows/deploy-production.yml, branch: develop, job: record-receipt }`

The same PR removes `release.productionSource` from the record: the registry allows only one production source, and conformance then reads `productionEvidence` ([#254](https://github.com/ChipIn-one/.github/issues/254)).

### Known limits after the switch

Accepted until GitHub Team ([#161](https://github.com/ChipIn-one/.github/issues/161)); the engine stays on with them:

- `develop` is unprotected, so the [trust boundary](#trust-boundary) is "users with write access", not "reviewed code".
- The self-hosted production runner cannot be restricted to `deploy-production.yml` (runner groups with selected workflows need a paid plan for a private repository): another workflow on that runner can deploy without a receipt.
- Fail closed, not self-healing: after "Re-run all jobs" of a Deploy Production run, a re-run of an older run that ended after the cited run was created (`rerun-after-receipt`), or a second receipt for one run (`run-id-cited-twice`), the newest receipt can no longer be trusted, so backend Issues stay open (`production-evidence-untrusted`) until the next successful Deploy Production.
- The receipt written by "Re-run failed jobs" of `record-receipt` is valid only if the first attempt failed before it created its receipt Deployment; otherwise the run is cited twice (see above).
- Re-runs are seen only within the newest 100 runs of Deploy Production (one page): a re-run of an older run redeploys and may write no receipt, so the newest receipt could name newer code than production runs. Accepted: do not re-run old Deploy Production runs; dispatch a new one instead.
- `CHIPIN_ISSUE_WRITE_TOKEN` is a per-repository secret on the Free plan ([#193](https://github.com/ChipIn-one/.github/issues/193)); a revoked or expired token leaves every Issue `production-evidence-unreadable` and the caller run red.
