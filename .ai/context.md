# ChipIn organization GitHub coordination context

- Repository: `ChipIn-one/.github`.
- Purpose: shared GitHub issue schema/forms and organization-level Project coordination mechanics.
- Integration branch: `main`.
- This repository does not own frontend/backend executors, agent roles, code review, build/test/deploy workflows, product behavior, API semantics, or repository-specific technical rules.
- `ChipIn-one/chipin-knowledge-base` owns shared product/domain semantics and contract-change rules; HTTP wire shape remains code-first in backend runtime OpenAPI.
- Cross-repository product parent issues live in `ChipIn-one/chipin-knowledge-base` when decomposition across repositories is needed.
- Native sub-issues are required work; native blocking relations are dependencies; Development-linked PRs are implementation evidence; References are informational only and never gate status.
- `DEV` means every required change is integrated into its configured integration branch. Deployment is separate evidence.
- Code-related work terminates at `PROD`; standalone docs/research/external work terminates at `Done`.
- `PROD`, `Done`, and product-parent closure are manual in v1.
- A reopened required issue or changed required scope after `DEV` is reported as inconsistent; automation does not auto-regress status.
- Project automation is fail-closed: unreadable, missing, ambiguous, unauthorized, or inconsistent structured state blocks mutation.
- Human merge only.
