<!-- ai-workflow:agents-routing:start -->
Canonical AI routing:
1. Read the canonical workflow: https://github.com/syllik/ai-workflow/blob/HEAD/FLOW.md.
2. Select one GitHub record from https://github.com/syllik/ai-workflow/blob/HEAD/workspace.yaml / https://github.com/syllik/ai-workflow/blob/HEAD/projects/index.md.
3. Read the role index https://github.com/syllik/ai-workflow/blob/HEAD/global/workflow.md, then only the selected role file.
4. On that record's `integrationBranch`, read target `AGENTS.md`, then `.ai/context.md`.
5. Read relevant `.ai/decisions.md`, task files, and required declared `contextDependencies`; block if required dependency context is unavailable.

GitHub Issue/PR entry never bypasses this route; use GitHub records only, no auto-discovery; legacy contexts are migration-only.
Canonical root: ~/Desktop/WORK
<!-- ai-workflow:agents-routing:end -->
For ChipIn issue creation in any registry repository with admission on (FE/BE/KB/`.github`), `gh issue create` alone is not completion. Follow [automation/issue-intake.md](automation/issue-intake.md) and finish explicit canonical Type/Priority/applicable Severity plus exactly one Project #5 membership with readable Status and read-back receipt. Native Milestone is optional release targeting, is preserved as-is, and does not authorize execution or completion. Project #5 Status uses `Backlog`, `Todo`, `In Progress`, with `Done` only as a derived mirror of native `closed/completed`; native Issue closure remains terminal authority. Shared UI forms use the manual finalizer described there.

When the active GitHub connector can create ordinary Issues but cannot write Organization Issue Fields / Issue Type / Projects v2 directly, do not stop after raw issue creation or report that canonical completion is impossible. Create the exact connector bridge request documented in [automation/issue-intake.md](automation/issue-intake.md); the bridge must complete the existing canonical intake and return a read-back receipt.

## Canonical Issue admission (org #53, scope by registry since #183)

For tasks in every registry repository whose `admission` capability is not `off` (`workflow-registry.yaml`: frontend, backend, knowledge base and `.github`), the authoritative metadata writer is `automation/issue-intake.mjs`. No agent may plan execution, create a task branch, publish or hand off a PR, or declare a connector request complete from a raw Issue URL, a queued bridge comment, or stale evidence. Run the live read-only `automation/issue-admission.mjs --issue ChipIn-one/<repo>#<number>` with the appropriate org read credential; require `INTAKE_COMPLETE` for the **exact current Issue revision**. Refresh at each controlled boundary; the receipt expires after 120 seconds. The required owner comes from the registry record (`owner`): FE and `.github` need native `syllik`, BE native `olegbal`, KB (`owner: null`) an explicit `--owner`; other human assignees are preserved. Treat unavailable org fields, Project #5, permissions, or mismatched revision as BLOCKED. Release-milestone control Issues have a separate narrow command and do not grant agent execution authority.

Org infrastructure tasks (`ChipIn-one/.github#N`) are admitted through the same path as any other registry repository: `issue-admission-preflight.mjs --issue ChipIn-one/.github#N` must return `INTAKE_COMPLETE` (owner `syllik` from the registry, Project #5, native blocker gate). The former per-task "bounded governance bootstrap" (`#53` only) is retired by [#183](https://github.com/ChipIn-one/.github/issues/183); no manual read-back substitutes for admission. External connectors cannot be intercepted at raw GitHub API creation; their *continuation* must stop until the canonical bridge emits a verified `INTAKE_COMPLETE` read-back. See [automation/issue-intake.md](automation/issue-intake.md).

## Read-only issue-based preflight routing (#119)

Before task execution in any registry repository with admission on (FE/BE/KB/`.github`, even before a PR exists), use `automation/issue-admission-preflight.mjs --issue ChipIn-one/<repo>#<number>` as the shared read-only entry. It reuses canonical `readAdmission()`; with no injected `GITHUB_TOKEN`, it tries the already-authenticated `gh api` session without extracting credentials. KB requires an explicit `--owner`. For connector-only execution, only an authenticated trusted `.github` producer artifact with authoritative run/source/artifact read-back, original <120s timestamp and full canonical revision can be consumed; ordinary Issue GET and intake-bridge QUEUED are not admission. Reproduce and recheck at every controlled boundary. Executor must not dispatch Actions or repair GitHub metadata. See [automation/issue-intake.md](automation/issue-intake.md). This separate #119 governance approval does not expand the historical #53/PR #57 bootstrap.

## Tests

Run the automation suite with `node --test automation/*.test.mjs` (CI: `.github/workflows/automation-tests.yml`, Node 24.21.0). The short form `node --test automation/` fails on Node 24+ (the directory is treated as a module); do not use it in docs, briefs or PR descriptions.
