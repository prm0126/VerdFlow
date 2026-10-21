# VerdFlow

Teleradiology workflow orchestrator: HL7 orders come in from a source Mirth, versioned rules choose a
team and a radiologist, the assignment is committed atomically, and an HL7 message goes out to a
third-party Mirth with its acknowledgment tracked.

This covers **Phase B** (foundation and first vertical slice), **Phase C** (masters, rota and
availability), **Phase D** (vetting, reporting lifecycle, turnaround timers, escalations, peer review),
**Phase E** (health, metrics, scaling, archive, load test, deployment) and the **assistant**. See
[docs/phase-b-slice.md](docs/phase-b-slice.md), [docs/phase-c.md](docs/phase-c.md), [docs/phase-d.md](docs/phase-d.md),
[docs/phase-e.md](docs/phase-e.md) and [docs/assistant.md](docs/assistant.md).

| Part | Where |
|---|---|
| API (NestJS, TypeScript) | `apps/api` |
| Background worker (intake processing, outbound delivery) | `apps/api/src/worker.ts` |
| Web app (React, TypeScript, Vite) | `apps/web` |
| HL7 helpers, rule model and evaluator | `packages/shared` |

## Run it locally

You need Node.js 20 or later, pnpm (`corepack enable`) and PostgreSQL with an empty database called `verdflow`.

```bash
git clone https://github.com/prm0126/VerdFlow.git
cd VerdFlow
git checkout claude/elegant-planck-66stmy
cp .env.example .env          # then put your PostgreSQL password into DATABASE_URL
pnpm install
pnpm db:migrate               # creates the tables in verdflow
pnpm db:seed                  # demo hospital, radiologists, rules, users and partner keys
```

`db:seed` prints the sign-in passwords and partner API keys once and saves them to `.dev-keys.json`
(git-ignored). Set `ADMIN_PASSWORD=...` before `pnpm db:seed` to choose the admin password yourself.

Then start three terminals:

```bash
pnpm dev          # API on http://localhost:4000 and web app on http://localhost:5173
pnpm dev:worker   # processes intake and delivers outbound HL7
pnpm simulate     # fake source Mirth, third-party Mirth and workstation presence
```

Open http://localhost:5173 and sign in as `admin@verdflow.local`.

Only radiologists on a rota shift receive new work. The seed gives every radiologist a 24-hour demo
shift; run `pnpm db:seed` again the next day, add shifts on the Rota page, or set `ROTA_REQUIRED=false`
in `.env` for a demo without a rota.

To add people, use **Users**: VerdFlow creates a single-use set-password link (valid for 72 hours) for you
to pass on. It never emails or shows passwords.

The simulator also plays the reporting radiologist: it accepts each assignment, then sends a preliminary
and a final report. Options: `--orders 20` sends 20 orders, `--reject-every 7` makes the destination
reject every 7th assignment, `--decline-every 4` makes the radiologist decline every 4th, and
`--report-seconds 20` sets how long reporting takes. MR brain needs vetting in the demo data: approve
it on the Vetting page. Sign in as `radiologist@verdflow.local` (Dr Asha Patel) to vet and to record
peer reviews.

## Assistant

Open **Assistant** and ask, for example, "What is scheduled under my name?". It works without an API key
(built-in answers). Put `ANTHROPIC_API_KEY=...` in `.env` and restart the API to use Claude, which also turns
on study explanations, the dashboard briefing and drafting rules from a description.

## Operations

```bash
pnpm loadtest --rate 100 --seconds 20   # needs the API, worker and simulator running
pnpm archive --days 30                  # move old processed HL7 payloads to ./archive
curl localhost:4000/api/ready           # readiness; /api/health for liveness; /api/metrics for Prometheus
POSTGRES_PASSWORD=choose-one docker compose up --build   # production-like stack on http://localhost:8080
```

## Tests

The API tests need a second, throwaway database (it is wiped on every run):

```sql
CREATE DATABASE verdflow_test;
```

Set `TEST_DATABASE_URL` in `.env`, then:

```bash
pnpm typecheck
pnpm --filter @vf/api exec jest --runInBand
```

## Sending HL7

```
POST /api/integration/hl7
Authorization: Bearer <inbound partner key>
Content-Type: x-application/hl7-v2+er7

MSH|^~\&|RIS|CITYH|VERDFLOW|VERDFLOW|20261020101500||ORM^O01|MSG0001|P|2.5.1|||AL|NE
PID|1||MRN123^^^CITYH^MR||Smith^Jane
PV1|1|O|RAD^ROOM1||||||||||||||||ENC77
ORC|NW|PL1|ACC1
OBR|1|PL1|ACC1|CTHEAD^CT head|S|||||||||||||ACC1||||||CT
```

The reply is a commit acknowledgment (`MSA|CA`), sent only after the message is stored. Clinical
processing happens afterwards, in the worker. Supported order controls: `NW` (new), `XO` (update),
`CA` (cancel). Accession is read from OBR-18, then ORC-3, then OBR-3; modality from OBR-24; priority from OBR-5.

The outbound assignment (profile `VF-ASSIGN-1`: ORM^O01 with a `ZAS` segment) is a starting proposal.
The real mapping must come from the interface specification agreed with the third party.
