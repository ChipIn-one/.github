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
For ChipIn FE/KB issue creation, `gh issue create` alone is not completion. Follow [automation/issue-intake.md](automation/issue-intake.md) and finish explicit canonical Type/Priority/applicable Severity plus exactly one Project #5 membership with readable Status and read-back receipt. Native Milestone is optional release targeting, is preserved as-is, and does not authorize execution or completion. Project #5 Status is active workflow position only (`Backlog`, `Todo`, `In Progress`); native Issue closure is terminal authority. Shared UI forms use the manual finalizer described there.

When the active GitHub connector can create ordinary Issues but cannot write Organization Issue Fields / Issue Type / Projects v2 directly, do not stop after raw issue creation or report that canonical completion is impossible. Create the exact connector bridge request documented in [automation/issue-intake.md](automation/issue-intake.md); the bridge must complete the existing canonical intake and return a read-back receipt.
