# Human-triggered admission orchestrator — Issue #119

**Scope:** one bounded, manual integration canary; no Executor dispatch, no new PAT,
no GitHub App permission change, no metadata writer, no branch protections change,
no merge or production activation.

The `.github/workflows/issue-admission-human-orchestrator.yml` workflow accepts
only `workflow_dispatch` from `syllik` on the exact protected `master` ref
(original and rerun trigger actor). Its single job receives `contents: write`
only to send `repository_dispatch` from the job-scoped ephemeral `GITHUB_TOKEN`.
It never checks out a PR or other untrusted branch and does not persist credentials.

The manually submitted FE/BE/KB Issue is validated before a random one-use
request ID is generated. KB alone requires an explicit owner; a pinned 64-hex
revision is optional for initial binding, mandatory at subsequent boundaries.
The orchestrator first uploads an immutable run-attempt-bound request artifact;
only then does it send `chipin-admission-preflight-v1` with its artifact ID.

The producer accepts GitHub Actions bot dispatch **only if** the existing
`CHIPIN_TRUSTED_PREFLIGHT_ACTOR` repository variable names
`github-actions[bot]` *and* the new verifier independently authenticates:
the exact human `workflow_dispatch` run (path/ref/SHA/actor/triggering actor,
attempt), artifact ID and GitHub archive digest, full request identity and
revision, age, and the exact payload. A shared bot login alone is never enough.
The producer retains `contents: read` plus `actions: read`; canonical metadata
reads still use existing `CHIPIN_DEV_READ_TOKEN`.

## Activation gates (not performed by this PR)

1. Independent current-head review and green automation CI, then **human merge**.
2. Authorized human checks the current values and approvals for
   `CHIPIN_TRUSTED_PREFLIGHT_ACTOR` and `CHIPIN_DEV_READ_TOKEN`.
   Do not overwrite a pre-existing external trusted actor without a separate decision.
   If there is no approved conflicting actor, separately authorize setting the existing
   variable to `github-actions[bot]`. Never treat that setting alone as safe.
3. Manually run `Human issue admission orchestrator` on `master` with an
   actual current, canonical FE/BE/KB issue and a selected KB owner if relevant.
4. Verify original orchestrator and producer runs, both artifact IDs/digests,
   and the consumer's exact single-use `INTAKE_COMPLETE` read-back within
   120 seconds of the producer receipt. Record full revision and request ID
   without exposing tokens or raw API failure bodies.
5. A successful manual canary proves only the human entry. Connector-only
   delivery, durable replay correlation, fresh FE/BE/KB canaries, independent
   review, FE AGENTS governance, and #119/#57 closure remain separate gates.

Rollback: do not change secrets or apps; stop manual invocation. Revert this
separate workflow + verification change through a normal reviewed PR. Remove
the bot actor authorization via a human-controlled settings change only if it
was separately enabled for this route; preserve any previously approved actor.
