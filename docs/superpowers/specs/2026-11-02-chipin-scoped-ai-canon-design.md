# ChipIn-scoped AI canon migration

## Intent

Move ChipIn's operational AI routing canon from the personal
`syllik/ai-workflow` repository into the organization-owned
`ChipIn-one/.github/docs/workflow/` tree. The migration closes the ownership and
availability risk tracked by ChipIn-one/.github#15 and prevents backend PR #235
from introducing a new personal-repository dependency.

## Goals

- Make `ChipIn-one/.github/docs/workflow/README.md` the first routing entry for
  every registered ChipIn repository.
- Preserve the lifecycle, role boundaries, integration branches and required
  read-only context dependencies that ChipIn currently uses.
- Keep only the four ChipIn registry records: `.github`, frontend, backend and
  knowledge base.
- Remove every live/operational dependency on `syllik/ai-workflow` from those
  repositories.
- Publish the organization-owned canon before switching any consumer.

## Non-goals

- Mirroring unrelated personal projects or generic workspace records.
- Moving product, build or deployment policy into the workflow canon.
- Copying the personal repository's executable workspace/context tooling.
- Changing Issue admission, completion, release or repository ownership policy.
- Rewriting historical design records merely because they mention the old
  source; historical text is not an operational routing dependency.

## Approaches considered

### Selected: ChipIn-scoped canon in `.github/docs/workflow/`

Extract and adapt only the normative material used by ChipIn. Existing
organization-owned `automation/issue-admission*.mjs` remains the executable
admission boundary. This gives ChipIn one owner, one entry point and no runtime
dependency on the personal repository.

### Rejected: complete mirror of `syllik/ai-workflow`

This would preserve paths with less editing, but would import unrelated
personal projects, scripts and rollout policy and create a second generic
workflow product inside the ChipIn organization.

### Rejected: org-first routing with personal role fallback

This is the transitional design described by #160. It does not satisfy #15 or
the owner decision to remove the personal dependency now.

## Organization-owned structure

The canonical files will live at:

- `docs/workflow/README.md` — first entry and reading order;
- `docs/workflow/FLOW.md` — ChipIn lifecycle and authority chain;
- `docs/workflow/workspace.yaml` — only the four ChipIn repository records;
- `docs/workflow/projects/index.md` — human-readable index of those records;
- `docs/workflow/roles/workflow.md` — role index;
- `docs/workflow/roles/{core,planner,architect,executor,reviewer,auditor,publisher,models,documentation,context}.md`.

The copied role material is adapted rather than mirrored:

- links use paths under `ChipIn-one/.github/docs/workflow/`;
- ChipIn admission points to `ChipIn-one/.github/automation/` and its documented
  preflight, not personal `scripts/workspace/*`;
- generic workspace synchronization and non-ChipIn project rules are removed;
- repository-specific rules remain in each target's `AGENTS.md` and
  `.ai/context.md`.

## Consumer routing contract

Every managed `ai-workflow:agents-routing` block uses this order:

1. Read the organization workflow README and `FLOW.md`.
2. Select exactly one ChipIn record from the organization-owned workspace/index.
3. Read the role index and only the selected role.
4. On the record's integration branch, read target `AGENTS.md`, then
   `.ai/context.md` when declared.
5. Read relevant local decisions/tasks and declared context dependencies; block
   when required context is unavailable.

The block contains no `syllik/*` URL. Other operational prose in `.github`, FE,
KB and BE is updated to refer to the organization-owned canon.

## Rollout and failure safety

The cutover is staged to avoid a broken intermediate state:

1. **Publish producer:** merge the `.github` PR that adds the canon, updates its
   own routing/docs and adds contract tests.
2. **Switch consumers:** after the producer is readable on `master`, update FE
   and KB routing/prose and amend BE #235 before it is merged.
3. **Retire personal rollout:** remove ChipIn roots from the personal
   `rollout.yaml`/routing rollout so it cannot restore the old managed block.
4. **Audit:** search operational files in all four repositories for
   `syllik/ai-workflow`, run each repository's focused checks, then run the
   conformance audit.

If the producer PR is not merged, no consumer is switched. If a consumer PR
fails, already-switched repositories still point to the published org canon.

## Verification

- New tests validate the four-record workspace and every canonical relative
  link/file.
- New tests validate that the managed routing template starts at the org canon
  and contains no personal URL.
- `node --test automation/*.test.mjs` passes in `.github`.
- Focused documentation/routing checks pass in FE, KB and BE; BE's existing CI
  remains green after #235 is amended.
- Operational grep across the four integration branches finds no
  `github.com/syllik/ai-workflow` dependency.
- The conformance audit reports no routing/context drift after all consumer PRs
  merge.

## Delivery boundaries

This is a coordinated multi-PR migration:

- `.github` producer PR: ChipIn-one/.github#15 (also advances #160);
- FE consumer PR: owner `syllik`, target `master`;
- KB consumer PR: owner `syllik`, target `master`;
- BE consumer change: amend open PR #235, owner `olegbal`, target `develop`;
- personal workflow retirement: separate personal-repository change, performed
  only after the org producer exists.

Humans merge. No consumer PR merges before the `.github` producer.
