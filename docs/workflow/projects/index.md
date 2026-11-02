# ChipIn workspace project index

Select exactly one record for a task. The integration branch, access policy, and declared read-only context dependencies are normative in [`workspace.yaml`](../workspace.yaml). This index is a human-readable view of those four records only.

| Repository | Access | Status | Integration branch | Context | Read-only context dependencies |
| --- | --- | --- | --- | --- | --- |
| [ChipIn-one/.github](https://github.com/ChipIn-one/.github/tree/master) | managed | active | `master` | [.ai/context.md](https://github.com/ChipIn-one/.github/blob/master/.ai/context.md) | — |
| [ChipIn-one/chipin-frontend](https://github.com/ChipIn-one/chipin-frontend/tree/master) | managed | active | `master` | [.ai/context.md](https://github.com/ChipIn-one/chipin-frontend/blob/master/.ai/context.md) | [ChipIn-one/chipin-knowledge-base](https://github.com/ChipIn-one/chipin-knowledge-base/tree/master) (`master`) |
| [ChipIn-one/chipin-backend](https://github.com/ChipIn-one/chipin-backend/tree/develop) | read-only | active | `develop` | [.ai/context.md](https://github.com/ChipIn-one/chipin-backend/blob/develop/.ai/context.md) | [ChipIn-one/chipin-knowledge-base](https://github.com/ChipIn-one/chipin-knowledge-base/tree/master) (`master`) |
| [ChipIn-one/chipin-knowledge-base](https://github.com/ChipIn-one/chipin-knowledge-base/tree/master) | read-only | active | `master` | [.ai/context.md](https://github.com/ChipIn-one/chipin-knowledge-base/blob/master/.ai/context.md) | — |

`ChipIn-one/chipin-frontend` and `ChipIn-one/chipin-backend` depend on the knowledge base as read-only task context. The knowledge base does not authorize writes to its repository when selected as a dependency.
