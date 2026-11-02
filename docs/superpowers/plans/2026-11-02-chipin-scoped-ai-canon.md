# ChipIn-scoped AI Canon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a ChipIn-only AI workflow canon under `ChipIn-one/.github/docs/workflow/` and switch every live ChipIn repository away from `syllik/ai-workflow` without a broken intermediate state.

**Architecture:** The `.github` repository is the producer and owns normative lifecycle, workspace records and role files. Existing `.github/automation/` remains the executable admission implementation; no personal workspace scripts are copied. Consumers switch only after the producer is merged to `master`; the open backend PR is amended rather than replaced.

**Tech Stack:** Markdown, YAML, Node.js 24 built-in test runner, GitHub Issues/Projects/PRs, repository-local CI.

**Spec:** `docs/superpowers/specs/2026-11-02-chipin-scoped-ai-canon-design.md`

## Global Constraints

- Canonical files live under `ChipIn-one/.github/docs/workflow/`; no new repository or dependency is added.
- The workspace contains exactly `ChipIn-one/.github`, `ChipIn-one/chipin-frontend`, `ChipIn-one/chipin-backend`, and `ChipIn-one/chipin-knowledge-base`.
- Preserve integration branches: `.github`, FE and KB = `master`; BE = `develop`.
- Preserve access/context policy: `.github` and FE managed; BE and KB read-only; FE and BE depend read-only on KB.
- Do not copy `scripts/workspace/*`; all executable Issue admission references point to `ChipIn-one/.github/automation/`.
- Do not change build, deploy, completion, release, application or product-domain behavior.
- Operational routing/prose contains no `github.com/syllik/ai-workflow` or ``syllik/ai-workflow`` dependency. Historical design records may retain citations as history.
- Producer must be merged and readable on `.github@master` before any consumer PR is merged.
- Humans merge; no force-push and no direct push to integration branches.

## Review Focus

- Missing canonical file/link: `workflow-canon.test.mjs` must walk every role/index link and fail closed (Task 1).
- Non-ChipIn workspace record or wrong integration/access policy: exact-record assertions must reject it (Task 1).
- Accidental personal/runtime dependency in canon or live org prose: exact forbidden-pattern scan must fail (Tasks 1–2).
- Consumer switched before producer is readable: rollout gate must stop publication until `.github@master` contains `docs/workflow/FLOW.md` (Tasks 3–5).
- Personal rollout later treats the old block as required: personal rollout roots/tests must exclude every ChipIn repository (Task 6).

---

### Task 1: Publish the organization-owned canon

**Files:**
- Create: `automation/workflow-canon.test.mjs`
- Create: `docs/workflow/FLOW.md`
- Create: `docs/workflow/workspace.yaml`
- Create: `docs/workflow/projects/index.md`
- Create: `docs/workflow/roles/workflow.md`
- Create: `docs/workflow/roles/core.md`
- Create: `docs/workflow/roles/planner.md`
- Create: `docs/workflow/roles/architect.md`
- Create: `docs/workflow/roles/executor.md`
- Create: `docs/workflow/roles/reviewer.md`
- Create: `docs/workflow/roles/auditor.md`
- Create: `docs/workflow/roles/publisher.md`
- Create: `docs/workflow/roles/models.md`
- Create: `docs/workflow/roles/documentation.md`
- Create: `docs/workflow/roles/context.md`
- Modify: `docs/workflow/README.md`

**Interfaces:**
- Consumes: approved design; current normative source files `FLOW.md`, `workspace.yaml`, `projects/index.md`, and `global/*.md` from the personal repository as migration input only.
- Produces: stable public paths under `https://github.com/ChipIn-one/.github/blob/master/docs/workflow/` used by all consumer routing blocks.

- [ ] **Step 1: Write the failing canon contract tests**

Create `automation/workflow-canon.test.mjs` with tests named:

