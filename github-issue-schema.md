# GitHub issue schema v1

Canonical task model for ChipIn after the move off Trello. It is shared by
`chipin-backend` and `chipin-frontend` so cross-repository conventions stay
compatible — change it in both or in neither.

Sources: Trello [#472](https://trello.com/c/CBK778eG) (backend) and
[#471](https://trello.com/c/nMYb6RI9) (frontend).

## Axes

The four axes are independent. Do not encode any of them in the issue title.

| Axis | Where it lives | Values |
|---|---|---|
| Priority | label | `P0` `P1` `P2` `P3` |
| Severity | label, **defects only** | `severity: critical` `severity: major` `severity: minor` |
| Type | label | `type: bug` `type: enhancement` `type: research` `type: tests` `type: docs` |
| Release scope | milestone | `PRE-PROD` |
| Workflow status | GitHub Project field | not a label, not in the title |

**Priority is when we act. Severity is how bad it is when it happens.** They are
set independently: a rare data-corruption bug can be `P2` + `severity: critical`,
and a trivial-but-blocking typo can be `P0` + `severity: minor`.

### Priority

| | Meaning |
|---|---|
| `P0` | Drop other work. Broken invariant, blocked release, or active user harm. |
| `P1` | Next up. Blocks the release scope or another prioritized task. |
| `P2` | Normal. Planned work with no date pressure. |
| `P3` | Backlog. Do it when it becomes cheap or relevant. |

### Severity

Applies to `type: bug` only; leave it off everything else.

| | Meaning |
|---|---|
| `severity: critical` | Data loss, corruption, or full outage. |
| `severity: major` | Wrong behaviour with real user impact. |
| `severity: minor` | Cosmetic or narrow impact. |

### Type

Exactly one per issue.

### Milestone

`PRE-PROD` means the issue must be closed before the first production deploy.
It replaces the `[PRE-PROD]` prefix that Trello card titles used to carry.

## Issue body structure

The body has a fixed skeleton so issues stay comparable. GitHub renders each
issue-form field label as a **level-3** heading, so the skeleton uses `###`, not
`##`. Issues written by hand must match.

**Defect** (`type: bug`, form `bug.yml`)

| Section | Holds |
|---|---|
| `### Problem` | What is wrong, and what should happen instead. |
| `### Reproduction` | How to trigger it. Say so explicitly if it was found by reading code and never reproduced. |
| `### Evidence` | File/line references, logs, failing output, measurements. |
| `### Fix plan` | Checklist of what to change. Omit when the fix follows from the problem. |
| `### Acceptance criteria` | Checklist that decides when the issue closes. |

**Everything else** (forms `enhancement.yml`, `research.yml`, `tests.yml`, `docs.yml`)

| Section | Holds |
|---|---|
| `### Context` | Why this is needed and the current state in the code. |
| `### What to do` | The work itself. |
| `### Acceptance criteria` | Checklist that decides when the issue closes. |
| `### Out of scope` | What this issue explicitly does not cover. Optional. |

A trailing `### Notes`, `### References` or a named open question is allowed
after those; subsections inside a section use `####`. Nothing else goes above
`### Problem` / `### Context` except a first line linking the originating Trello
card, where one exists.

There is one form per `type:` value rather than a single generic one, because a
form can only preset a fixed label list — a shared form would leave every
non-defect issue without its type label.

Required fields use `placeholder`, never `value`: prefilled content satisfies
`validations.required` and would let a form be submitted with an empty checklist.

## What is deliberately absent

- **No ownership label.** The repository already says whether work is backend or
  frontend; `backend` / `frontend` labels would only duplicate it.
- **No status labels.** Status lives in the GitHub Project, so it cannot drift
  between two places.
- **No legacy severity words as priority.** The Trello labels `Critical`,
  `Major`, `Minor`, `Priority` and `PROD CRIT` mixed the two axes. They were
  reviewed one issue at a time during the migration, not mapped mechanically.

## Retained GitHub defaults

`question` (needs a decision before it can be worked), `duplicate`, `invalid`,
`wontfix`. `good first issue` and `help wanted` are unused but harmless.

## After cutover

New backend tasks are created only in GitHub. Migrated Trello cards keep a
comment linking to their issue and are archived on the board; issues that came
from Trello keep the card link at the top of the body.
