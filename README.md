## Summary

This PR proposes an ownership and workflow model for ChipIn development across:

* `ChipIn-one/chipin-frontend`
* `ChipIn-one/chipin-backend`
* `ChipIn-one/chipin-knowledge-base`
* `ChipIn-one/.github`
* the shared GitHub Project

The purpose is to define how frontend and backend participate in one product-level development scope before we implement Project automation.

This is intentionally a **discussion-only RFC**.

No automation is enabled by this PR, no Project statuses are changed, and no frontend/backend CI behavior is modified.

---

## Context

ChipIn development is currently distributed across separate frontend and backend repositories, while both repositories participate in the same product and the same GitHub Project.

A single product change may require:

* a shared behavior or contract change;
* backend implementation;
* frontend implementation;
* documentation/specification updates;
* multiple linked PRs.

Neither frontend nor backend should become the owner of shared development orchestration.

At the same time, `chipin-knowledge-base` is becoming the source of truth for shared product behavior and contracts.

We therefore need explicit ownership boundaries for:

1. GitHub Project automation.
2. Cross-repository development workflow.
3. Agent instructions.
4. FE/BE coordination.
5. Product-level task completion.
6. Project status transitions.

---

## Proposal

### 1. `ChipIn-one/.github` owns GitHub orchestration

`ChipIn-one/.github` should act as the GitHub control plane for shared organization-level mechanics.

It should own:

* reusable GitHub Actions workflows;
* GitHub Project automation;
* Project consistency and audit tooling;
* shared issue schema;
* shared issue templates;
* documentation for GitHub automation.

It should **not** own:

* product behavior;
* API contracts;
* frontend architecture;
* backend architecture;
* implementation-specific engineering rules.

Conceptually:

```text
ChipIn-one/.github
│
├── README.md
│
├── docs/
│   ├── project-model.md
│   └── project-automation.md
│
└── .github/
    └── workflows/
        ├── project-sync.yml
        └── project-audit.yml
```

---

### 2. `chipin-knowledge-base` owns the cross-repository development workflow

The knowledge base should own the canonical product-level development process shared by frontend and backend.

Suggested structure:

```text
chipin-knowledge-base/
│
├── AGENTS.md
│
└── common/
    ├── workflow/
    │   └── development.md
    ├── glossary.md
    ├── specs/
    └── adr/
```

The root `AGENTS.md` should act as the cross-repository entry point for development agents.

`common/workflow/development.md` should define the canonical lifecycle of a product-level change.

---

### 3. Frontend and backend keep repository-specific `AGENTS.md`

Each implementation repository should continue to own its own technical rules.

Frontend examples:

* React / TypeScript conventions;
* frontend architecture;
* frontend test strategy;
* frontend verification commands;
* frontend-specific implementation constraints.

Backend examples:

* Kotlin / Ktor conventions;
* backend architecture boundaries;
* database rules;
* backend tests;
* backend-specific implementation constraints.

The intended hierarchy is:

```text
GitHub Project issue
        ↓
chipin-knowledge-base/AGENTS.md
        ↓
common/workflow/development.md
        ↓
repository-specific AGENTS.md
        ↓
implementation
```

The shared layer defines **what repositories are involved and how the work progresses**.

The local layer defines **how the implementation is performed inside a repository**.

---

## Product-level work unit

### Proposal

One GitHub issue should represent one product-level unit of work.

A single issue may require changes in:

* knowledge base only;
* backend only;
* frontend only;
* knowledge base + backend;
* knowledge base + frontend;
* backend + frontend;
* knowledge base + backend + frontend.

All implementation PRs related to that product change should reference the same originating issue.

Example:

```text
Issue #123
"Support settlement note editing"

├── KB PR
│   └── behavior / contract update
│
├── Backend PR
│   └── API implementation
│
└── Frontend PR
    └── UI implementation
```

The issue is the product-level scope.

The PRs are implementation units inside that scope.

---

## Completion semantics

An issue should **not** automatically become `Done` merely because one linked PR was merged.

Example:

```text
Issue requires:
- backend change
- frontend change

Backend PR merged
Frontend PR still open
```

The product-level issue is not complete.

Completion should be based on:

* issue acceptance criteria;
* required linked PRs;
* required contract/spec updates;
* successful verification of the complete scope.

This avoids repository-local completion being mistaken for product-level completion.

---

## Project status as the canonical workflow state

Workflow status should live in the shared GitHub Project.

It should not be duplicated through status labels in individual repositories.

Current intended lifecycle:

