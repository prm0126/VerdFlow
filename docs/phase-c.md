# Phase C: masters, rota and availability

Builds on the Phase B slice. Migration 2 adds `employees`, `rooms`, `shifts`, `absences` and
`password_links`; migration 1 is unchanged.

## Eligibility now

A radiologist receives new work only when all of these hold at the moment of the final gate:

active · hospital permission · modality privilege · team membership today · **on a rota shift** ·
**not on leave, a break or training** · status ready · fresh workstation heartbeat · capacity left ·
no rule exclusion · not already rejected by the destination for this study.

New exclusion reasons in the decision trace: `NO_SHIFT`, `ON_BREAK`, `ON_LEAVE`, `ON_TRAINING`, `ABSENT`.
The same checks run before the first send of a reservation that waited too long.

Shift, leave and break changes lock the radiologist's state row, the same lock the allocation gate
takes, so a reservation never relies on a rota fact that is changing at that moment. None of them
withdraws work a radiologist already holds.

`ROTA_REQUIRED=false` turns off the shift requirement for a demo without a rota. Leave and breaks
still apply.

## Rota (`rota/rota.service.ts`, Rota page)

- Shifts: reporting or on call, up to 36 hours, no overlaps for one radiologist.
- Leave, training and other absences need an end time. A break is started and ended from the
  Availability page and has no end until it is ended.
- Times are stored as UTC instants and shown in the viewer's time zone.
- Every change is audited.

## Rooms (`rooms` master)

Applies only once a hospital has rooms in the master. The room is read from PV1-3, second component.
A study is held for a coordinator (`room_hold`) when the room is unknown (`UNKNOWN_ROOM`), closed
(`ROOM_CLOSED`) or does not perform the modality (`ROOM_MODALITY_NOT_ALLOWED`). A room with no
modalities listed accepts any.

## Employees

An employee is the organisational person; a radiologist is the clinical profile and can link to one
employee. One employee links to at most one radiologist.

## Users

Administrators add users with roles. VerdFlow issues a single-use set-password link, valid for 72
hours, for the administrator to pass on; it never emails, displays or chooses a password. A new link
cancels the old one. Changing someone's roles or suspending them signs them out everywhere at once.
Administrators cannot suspend themselves or remove their own administrator role. Passwords need at
least 12 characters.

## Still to do

- Handover between shifts, and what happens to work held at the end of a shift.
- Recurring shift patterns and bulk rota import.
- Rota per hospital time zone (the hospital's IANA zone is stored but the rota screen uses the viewer's).
- Enterprise SSO and MFA.
