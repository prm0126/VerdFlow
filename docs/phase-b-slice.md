# Phase B: foundation and first vertical slice

What this slice covers from the architecture plan (v1.0, 20 October 2026), and what it does not.

## End-to-end path

1. **Intake** (`intake/intake.service.ts`). Partner API key, allowed sending facility, size limit. The
   message is committed to `intake_messages` before `MSA|CA` is returned. Partner-qualified key
   (sending application + facility + MSH-10) with a payload hash: a retry is a duplicate; the same
   key with different content is held in `intake_collisions` and never processed.
2. **Processing** (`processing/processor.ts`). Claimed with `FOR UPDATE SKIP LOCKED`; messages for one
   study (issuer + accession) are processed in arrival order. Parse and profile errors go to quarantine
   with a reason code. `NW` for an existing accession is a no-op (no second assignment). A cancel or
   update that arrives before its order waits and retries, then quarantines.
3. **Rules** (`packages/shared/src/rules.ts`). Typed, bounded condition trees over approved facts only.
   Missing facts are unknown: never a routing match, always an exclusion. Routing priorities must be
   unique, so two rules can never tie.
4. **Allocation and final gate** (`processing/allocator.ts`). One transaction. Lock order: study →
   patient-affinity guard → radiologist state row. Built-in checks: active, hospital permission,
   modality privilege, ready status, fresh heartbeat, capacity in work units; then rule exclusions.
   Ranking: previous radiologist for the patient (encounter, or a time window), then lowest load, then
   code. The chosen radiologist's row is locked and every check is repeated against committed data
   before the reservation. Credential, team and availability changes lock the same row. The evaluation
   (facts, rule set version, every candidate with reasons, continuity outcome), the assignment, the
   capacity reservation and the outbound message commit together.
5. **Delivery** (`outbound/delivery.ts`). Transactional outbox. The control ID is fixed when the
   decision is made and reused on every retry. No locks are held during the network call. ACK must
   correlate on MSA-2. Timeout or reset means "delivery uncertain": the reservation is kept and the
   same message is retried; a conflicting assignment is never sent. Connection refused means "not
   sent". AE/CE releases the reservation and asks a coordinator; routing again skips the rejected
   radiologist. A cancellation never overtakes its assignment message. An unsent reservation that
   waited too long is re-checked before its first send.

## Tested acceptance scenarios (`apps/api/test`)

From section 17 of the plan: 1 (receipt, decision and delivery kept apart), 2 (retried message), 3
(duplicate order with a new MSH-10), 4 (same-patient studies and capacity under concurrent workers),
5 (break, stale presence, withdrawn privilege), 6 (no eligible radiologist goes to a coordinator), 7
(cancel racing its order; cancel after delivery), 8 (lost ACK), 9 (malformed HL7, unknown codes), 11
(rule publication needs a second person, keeps the version), 12 (sessions, permissions, masked patient
details, audited raw HL7 views).

## Stand-ins for local development

| Plan | This slice | Swap later behind |
|---|---|---|
| Kafka intake stream | `intake_messages` table | `IntakeService.receive` / `Processor.processNext` |
| Outbox relay to Kafka | `outbound_messages` polled by the worker | `DeliveryWorker` |
| Temporal timers and escalation | Not yet; retries are scheduled in rows | Phase D |
| Enterprise SSO and MFA | Local accounts: scrypt passwords, lockout, HTTP-only SameSite cookie | Phase B/C |
| Mirth on both sides | `pnpm simulate` | Real partner channels |
| Reporting workstation presence | `POST /api/integration/presence` from a partner key | Agreed presence source |

## Not built yet

- Vetting, TAT timers and escalations, peer review (Phase D).
- Rota, shifts, leave and breaks as calendars (only the current status is held today), on-call, handover.
- Rule simulation and shadow evaluation; scheduled activation; rule scopes (national, regional, hospital).
- Accept/reject and report lifecycle events from the third party after the ACK.
- Room/location restrictions as their own rule type (rules can already test `study.room` and `study.location`).
- National scale: cells, partitioned streams, sharded databases, load tests (Phase E).
- User management screens (users are created by `pnpm db:seed` for now).