```text
Backlog
  ↓
Todo
  ↓
In Progress
  ↓
DEV
  ↓
PROD
  ↓
Done
```

The exact semantics of each transition need agreement before automation is implemented.

---

## Proposed status semantics

### `Backlog`

The task exists but is not currently planned for execution.

### `Todo`

The task is accepted and ready to start.

Requirements and scope should be sufficiently clear for implementation.

### `In Progress`

At least one required implementation stream is actively being worked on.

This may include:

* knowledge base;
* backend;
* frontend.

### `DEV`

The complete required scope for the development environment has been integrated and is available for validation.

Important question:

Should `DEV` mean:

1. every required repository change is merged into its integration branch;

or

2. the feature is actually deployed and usable in the development environment?

This needs explicit agreement.

### `PROD`

The complete required scope is available in production.

This must be defined semantically, not merely as "merged to branch X".

### `Done`

All product-level acceptance criteria are satisfied.

Potential rule:

```text
Done requires:
- all required PRs merged;
- required KB/spec changes merged;
- required environment verification complete;
- issue acceptance criteria satisfied.
```

---

## Central automation with thin repository callers

Frontend and backend should not duplicate Project mutation logic.

Instead, each implementation repository should contain only a small workflow responsible for forwarding repository events into shared automation.

Conceptually:

```text
chipin-frontend
      │
      │ issue / PR / merge event
      ▼
thin caller workflow
      │
      │
      ├─────────────────────┐
                            ▼
                  ChipIn-one/.github
                  reusable workflow
                            │
      ┌─────────────────────┘
      │
      ▼
GitHub Project
      ▲
      │
      │
thin caller workflow
      ▲
      │
chipin-backend
```

The shared workflow should own:

* Project lookup;
* issue-to-Project-item resolution;
* status updates;
* consistency checks;
* linked PR evaluation;
* transition guards;
* audit logic.

Repository callers should own only:

* event forwarding;
* repository-specific configuration.

---

## Branch semantics must be repository-specific

Frontend and backend do not currently use identical branch structures.

Frontend currently has:

```text
dev
main
```

Backend currently uses:

```text
develop
```

Therefore the central workflow should **not** hard-code rules such as:

```text
merge to dev  => DEV
merge to main => PROD
```

Instead, repository callers should provide semantic configuration.

Example frontend configuration:

```yaml
integration_branch: dev
production_branch: main
```

Example backend configuration:

```yaml
integration_branch: develop
production_branch: null
```

The central workflow should reason in terms of:

```text
integration branch
production branch
```

rather than fixed branch names.

This also allows repository branching strategies to evolve without rewriting the shared Project automation.

---

## Knowledge-base gate

For changes affecting:

* domain behavior;
* shared terminology;
* HTTP/API contracts;
* user-visible product behavior;

the knowledge base should be checked before implementation begins.

Potential rule:

```text
behavior or contract change
        ↓
knowledge-base check
        ↓
existing requirement?
   /             \
 yes              no
  ↓                ↓
implement       update/add spec
                    ↓
                 implement
```

If implementation changes the agreed behavior or contract, the corresponding knowledge-base PR should be created before or alongside implementation.

Implementation repositories should not silently redefine product behavior.

---

## Proposed responsibility boundaries

### `ChipIn-one/.github`

Owns:

* GitHub tooling;
* Project automation;
* reusable Actions;
* shared issue mechanics;
* Project audit/consistency tooling.

Does not own:

* domain behavior;
* product requirements;
* API behavior;
* implementation architecture.

---

### `ChipIn-one/chipin-knowledge-base`

Owns:

* domain language;
* shared requirements;
* behavior specifications;
* API/HTTP contracts;
* ADRs;
* cross-repository development workflow;
* root agent workflow.

Does not own:

* detailed frontend implementation;
* detailed backend implementation;
* GitHub automation implementation.

---

### `ChipIn-one/chipin-frontend`

Owns:

* frontend implementation;
* frontend architecture;
* frontend CI and verification;
* frontend-specific agent instructions.

---

### `ChipIn-one/chipin-backend`

Owns:

* backend implementation;
* backend architecture;
* database/runtime implementation rules;
* backend CI and verification;
* backend-specific agent instructions.

---

## Why not put shared automation in frontend or backend?

If the Project workflow lives in `chipin-frontend`, frontend implicitly becomes the owner of backend orchestration.

If it lives in `chipin-backend`, backend implicitly becomes the owner of frontend orchestration.

Neither is a correct architectural boundary.

The Project exists above both implementation repositories.