- `ChipIn workspace contains exactly the four registered repositories`;
- `ChipIn records preserve integration access and context dependency policy`;
- `role index resolves every required role file`;
- `canon contains no personal workflow or personal workspace script dependency`;
- `workflow README declares the canonical reading order`.

Use `node:assert/strict`, `node:fs` and text/regex assertions only; add no YAML dependency. Assert the exact four repository names and exact branch/access values from Global Constraints. Walk the role names listed in `roles/workflow.md` and assert each relative target exists.

- [ ] **Step 2: Run the test to verify RED**

Run: `node --test automation/workflow-canon.test.mjs`

Expected: FAIL because `docs/workflow/FLOW.md`, workspace/index and roles do not exist and README lacks the reading order.

- [ ] **Step 3: Add the minimal ChipIn-scoped canon**

Adapt, do not mirror, the approved source:

- `FLOW.md` defines authority as org README/FLOW → exact workspace record → role index/selected role → target `AGENTS.md`/`.ai/context.md` → relevant local decisions/tasks/context dependencies.
- `workspace.yaml` contains schema version plus only the four exact repository records and their policy from Global Constraints.
- `projects/index.md` renders only those four records and their dependencies.
- `roles/*.md` preserve role boundaries and reviewer/publisher separation while replacing personal `scripts/workspace/*` references with the org admission/preflight contract in `automation/issue-intake.md`.
- `README.md` starts a `How to read` section with the exact canonical order and links every canonical file relatively.

- [ ] **Step 4: Run focused and full tests to verify GREEN**

Run:

```sh
node --test automation/workflow-canon.test.mjs
node --test automation/*.test.mjs
```

Expected: focused PASS; full suite PASS with 0 failures.

- [ ] **Step 5: Commit the producer canon**

```sh
git add automation/workflow-canon.test.mjs docs/workflow
git commit -m "docs(workflow): publish the ChipIn-scoped AI canon (#15)"
```

### Task 2: Switch `.github` operational routing to its own canon

**Files:**
- Modify: `AGENTS.md`
- Modify: `automation/README.md`
- Modify: `docs/workflow/README.md`
- Modify: `docs/workflow/onboarding.md`
- Modify: `docs/workflow/conformance.md` only if its remediation text names the personal canon after Task 1
- Test: `automation/workflow-canon.test.mjs`

**Interfaces:**
- Consumes: stable canon paths produced by Task 1.
- Produces: exact managed routing block template that FE, KB and BE copy in Tasks 3–5.

- [ ] **Step 1: Extend the failing tests for operational org references**

Add tests named:

- `.github managed routing block starts at the organization canon`;
- `.github operational workflow documentation has no personal canon dependency`;
- `onboarding publishes the exact organization routing order`.

Assert the managed block links `docs/workflow/README.md`, `FLOW.md`, `workspace.yaml`, `projects/index.md`, and `roles/workflow.md`; assert no `syllik/ai-workflow` in the four operational files listed above.

- [ ] **Step 2: Run the test to verify RED**

Run: `node --test automation/workflow-canon.test.mjs`

Expected: FAIL on current `AGENTS.md`, `automation/README.md`, and README transitional text.

- [ ] **Step 3: Replace org routing and transitional prose**

Replace the managed block with the Task 1 reading order. Remove the statement that roles stay in the personal repository until #15. Update onboarding so new repositories copy only the organization-owned block. Keep admission and repository-specific policy outside the managed block unchanged.

- [ ] **Step 4: Verify the producer branch**

Run:

```sh
node --test automation/workflow-canon.test.mjs
node --test automation/*.test.mjs
git grep -n 'syllik/ai-workflow' -- AGENTS.md automation/README.md docs/workflow ':!docs/superpowers/specs/**' ':!docs/superpowers/plans/**'
```

Expected: tests PASS; grep exits 1 with no operational matches.

- [ ] **Step 5: Commit the org cutover**

