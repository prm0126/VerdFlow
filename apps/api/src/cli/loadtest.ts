import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hl7Timestamp } from '@vf/shared';
import { Pool } from 'pg';
import { loadConfig } from '../config';
import { one } from '../database/db';

/**
 * Load test for the intake → decision path on this machine. Sends ORM^O01 orders at a target rate,
 * measures acknowledgment latency at the HTTP boundary, then waits for every order to get an
 * allocation decision and measures receipt-to-decision latency from the database.
 *
 * The numbers describe this machine and configuration only. They are not a capacity certificate for
 * national volumes, which need the partitioned event backbone, several database cells and the agreed
 * message mix (see docs/phase-e.md).
 *
 * Needs the API and worker running. Usage:
 *   pnpm loadtest [--rate 100] [--seconds 20] [--concurrency 32] [--timeout 120]
 */
const args = process.argv.slice(2);
const flag = (name: string, fallback: number) => {
  const i = args.indexOf(name);
  const v = i >= 0 ? Number(args[i + 1]) : fallback;
  if (!Number.isFinite(v) || v <= 0) throw new Error(`${name} must be a positive number`);
  return v;
};
const rate = flag('--rate', 100);
const seconds = flag('--seconds', 20);
const concurrency = Math.floor(flag('--concurrency', 32));
const timeoutSeconds = flag('--timeout', 120);
const api = process.env.VERDFLOW_API ?? 'http://localhost:4000/api';
const keys = JSON.parse(readFileSync((process.env.DEV_KEYS_FILE || resolve(__dirname, '../../../../.dev-keys.json')), 'utf8')) as Record<string, string>;
const MODALITIES = [
  { svc: 'XRCHEST^X-ray chest', mod: 'XR', room: 'ROOM2' },
  { svc: 'CTCAP^CT chest abdomen pelvis', mod: 'CT', room: 'ROOM1' },
  { svc: 'USABDO^Ultrasound abdomen', mod: 'US', room: 'ROOM2' },
];

function order(run: string, n: number): string {
  const m = MODALITIES[n % MODALITIES.length];
  return [
    `MSH|^~\\&|RIS|CITYH|VERDFLOW|VERDFLOW|${hl7Timestamp(new Date())}||ORM^O01|LT${run}-${n}|P|2.5.1|||AL|NE`,
    `PID|1||LT${run}P${n}^^^CITYH^MR||Load^Test`,
    `PV1|1|O|RAD^${m.room}||||||||||||||||LTE${run}${n}`,
    `ORC|NW|LTPL${run}${n}|LT${run}${n}`,
    `OBR|1|LTPL${run}${n}|LT${run}${n}|${m.svc}|R|||||||||||||LT${run}${n}||||||${m.mod}`,
  ].join('\r');
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function main() {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl, max: 4 });
  const run = String(Date.now()).slice(-7);
  const total = Math.round(rate * seconds);
  const ackMs: number[] = [];
  const failures: Record<string, number> = {};
  let next = 0;
  const started = Date.now();

  console.log(`Sending ${total} orders at ${rate}/s for ${seconds}s with up to ${concurrency} in flight…`);
  const workerLoop = async () => {
    for (;;) {
      const n = next++;
      if (n >= total) return;
      const due = started + (n / rate) * 1000;
      const wait = due - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const t0 = performance.now();
      try {
        const res = await fetch(`${api}/integration/hl7`, {
          method: 'POST',
          headers: { authorization: `Bearer ${keys['key:RIS_SOURCE']}`, 'content-type': 'x-application/hl7-v2+er7' },
          body: order(run, n),
        });
        const text = await res.text();
        if (res.status === 200 && text.includes('MSA|CA')) ackMs.push(performance.now() - t0);
        else failures[`HTTP ${res.status}`] = (failures[`HTTP ${res.status}`] ?? 0) + 1;
      } catch (err) {
        const key = (err as Error).message.slice(0, 60);
        failures[key] = (failures[key] ?? 0) + 1;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, workerLoop));
  const sendSeconds = (Date.now() - started) / 1000;

  // Wait until every accepted order has a decision (assigned, or handed to a coordinator).
  const deadline = Date.now() + timeoutSeconds * 1000;
  let decided = 0;
  while (Date.now() < deadline) {
    decided = (await one<{ n: number }>(
      pool,
      `SELECT count(*)::int AS n FROM studies s WHERE s.accession LIKE $1 AND EXISTS (SELECT 1 FROM evaluations e WHERE e.study_id = s.id)`,
      [`LT${run}%`],
    ))!.n;
    if (decided >= ackMs.length) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const decisions = await pool.query<{ ms: number; outcome: string }>(
    `SELECT extract(epoch FROM e.created_at - m.received_at) * 1000 AS ms, e.outcome
       FROM studies s
       JOIN LATERAL (SELECT created_at, outcome FROM evaluations WHERE study_id = s.id ORDER BY created_at LIMIT 1) e ON true
       -- the order that created the study, not the reporting messages that came back later
       JOIN LATERAL (SELECT received_at FROM intake_messages WHERE study_id = s.id ORDER BY received_at LIMIT 1) m ON true
      WHERE s.accession LIKE $1`,
    [`LT${run}%`],
  );
  await pool.end();

  const acks = [...ackMs].sort((a, b) => a - b);
  const dec = decisions.rows.map((r) => Number(r.ms)).sort((a, b) => a - b);
  const outcomes: Record<string, number> = {};
  for (const r of decisions.rows) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  const report = {
    run,
    at: new Date().toISOString(),
    target: { rate, seconds, concurrency, total },
    sent: { accepted: acks.length, failures, seconds: Math.round(sendSeconds * 10) / 10, achievedRate: Math.round((acks.length / sendSeconds) * 10) / 10 },
    ackMs: { p50: Math.round(percentile(acks, 50)), p95: Math.round(percentile(acks, 95)), p99: Math.round(percentile(acks, 99)), max: Math.round(acks[acks.length - 1] ?? 0) },
    decisions: {
      decided: dec.length,
      undecidedAfterTimeout: acks.length - decided,
      outcomes,
      ms: { p50: Math.round(percentile(dec, 50)), p95: Math.round(percentile(dec, 95)), p99: Math.round(percentile(dec, 99)), max: Math.round(dec[dec.length - 1] ?? 0) },
    },
    worker: { intakeConcurrency: config.workerIntakeConcurrency, deliveryConcurrency: config.workerDeliveryConcurrency },
    note: 'Single machine, local PostgreSQL. Not a national capacity result.',
  };
  const dir = resolve(__dirname, '../../../../loadtest-results');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `loadtest-${run}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));

  console.log(`\nAccepted ${report.sent.accepted}/${total} at ${report.sent.achievedRate}/s` + (Object.keys(failures).length ? `, failures ${JSON.stringify(failures)}` : ''));
  console.log(`ACK latency ms     p50 ${report.ackMs.p50}  p95 ${report.ackMs.p95}  p99 ${report.ackMs.p99}  max ${report.ackMs.max}`);
  console.log(`Decision latency ms p50 ${report.decisions.ms.p50}  p95 ${report.decisions.ms.p95}  p99 ${report.decisions.ms.p99}  max ${report.decisions.ms.max}`);
  console.log(`Decisions ${report.decisions.decided} (${JSON.stringify(outcomes)}), still waiting ${report.decisions.undecidedAfterTimeout}`);
  console.log(`Report: ${file}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
