# Where allocation is defined

| You want | Where | Setting |
|---|---|---|
| CT goes to radiologists who do MSK | **Rules** → routing rule | `If study.modality is CT → team MSK` (lower priority number wins) |
| …and never to someone without the MSK specialty | **Rules** → exclusion | `study.modality is CT` and not `radiologist.specialties includes MSK` |
| Who is in MSK and who has the specialty | **Masters → Teams** (MSK) and **Masters → Radiologists** (Teams, Specialties) | |
| The schedule is respected | **Rota** → shifts | No shift now = `NO_SHIFT`, no new work (`ROTA_REQUIRED=true`) |
| Breaks are respected | **Rota** → "Add leave, a planned break…" (planned), or **Availability** → Start/End break (now) | During a break = `ON_BREAK`, no new work |
| Whoever clocked in first gets the work first | **Rules** → Choosing the radiologist → "whoever clocked in first this shift" | Clock-in = first workstation heartbeat of the session, or the radiologist's own VerdFlow sign-in, whichever is earlier; only counts for the current shift; cleared when they go offline |
| Same patient, same specialty → same doctor | **Rules** → Choosing the radiologist → "the same patient and specialty (team)" | Within `CONTINUITY_WINDOW_HOURS` (default 24) |

Order used for every study, after the hard checks (shift, break, leave, status, presence, privileges,
hospital, capacity, exclusions): **same patient first → then earliest clock-in (or least loaded) →
then least loaded → then code.** The same patient's doctor is only preferred while they are eligible;
on a break or at capacity, the next person gets it and the trace says why.

Capacity is what spreads work when ranking by clock-in: the first person in gets studies until they
reach their work-unit capacity (Availability page), then the next.

Every decision's trace (study page → "Why this radiologist") shows the order used, each candidate's
load and clock-in time, and the reason anyone was excluded.

`pnpm db:seed` adds an MSK team and specialties to the demo data and submits an example rule set
("Example: CT to MSK radiologists…") for approval. Approve it as `approver@verdflow.local` on the Rules page.
Its CT rule (priority 5) is ahead of "CT head → Neuro" (priority 10); give CT head a lower number than 5
if head CTs should still go to neuroradiology.