```sh
git add AGENTS.md automation/README.md docs/workflow automation/workflow-canon.test.mjs
git commit -m "docs(workflow): route ChipIn agents through the org canon (#15)"
```

- [ ] **Step 6: Review and publish the producer PR**

Run one normal reviewer and one independent security/trust-boundary reviewer on the complete `.github` diff. Fix blocking findings, rerun Task 2 Step 4, refresh #15 admission, push once, and open a PR to `master` with `Task identity: ChipIn-one/.github#15`.

**STOP GATE:** do not execute Tasks 3–6 until the human merges this PR and `gh api repos/ChipIn-one/.github/contents/docs/workflow/FLOW.md?ref=master` succeeds.

### Task 3: Switch frontend consumers

**Files (in `ChipIn-one/chipin-frontend`):**
- Modify: `AGENTS.md`
- Modify: `.ai/context.md`
- Modify: `docs/engineering/code-review.md`
- Modify: `docs/engineering/rules/70-testing.md`

**Interfaces:**
- Consumes: merged producer URLs from Tasks 1–2 and exact managed block from Task 2.
- Produces: frontend with no live personal workflow dependency.

- [ ] **Step 1: Create and admit a same-repository child Issue**

Use canonical `issue-intake.mjs apply create` to create a FE Task/P2/Todo owned by `syllik`, parent `ChipIn-one/.github#15`, with acceptance matching these four files. Require `INTAKE_COMPLETE`; use the returned number in branch `docs/issue-<number>-org-ai-canon`.

- [ ] **Step 2: Verify the producer gate**

Run: `gh api repos/ChipIn-one/.github/contents/docs/workflow/FLOW.md?ref=master --jq .sha`

Expected: a 40-character blob SHA. Stop if missing.

- [ ] **Step 3: Replace frontend operational references**

Copy the exact managed block from `.github@master`; replace prose references in the other three files with `ChipIn-one/.github/docs/workflow/`. Do not edit historical `docs/superpowers/specs/**` records.

- [ ] **Step 4: Verify frontend**

Run:

```sh
git diff --check
git grep -n 'syllik/ai-workflow' -- AGENTS.md .ai/context.md docs/engineering ':!docs/superpowers/specs/**'
npm run verify
```

Expected: grep exits 1 with no matches; `npm run verify` exits 0.

- [ ] **Step 5: Commit, review and publish**

Commit message: `docs: route frontend agents through the org canon (#<number>)`. Run one reviewer on the diff, refresh child-Issue admission, push once and open the PR to `master` using the repository helper when it succeeds; otherwise preserve its body contract and document the helper failure.

### Task 4: Switch knowledge-base consumers

**Files (in `ChipIn-one/chipin-knowledge-base`):**
- Modify: `AGENTS.md`
- Modify: `.ai/context.md`

**Interfaces:**
- Consumes: merged producer and exact managed block from Task 2.
- Produces: knowledge base with no live personal workflow dependency.

- [ ] **Step 1: Create and admit a same-repository child Issue**

Use canonical intake to create a KB Task/P2/Todo with explicit owner `syllik`, parent `ChipIn-one/.github#15`, and acceptance for the two files. Require `INTAKE_COMPLETE`; branch `docs/issue-<number>-org-ai-canon`.

- [ ] **Step 2: Verify producer and replace references**

Require the same GitHub contents read from Task 3 Step 2. Copy the exact managed block and change `.ai/context.md` to point to the org canon.

- [ ] **Step 3: Verify KB**

Run:

```sh
git diff --check
git grep -n 'syllik/ai-workflow' -- AGENTS.md .ai/context.md
```

Expected: diff check exits 0; grep exits 1 with no matches.

- [ ] **Step 4: Commit, review and publish**

Commit message: `docs: route knowledge agents through the org canon (#<number>)`. Run one reviewer, refresh admission, push once and open the PR to `master`.

### Task 5: Correct backend PR #235 before merge