Therefore its automation should also live above both implementation repositories.

`ChipIn-one/.github` already represents that organization-level GitHub boundary.

---

## Why not put GitHub automation in `chipin-knowledge-base`?

The knowledge base should describe product and engineering truth.

GitHub Actions implementation is infrastructure/tooling.

Mixing the two would make the knowledge base responsible for:

* GitHub tokens;
* workflow permissions;
* Project GraphQL/API behavior;
* automation implementation details.

That is a different concern from product specifications and development process.

The knowledge base should describe **the workflow semantics**.

`.github` should implement **the automation mechanics**.

---

## Intended architecture

```text
                    GitHub Project
                          │
                          │ workflow state
                          ▼
                 ChipIn-one/.github
                 GitHub control plane
                          │
              ┌───────────┴───────────┐
              │                       │
              ▼                       ▼
       chipin-frontend          chipin-backend
       implementation          implementation
              ▲                       ▲
              │                       │
              └───────────┬───────────┘
                          │
                          ▼
               chipin-knowledge-base
               product / contract truth
```

Another way to describe the responsibility split:

```text
.github
= HOW GitHub automation works

knowledge-base
= HOW product-level development should work

frontend/backend
= HOW each implementation is built
```

---

## Suggested implementation sequence

If this architecture is accepted:

1. Agree on this RFC.
2. Update the canonical Project/task model in `ChipIn-one/.github`.
3. Define exact Project status semantics.
4. Add cross-repository development documentation to `chipin-knowledge-base`.
5. Add/align root and repository-specific `AGENTS.md` gates.
6. Implement reusable Project automation in `.github`.
7. Add thin event callers to frontend/backend.
8. Add a Project consistency/audit workflow.
9. Create a disposable test issue requiring FE + BE work.
10. Run the complete lifecycle through the Project.
11. Only then enable automation for normal development.

---

## Questions for discussion

### Ownership

* [ ] Is `ChipIn-one/.github` the correct owner of GitHub Project automation?
* [ ] Is `chipin-knowledge-base` the correct owner of the canonical cross-repository development workflow?
* [ ] Should frontend/backend retain only repository-specific implementation rules?

### Work unit

* [ ] Should one GitHub issue represent one product-level unit of work across repositories?
* [ ] Should all FE/BE/KB PRs for one product change link to the same issue?
* [ ] Do we need any cases where separate FE and BE issues are preferable?

### Status lifecycle

* [ ] What exactly causes `Todo → In Progress`?
* [ ] What exactly causes `In Progress → DEV`?
* [ ] Does `DEV` mean "merged into integration branches" or "actually deployed to development"?
* [ ] What exactly causes `DEV → PROD`?
* [ ] What exactly causes `PROD → Done`?

### Multi-repository completion

* [ ] What happens when backend is merged but frontend is still open?
* [ ] What happens when frontend is merged but backend is still open?
* [ ] Should `Done` require every required linked PR to be merged?
* [ ] How do we determine which repositories are required for a particular issue?

### Knowledge base

* [ ] Should a KB update be mandatory for every behavior/API contract change?
* [ ] Should the KB PR be merged before implementation, or is "before or together with implementation" acceptable?
* [ ] How should implementation-only architecture decisions be separated from shared product specs?

### Branches / environments

* [ ] What are the intended backend integration and production branch semantics?
* [ ] Should Project automation work from semantic branch configuration rather than fixed branch names?
* [ ] Should Project status reflect merge state, deployment state, or both?

### Automation

* [ ] Which transitions can use native GitHub Project automation?
* [ ] Which transitions require custom GitHub Actions?
* [ ] Should an audit workflow detect issues with missing linked PRs or inconsistent Project states?
* [ ] Should automation only make deterministic transitions and leave ambiguous cases for manual review?

---

## Non-goals

This RFC does **not**:

* implement GitHub Project automation;
* modify any Project item;
* change frontend CI;
* change backend CI;
* change the branching strategy;
* create a new repository;
* change product behavior;
* change API contracts;
* enforce the proposed workflow yet.

---

## Review focus

For backend review, the main areas to validate are:

1. Whether `.github` is the correct owner of shared Project orchestration.
2. Whether the knowledge-base gate is compatible with backend development.
3. Backend integration/production branch semantics.
4. Multi-repository issue completion rules.
5. Whether `DEV`, `PROD`, and `Done` should be based on merges, deployments, acceptance criteria, or a combination.
6. Which parts of the lifecycle should be automated versus kept manual.

The goal of this PR is to agree on the architecture and semantics first, then implement automation separately.
