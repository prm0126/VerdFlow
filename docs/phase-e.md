# Phase E: operations and scale foundations

What could be built and measured in code now. National scale itself (100,000 HL7 messages a second)
needs infrastructure, partner traffic samples and staged load tests that this repository cannot
supply; the gap is listed at the end. Migrations 4 and 5 are appended; earlier ones are unchanged.

## Built

| Area | What | Where |
|---|---|---|
| Health | `GET /api/health` (liveness), `GET /api/ready` (database answers and schema matches this build; 503 otherwise) | `app.controllers.ts` `OpsController` |
| Metrics | `GET /api/metrics` in Prometheus format. Needs `METRICS_TOKEN` as a bearer token when set; otherwise served to this machine only, and never through the web entry point | `ops/metrics.ts` |
| Worker scaling | `WORKER_INTAKE_CONCURRENCY` and `WORKER_DELIVERY_CONCURRENCY` loops per process; any number of processes. Rows are claimed with `FOR UPDATE SKIP LOCKED` | `worker.ts` |
| Destination isolation | `max_in_flight` per outbound partner (default 4). A destination at its limit is skipped, so one slow partner cannot hold up the rest | `outbound/delivery.ts` |
| Intake rate limit | `INTAKE_RATE_PER_MINUTE` per sending address (default 60,000). Above it, 429 and the sender retries | `app.controllers.ts` |
| Archive | `pnpm archive --days 30` moves processed payloads into gzip NDJSON batch files with SHA-256, verified before the payload is removed; quarantined messages are kept; viewing an archived message says where it is | `ops/archive.ts` |
| Load test | `pnpm loadtest --rate 100 --seconds 20` measures acknowledgment and receipt-to-decision latency, writes a JSON report | `cli/loadtest.ts` |
| Deployment | Dockerfiles (API/worker, web on unprivileged nginx), `docker-compose.yml`, Kubernetes manifests with readiness/liveness probes, zone spreading, autoscaling and disruption budgets | `deploy/` |

Key metrics: `vf_intake_messages_total`, `vf_intake_ack_seconds`, `vf_intake_backlog_messages`,
`vf_intake_oldest_backlog_seconds`, `vf_outbound_messages{status}`, `vf_outbound_oldest_pending_seconds`,
`vf_studies{state}`, `vf_escalations_open{kind}`, `vf_tat_clocks_open{state}`, `vf_radiologists_available`,
`vf_decision_seconds_p95_15m`. Scale workers on backlog age, not CPU alone.

## Measured (21 October 2026, one 4-core VM, PostgreSQL on the same machine)

| Test | Result |
|---|---|
| 100 msg/s for 15 s, one worker (12 loops) | 1,500/1,500 accepted; ACK p95 16–23 ms; decision p95 ≈ 0.8 s; no backlog |
| Backlog of 2,000, one worker process (8 loops) | drained at 136 msg/s |
| Backlog of 3,000, two worker processes | drained at 171 msg/s (CPU-bound: four cores shared with PostgreSQL) |
| 250 msg/s intake | 3,000/3,000 accepted |

Found and fixed during these runs: the claim query re-read the whole backlog for every message
(1.2 s per claim at 2,000 waiting). Migration 5 adds queue indexes; the same claim now takes 0.2 ms.

These numbers describe this machine only. They are not a capacity result for national volumes.

## Not built (needs infrastructure and inputs)

- **Event backbone.** Replicated Kafka intake (RF 3, `acks=all`, min ISR 2) in place of `intake_messages`,
  and an outbox relay to destination streams. The intake and processor seams are where it plugs in.
- **Processing cells.** A versioned routing directory and several PostgreSQL clusters, each owning its
  reporting pools, with an explicit cross-cell transfer protocol.
- **Temporal** in place of the in-database timer loop.
- **Encrypted object storage** for the archive, with retention controls.
- **National load tests**: steady 100,000/s, 150,000/s catch-up, 200,000/s burst, skewed tenants, 24-hour
  soak, using real message mixes and destination behaviour; zone, broker, database and site failover drills.
- **SSO and MFA**, secrets manager, network policies, residency configuration per country.