**Files (in `ChipIn-one/chipin-backend`, branch `chore/issue-233-conformance-package`):**
- Modify: `AGENTS.md`
- Verify unchanged: `.ai/context.md`

**Interfaces:**
- Consumes: merged producer and managed block from Task 2.
- Produces: corrected existing PR #235; no replacement PR and no personal workflow dependency.

- [ ] **Step 1: Refresh backend task admission and producer gate**

Require `INTAKE_COMPLETE` for `ChipIn-one/chipin-backend#233` and require the producer contents read. Stop on either failure.

- [ ] **Step 2: Replace only the newly added managed block**

Replace the block added by PR #235 with the exact org-owned block. Keep the two action pin changes, `.ai/context.md`, existing backend policy, and PR target `develop` unchanged.

- [ ] **Step 3: Verify backend**

Run:

```sh
git diff --check origin/develop...HEAD
git grep -n 'syllik/ai-workflow' -- AGENTS.md .ai/context.md
./gradlew test
```

Expected: grep exits 1; Gradle tests exit 0.

- [ ] **Step 4: Commit, review and update the existing PR**

Commit message: `docs: route backend agents through the org canon (#233)`. Run one reviewer on the cumulative PR diff, push normally without rewriting history, and confirm PR #235 remains `CLEAN` with all required checks green.

### Task 6: Retire ChipIn from the personal rollout verifier

**Files (in `syllik/ai-workflow`):**
- Modify: `rollout.yaml`
- Modify: `test/rollout.test.mjs`
- Modify: `README.md` or the nearest rollout documentation only if it claims ChipIn is a managed rollout root

**Interfaces:**
- Consumes: merged org producer and switched consumer routing blocks.
- Produces: personal rollout no longer treats any ChipIn repository as a managed root or flags the org-owned routing block as drift.

- [ ] **Step 1: Write the failing retirement assertion**

Update the rollout policy test to assert `policy.roots` contains no value beginning `ChipIn-one/` and that resolved rollout projects contain no ChipIn repository.

- [ ] **Step 2: Run the focused test to verify RED**

Run: `node --test test/rollout.test.mjs`

Expected: FAIL because current roots include `.github` and frontend and derive KB.

- [ ] **Step 3: Remove ChipIn roots and stale expectations**

Remove `ChipIn-one/.github` and `ChipIn-one/chipin-frontend` from `rollout.yaml`; update fixtures/expectations only where they assert active rollout coverage. Do not delete generic ChipIn admission compatibility code in this task.

- [ ] **Step 4: Verify and commit**

Run:

```sh
node --test test/rollout.test.mjs
npm test
```

Expected: focused and full suites PASS. Commit: `chore: retire ChipIn personal workflow rollout` and publish through that repository's normal human-gated PR process.

### Task 7: Final cross-repository audit and issue state

**Files:** none unless a verified blocking finding requires a scoped correction.

**Interfaces:**
- Consumes: merged producer, FE, KB, BE and personal-retirement PRs.
- Produces: evidence that #15 acceptance is met; leaves #135 as the separately approved next task.

- [ ] **Step 1: Verify all integration branches**

For `.github@master`, FE@master, KB@master and BE@develop, fetch the integration branch and search operational files for both `github.com/syllik/ai-workflow` and ``syllik/ai-workflow``. Exclude historical `docs/superpowers/specs/**` and `docs/superpowers/plans/**` only.

Expected: no operational matches.

- [ ] **Step 2: Run the conformance audit**

Dispatch/observe the existing conformance audit through the authorized human/workflow route. Do not mutate from an Executor. Require no routing/context drift for all four repositories.

- [ ] **Step 3: Reconcile tracking Issues**

Add the verified PR/run evidence to #15 and #160. Close #15 only when every acceptance item and the migration-order evidence is present. Keep #135 open and start it in a fresh session/task; do not claim this migration fixes atomic Issue creation.
