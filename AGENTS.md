<!-- ai-workflow:agents-routing:start -->
Canonical AI routing:
1. Read the canonical workflow: https://github.com/syllik/ai-workflow/blob/HEAD/FLOW.md.
2. Select one GitHub record from https://github.com/syllik/ai-workflow/blob/HEAD/workspace.yaml / https://github.com/syllik/ai-workflow/blob/HEAD/projects/index.md.
3. Read role rules from https://github.com/syllik/ai-workflow/blob/HEAD/global/architect.md, https://github.com/syllik/ai-workflow/blob/HEAD/global/executor.md, or https://github.com/syllik/ai-workflow/blob/HEAD/global/reviewer.md.
4. On that record's `integrationBranch`, read target `AGENTS.md`, then `.ai/context.md`.
5. Read relevant `.ai/decisions.md`, task files, and required declared `contextDependencies`; block if required dependency context is unavailable.

Use GitHub records only. Legacy `projects/<project>/` contexts are migration-only; do not auto-discover repositories.
Canonical root: ~/Desktop/WORK
<!-- ai-workflow:agents-routing:end -->
