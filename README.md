# ChipIn-one/.github

Organisation-wide defaults and GitHub coordination tooling for `ChipIn-one`.

| Path | Purpose |
| --- | --- |
| `.github/ISSUE_TEMPLATE/` | shared Issue Forms: bug, enhancement, docs, tests, research |
| `github-issue-schema.md` | canonical task metadata model |
| `automation/` | fail-closed coordination policy and metadata migration tooling |

## Shared templates and repository overrides

Supported Issue Forms are owned here and set only native GitHub Issue Type: `Bug`, `Feature`, or `Task`. Priority, Severity, and Release scope remain Organization Issue Fields; Project #5 Status remains the workflow field.

GitHub uses the organization-profile Issue Forms only when a repository does not provide its own local template file. A repository-local template is therefore an explicit override and must remain compatible with the canonical schema or document why it differs.

Audited 2026-09-26:
- `chipin-frontend`: no local Issue Forms; shared forms apply.
- `chipin-backend`: no local Issue Forms; shared forms apply.
- `chipin-knowledge-base`: no local `.github` override found.

CODEOWNERS and GitHub Actions workflows are repository-local. They are not inherited as organization defaults and must be created/maintained in the repository whose ownership or execution policy they control.

Product/domain documentation lives in [chipin-knowledge-base](https://github.com/ChipIn-one/chipin-knowledge-base). Frontend/backend implementation and review policy stays in those repositories.


## DEV readiness automation

`automation/dev-readiness-live.mjs` is the fail-closed live reader for Project #5. The writer in `automation/dev-readiness-write.mjs` is intentionally narrower:

- the only mutation is Project #5 `Status -> DEV`;
- a write requires a fresh live evaluator result of `READY_FOR_DEV`;
- `PROD`, `Done`, closure and regression are never automated;
- a second fresh read is performed immediately before the single allowed write;
- each run can write at most one Project item;
- post-write state is read back; inconsistent read-back is reported for manual handling and is never auto-regressed;
- apply mode requires both `--activate dev-status-v1` and `CHIPIN_DEV_WRITE=1`.

The workflow `.github/workflows/dev-readiness-dev-transition.yml` supports manual dry-run/apply and an hourly scheduled scan. Scheduled writes remain disabled unless repository variable `CHIPIN_DEV_WRITE_ENABLED=1` is explicitly configured. Read-only runs use `CHIPIN_DEV_READ_TOKEN`; mutations use the separate `CHIPIN_DEV_WRITE_TOKEN`.


### Transition receipts and recovery

Every workflow run writes `dev-readiness-transition.json` and uploads it from the always-run artifact step as `dev-readiness-transition-<run-id>` with 30-day retention. For a scheduled run, open **Actions -> DEV readiness transition -> the exact run/attempt -> Artifacts** and inspect that receipt before taking recovery action. A missing receipt is itself an operational failure; the upload step does not silently warn.

Receipt outcomes deliberately distinguish normal scheduling from uncertain mutations:

- `complete`, clean `noop` / `noop-after-refresh`, routine `NOT_READY`, and `skipped-write-cap` do not make an `--all` scan fail; an exact apply that skips an explicitly requested issue because of the cap is reported as blocked/nonzero;
- `applied-but-read-back-inconsistent`, `applied-read-back-uncertain`, `mutation-outcome-uncertain`, and operational read exceptions require attention and make the run nonzero;
- before a mutation, the writer persists `mutation-intent-recorded`; after GitHub acknowledges the expected Project item it persists `mutation-returned-read-back-pending` before final verification.

Receipts are recovery evidence, not an exactly-once log. If the last durable receipt is an intent/pending/uncertain state, if post-write verification is inconsistent, or if a receipt is lost, never restore a previous Project status and never repeat the mutation solely from the receipt. Re-read the exact live issue, canonical metadata, readiness evidence, and current Project #5 Status first. `DEV`, `PROD`, and `Done` are never auto-regressed. A new write is considered only from that fresh live state and under the normal activation/authorization gates.
