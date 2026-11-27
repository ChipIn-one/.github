# Tokens and secrets

Inventory of the personal access tokens behind the ChipIn workflow secrets ([#193](https://github.com/ChipIn-one/.github/issues/193)).
No secret value is ever written here. All tokens are fine-grained, owned by `syllik`, resource owner `ChipIn-one`.
Fine-grained tokens have no Checks permission; the audit reads check results through Actions jobs ([#189](https://github.com/ChipIn-one/.github/issues/189)).

## Workflow tokens

| Secret | Held by | Token | Used by | Minimal permissions | Expires |
| --- | --- | --- | --- | --- | --- |
| `CHIPIN_DEV_READ_TOKEN` | `.github` | `chipin-dev-readonly` | `conformance-audit`, `issue-admission-preflight`, `issue-metadata-finalize` (read), `kb-docs-validation`, `native-development-link`, `relationships-reconcile` (read) | all ChipIn repositories: Metadata, Contents, Issues, Pull requests, Actions, Administration (rules and protection) — Read-only; `Deployments: Read-only` on `deployment-receipt` repositories; organization Projects: Read-only | TBD |
| `CHIPIN_DEV_READ_TOKEN` | chipin-frontend, chipin-backend, chipin-knowledge-base | `chipin-admission-read` | admission (`frontend-ci`, `pr-metadata`, BE `pull-request-checks`), `native-development-link`, FE `prepare-release-qa` (also checks out `.github`) | all ChipIn repositories: Metadata, Contents, Issues, Pull requests — Read-only; organization Projects: Read-only | TBD |
| `CHIPIN_ISSUE_WRITE_TOKEN` | `.github`, chipin-frontend | TBD | `conformance-audit` (drift Issues), `frontend-production-completion`, `integration-completion`, `issue-intake-connector-bridge`, `issue-intake-drain-retry`, `issue-metadata-finalize` (apply), `relationships-reconcile` (apply), FE `prepare-release-qa` | all ChipIn repositories: Issues Read and write, Contents and Metadata Read-only, `Deployments: Read-only` on chipin-frontend; organization Projects: Read and write | TBD |
| `CHIPIN_COMPLETION_DISPATCH_TOKEN` | chipin-frontend | TBD | FE `forward-production-deployment` (`repository_dispatch` to `.github`) | `ChipIn-one/.github` only: Contents Read and write (required by the dispatches endpoint), Metadata Read-only | TBD |

`GITHUB_TOKEN` (release workflows) is the built-in job token and is not inventoried.

Two read tokens are kept on purpose: the product repositories hold the narrower `chipin-admission-read`, so a product workflow never carries Administration or Actions read on every repository.

## Other repository secrets

Not part of the workflow standard, listed so the inventory is complete:

- chipin-frontend: `CHIPIN_CONTRACT_SWAGGER_USER`, `CHIPIN_CONTRACT_SWAGGER_PASSWORD` (`contract-smoke`), `SLACK_WEBHOOK_CI` (CI and QA notifications).
- chipin-backend (owner `olegbal`): `DOCKER_HUB_USERNAME`, `DOCKER_HUB_PASSWORD` (image builds), `QODANA_TOKEN` (referenced by no workflow on `develop`), and the application and deployment secrets of the `production` and `staging` environments.

## Removed

- `CHIPIN_DEV_WRITE_TOKEN` (token and the `.github` secret): referenced by no workflow in `.github`, chipin-frontend, chipin-backend or chipin-knowledge-base.

## Renewal

Renew a token before its expiry, then update every secret copy listed in its row. A reminder exists for the earliest expiry.
