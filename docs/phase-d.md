# Phase D: clinical workflow and operations

Builds on Phases B and C. Migration 3 adds partner roles, vetting fields, milestone times,
`tat_clocks`, `escalations`, `peer_review_tasks` and `peer_review_daily`; earlier migrations are unchanged.

## Clinical states

received → **awaiting vetting** (if the service needs it) → ready → reserved → sent, awaiting
acceptance → **accepted by radiologist** → **preliminary** → **final**. Branches: not approved at
vetting, needs a coordinator, cancelled. Final, cancelled and not-approved studies ignore any later
order or reporting message (recorded as `STUDY_ALREADY_…`).

## Partner roles

Each inbound partner has one role: **source** (orders), **reporting** (acceptance and reports back) or
**presence** (workstation heartbeats). A message of the wrong kind for the partner is quarantined
(`PARTNER_ROLE_NOT_ALLOWED`); a presence partner cannot send HL7 at all.

## Vetting (`vetting/vetting.service.ts`, Vetting page)

Services marked "needs vetting" hold the study at `awaiting_vetting`. A user with the vetting
permission (the new Radiologist role) approves it with one of the service's protocols, which routes it
straight away, or does not approve it, with a reason, which ends the workflow. The decision takes the
same per-study lock as intake, so a cancel cannot cross it.

## Messages back from reporting (profile VF-LIFECYCLE-1, a proposal)

| Message | Meaning |
|---|---|
| ORM^O01, ORC-1 `OK` | Radiologist accepted |
| ORM^O01, ORC-1 `UA`, reason in ORC-16 | Radiologist declined |
| ORU^R01, OBR-25 `P` | Preliminary report |
| ORU^R01, OBR-25 `F` or `C` | Final report |

Every message must echo ZAS-1 (assignment ID) and ZAS-2 (version) from the assignment, plus the accession.
An event for an older version, or for an assignment that has ended, is ignored and recorded. A decline
releases capacity and routes again at once, never to the radiologist who declined. A final report
completes the assignment, releases capacity and records who reported it.

## Coordinator reassignment

From the study page, a coordinator can take back a study that is assigned but not yet reported. The
destination gets a cancellation if it may already hold the assignment, capacity is released, and the
study is routed again, never to the same radiologist. Reason required; audited.

## Turnaround timers (`workflow/milestones.ts`, `workflow/timers.ts`)

Targets live in the rule set, per priority, so they go through the same approval and versioning as
routing. Intervals use only events VerdFlow actually receives: received, ready, delivered, accepted,
preliminary, final. A clock starts when its first event happens and copies its target then, so later
rule changes do not move it. The worker checks clocks every 15 seconds: at the warning share of the
target the clock is "at risk", at the target it is "overdue", and each raises an escalation. Finishing
the step closes the clock as met or met late and closes its escalations. Cancelling stops all clocks.

## Escalations (Escalations page)

Raised for every study waiting for a coordinator, and for at-risk and overdue clocks. At most one open
per study, kind and reason. They close by themselves when the study moves on; coordinators acknowledge
them so the team can see someone has it. This is the in-database stand-in for Temporal timers; each
check is idempotent, so several workers can run it.

## Peer review (`workflow/peer-review.ts`, Peer review page)

Set in the rule set: on or off, the share of final reports to sample, and a daily limit per reviewer.
Sampling is stable (a hash of the study), so retries and replays never change it. The reviewer is never
the reporter, must hold the modality privilege and hospital permission, and is chosen by fewest reviews
today. The daily counter is locked, so concurrent finals cannot exceed the limit. When nobody can take a
sampled review, a skipped task records why (`NO_ELIGIBLE_REVIEWER`, `ALL_REVIEWERS_AT_DAILY_CAP`).
Only the assigned reviewer, signed in as themselves, can record the outcome: agree, minor or major
discrepancy.

## Still to do

- Temporal in place of the in-database timer loop; escalation levels and notifications.
- Pause rules for turnaround clocks and exam-start/exam-complete events once a source sends them.
- Corrected reports after final, and addenda.
- Peer review sampling by pool and period, and discrepancy follow-up.
- Phase E: national scale, cells, partitioned streams, load and failover tests.
