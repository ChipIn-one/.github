# Release-scope retirement: inventory, mapping, rollback

Snapshot date: 2026-10-07. Authority: ChipIn-one/.github#34.

This is the bounded migration receipt for retiring the Organization Issue Field `Release scope`. It does not authorize bulk writes. Existing native Milestone assignments are human-owned and must not be recreated, renamed, or reassigned by inference.

## Existing concrete release

`POST RELEASE 1.1` already exists independently in frontend and backend as repository-scoped milestone #2, both due 2026-10-31.

- FE: 26 open issues.
- BE: 12 open issues.
- KB: no milestone currently required.

Same-named FE/BE milestones represent one product release by convention. Missing milestone is valid and is not a DEV-readiness blocker.

## Concrete mapping

| Observed state | Migration action |
| --- | --- |
| any legacy value + existing `POST RELEASE 1.1` | preserve milestone exactly; retire/clear only the legacy field after approved pilot/read-back |
| legacy `POST-PROD` + no milestone | retire/clear legacy field; leave milestone empty unless a human separately schedules the issue |
| legacy `PRE-PROD` + no milestone | do not invent a release; human release review first, then retire legacy field |
| no legacy value + existing milestone | no release-target write; milestone already is authority |
| neither value nor milestone | no release-target write |

Observed FE groups:

- `PRE-PROD + POST RELEASE 1.1`: #179.
- `PRE-PROD + no milestone`: #196.
- `POST-PROD + POST RELEASE 1.1`: #308, #217, #215, #198, #158, #157, #156, #153, #149, #148, #147, #146, #143, #137.
- `POST-PROD + no milestone`: #201, #197, #192, #191, #186, #159, #150, #145, #144, #141, #140, #139, #136, #135, #133, #132.
- `no legacy value + POST RELEASE 1.1`: #363, #362, #353, #324, #316, #315, #314, #279, #278, #277, #270.
- `no legacy value + no milestone`: #359, #337, #300, #271, #222.

Observed BE groups:

- `PRE-PROD + no milestone`: #91. Backend mutation requires backend-owner confirmation.
- `POST-PROD + POST RELEASE 1.1`: #151, #146, #109, #101, #99, #98, #93.
- `POST-PROD + no milestone`: #115, #108, #107, #105, #104, #103, #100, #97, #95.
- `no legacy value + POST RELEASE 1.1`: #157, #148, #145, #140, #138.
- `no legacy value + no milestone`: #159, #158, #150, #143.

KB #3/#4/#5 have neither legacy value nor milestone and require no release-target migration.

## Pilot

Preferred FE-only pilot, requiring explicit live-write capability and operator approval:

1. FE #179: conflict case. Preserve `POST RELEASE 1.1`; retire only legacy `PRE-PROD`; read back Type/Priority/Severity/Milestone/Project Status/native relationships.
2. FE #308: aligned case. Preserve `POST RELEASE 1.1`; retire only legacy `POST-PROD`; perform the same read-back.

Do not pilot BE #91 until its owner confirms backend release scope.

## Project #5 gaps

Fresh open issues outside Project #5 from the 2026-10-07 audit must be reconciled only after a fresh Project-capable read:

- FE: #363, #362, #359, #353, #337, #324, #316, #315, #314, #300, #279, #278, #277, #271, #270, #222.
- BE: #159, #158, #157, #150, #143, #140, #138.
- KB: none.

The reconciler may add missing membership and initialize `Backlog` only when Status is absent. It must not overwrite an existing human Status or duplicate membership.

## Retirement gate and rollback

Retire the organization field only when all are true:

1. active schema/config/intake/bridge/finalizer/readiness/docs no longer require it;
2. tests are green on the exact published SHA;
3. one or two approved pilots have clean post-write read-back;
4. approved mapping writes are complete;
5. fresh Project gap reconciliation has not overwritten human Status;
6. no active agent/workflow treats the legacy field as authority.

Before field retirement, rollback is code-only: revert the #34 code change and continue reading the still-existing legacy field. After field retirement, do not recreate or repopulate it automatically; use the recorded inventory plus native Milestones and human review to recover intent. A missing/unreadable receipt blocks retirement.
