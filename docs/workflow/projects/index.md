# ChipIn workspace project index

This page is for humans; [`workspace.yaml`](../workspace.yaml) is normative. Agents select their record from `workspace.yaml` as described in [FLOW.md](../FLOW.md) and do not need to read this page. Its columns are checked against `workspace.yaml` by `automation/workflow-canon.test.mjs`.

| Repository | Access | Status | Integration branch | Context | Read-only context dependencies |
| --- | --- | --- | --- | --- | --- |
| [ChipIn-one/.github](https://github.com/ChipIn-one/.github/tree/master) | managed | active | `master` | [.ai/context.md](https://github.com/ChipIn-one/.github/blob/master/.ai/context.md) | — |
| [ChipIn-one/chipin-frontend](https://github.com/ChipIn-one/chipin-frontend/tree/master) | managed | active | `master` | [AGENTS.md](https://github.com/ChipIn-one/chipin-frontend/blob/master/AGENTS.md) | [ChipIn-one/chipin-knowledge-base](https://github.com/ChipIn-one/chipin-knowledge-base/tree/master) (`master`), [ChipIn-one/.github](https://github.com/ChipIn-one/.github/tree/master) (`master`) |
| [ChipIn-one/chipin-backend](https://github.com/ChipIn-one/chipin-backend/tree/develop) | managed | active | `develop` | [.ai/context.md](https://github.com/ChipIn-one/chipin-backend/blob/develop/.ai/context.md) | [ChipIn-one/chipin-knowledge-base](https://github.com/ChipIn-one/chipin-knowledge-base/tree/master) (`master`), [ChipIn-one/.github](https://github.com/ChipIn-one/.github/tree/master) (`master`) |
| [ChipIn-one/chipin-knowledge-base](https://github.com/ChipIn-one/chipin-knowledge-base/tree/master) | managed | active | `master` | [.ai/context.md](https://github.com/ChipIn-one/chipin-knowledge-base/blob/master/.ai/context.md) | [ChipIn-one/.github](https://github.com/ChipIn-one/.github/tree/master) (`master`) |

`managed` means the repository may receive approved work. `read-only` applies only to a context dependency: the knowledge base provides shared product specification, and `ChipIn-one/.github` provides Issue admission tooling and this canon. Selecting a repository as a dependency never authorizes writes to it.
