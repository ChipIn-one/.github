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
For ChipIn FE/KB issue creation, `gh issue create` alone is not completion. Follow [automation/issue-intake.md](automation/issue-intake.md) and finish explicit canonical Type/Priority/applicable Severity plus exactly one Project #5 membership with readable Status and read-back receipt. Native Milestone is optional release targeting, is preserved as-is, and does not authorize execution or completion. Project #5 Status uses `Backlog`, `Todo`, `In Progress`, with `Done` only as a derived mirror of native `closed/completed`; native Issue closure remains terminal authority. Shared UI forms use the manual finalizer described there.

When the active GitHub connector can create ordinary Issues but cannot write Organization Issue Fields / Issue Type / Projects v2 directly, do not stop after raw issue creation or report that canonical completion is impossible. Create the exact connector bridge request documented in [automation/issue-intake.md](automation/issue-intake.md); the bridge must complete the existing canonical intake and return a read-back receipt.

## Canonical Issue admission (org #53)

For FE/BE/KB tasks, the authoritative metadata writer is `automation/issue-intake.mjs`. No agent may plan execution, create a task branch, publish or hand off a PR, or declare a connector request complete from a raw Issue URL, a queued bridge comment, or stale evidence. Run the live read-only `automation/issue-admission.mjs --issue ChipIn-one/<repo>#<number>` with the appropriate org read credential; require `INTAKE_COMPLETE` for the **exact current Issue revision**. Refresh at each controlled boundary; the receipt expires after 120 seconds. FE needs native `syllik`, BE native `olegbal`, KB an explicit `--owner`; other human assignees are preserved. Treat unavailable org fields, Project #5, permissions, or mismatched revision as BLOCKED. Release-milestone control Issues have a separate narrow command and do not grant agent execution authority.

Org infrastructure is not an automatic FE/BE/KB intake exception. For this initial rollout **only** `ChipIn-one/.github#53` is manually authorized as a bounded governance bootstrap, with current Issue ownership `syllik`, the human-approved #53 scope, and no generic Project bypass. Subsequent org tasks require an explicit reviewed bootstrap decision; this cannot be reused to admit normal work. External connectors cannot be intercepted at raw GitHub API creation; their *continuation* must stop until the canonical bridge emits a verified `INTAKE_COMPLETE` read-back. See [automation/issue-intake.md](automation/issue-intake.md).
