# Context policy

Project facts come from one exact [`workspace.yaml`](../workspace.yaml) record and the target repository's instructions. Read `AGENTS.md`, then `.ai/context.md` when the record declares it. Read only the task's declared `contextDependencies`, on their own integration branches, as read-only sources.

Unavailable, stale, unauthorized, or incomplete required context blocks work. Do not auto-discover repositories, silently omit required sources, or treat a context measurement as proof of semantic completeness. Issue admission, human task approval, and context admission are separate requirements.

This file is guidance for context selection; repository-specific facts and policies remain in the target's `AGENTS.md`, `.ai/context.md`, and relevant local decisions.
