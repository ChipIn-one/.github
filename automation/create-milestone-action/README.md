# Repository-local milestone control

This composite action implements `ChipIn-one/.github#51`; policy code and
Node tests reside one directory above this `action.yml`. It uses the
**caller's** `GITHUB_TOKEN` and runner-provided `GITHUB_REPOSITORY`, so it
cannot create milestones in another repository.

A caller must use the `issues: opened/edited/reopened` event (plus optional
`workflow_dispatch` with a validated Issue number), a per-repository
`concurrency` group with `cancel-in-progress: false`, `queue: max`,
and exact SHA pinning to the approved shared action commit.

Only Issues whose title begins with `[create-milestone] ` are processed.
The title suffix is the milestone title. Body, as strictly parsed data:

```text
Description: Release delivery target
Due date: 2026-11-01
```

`Description` is required; `Due date` is optional (UTC YYYY-MM-DD).
The original Issue author must have `write`, `maintain` or `admin`
permission in the caller repository. Unauthorized/malformed requests do not
create milestones. Open and closed milestones are considered for dedup; an
existing closed milestone is never reopened. Success returns a URL, number and
state in a single bot receipt and closes the control Issue. Errors keep it open
with an actionable receipt, suitable for retries by editing or manual dispatch.

This does not migrate release-scope fields, update Project membership, assign
Issues, edit milestone due dates, or recreate `POST RELEASE 1.1`.
Tests: `node --test automation/create-milestone.test.mjs`.
Live acceptance requires separately merged default-branch caller workflows.
