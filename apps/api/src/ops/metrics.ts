import type { Pool } from 'pg';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { many, one } from '../database/db';

/**
 * Prometheus metrics. Counters and histograms are kept in this process; workflow gauges (backlog,
 * delivery states, escalations) are read from the database when Prometheus scrapes, so every API
 * replica reports the same totals.
 */
export function createMetrics(pool: Pool, presenceStaleSeconds: number) {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'vf_process_' });

  const intakeMessages = new Counter({
    name: 'vf_intake_messages_total',
    help: 'HL7 messages received at the intake boundary, by outcome',
    labelNames: ['outcome'] as const,
    registers: [registry],
  });
  const intakeAckSeconds = new Histogram({
    name: 'vf_intake_ack_seconds',
    help: 'Time from receiving an HL7 message to sending its acknowledgment (includes the durable write)',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });

  const gauge = (name: string, help: string, labelNames: string[], collect: (g: Gauge<string>) => Promise<void>) =>
    new Gauge({
      name,
      help,
      labelNames,
      registers: [registry],
      async collect() {
        await collect(this as Gauge<string>);
      },
    });

  gauge('vf_intake_backlog_messages', 'Intake messages waiting to be processed', [], async (g) => {
    g.set((await one<{ n: number }>(pool, `SELECT count(*)::int AS n FROM intake_messages WHERE status = 'received'`))!.n);
  });
  gauge('vf_intake_oldest_backlog_seconds', 'Age of the oldest intake message waiting to be processed', [], async (g) => {
    g.set(
      (await one<{ s: number }>(pool, `SELECT coalesce(extract(epoch FROM now() - min(received_at)), 0)::float AS s FROM intake_messages WHERE status = 'received'`))!.s,
    );
  });
  gauge('vf_intake_quarantined_messages', 'Intake messages in quarantine', [], async (g) => {
    g.set((await one<{ n: number }>(pool, `SELECT count(*)::int AS n FROM intake_messages WHERE status = 'quarantined'`))!.n);
  });
  gauge('vf_outbound_messages', 'Outbound HL7 messages by delivery state', ['status'], async (g) => {
    g.reset();
    for (const r of await many<{ status: string; n: number }>(pool, `SELECT status, count(*)::int AS n FROM outbound_messages GROUP BY status`)) {
      g.set({ status: r.status }, r.n);
    }
  });
  gauge('vf_outbound_oldest_pending_seconds', 'Age of the oldest outbound message not yet acknowledged', [], async (g) => {
    g.set(
      (await one<{ s: number }>(
        pool,
        `SELECT coalesce(extract(epoch FROM now() - min(created_at)), 0)::float AS s FROM outbound_messages WHERE status IN ('pending', 'retry', 'sending', 'unknown')`,
      ))!.s,
    );
  });
  gauge('vf_studies', 'Studies by clinical state', ['state'], async (g) => {
    g.reset();
    for (const r of await many<{ state: string; n: number }>(pool, `SELECT state, count(*)::int AS n FROM studies GROUP BY state`)) g.set({ state: r.state }, r.n);
  });
  gauge('vf_escalations_open', 'Open escalations by kind', ['kind'], async (g) => {
    g.reset();
    for (const r of await many<{ kind: string; n: number }>(pool, `SELECT kind, count(*)::int AS n FROM escalations WHERE resolved_at IS NULL GROUP BY kind`)) {
      g.set({ kind: r.kind }, r.n);
    }
  });
  gauge('vf_tat_clocks_open', 'Open turnaround clocks by state', ['state'], async (g) => {
    g.reset();
    for (const r of await many<{ state: string; n: number }>(pool, `SELECT state, count(*)::int AS n FROM tat_clocks WHERE stopped_at IS NULL GROUP BY state`)) {
      g.set({ state: r.state }, r.n);
    }
  });
  gauge('vf_radiologists_available', 'Radiologists ready with a fresh heartbeat', [], async (g) => {
    g.set(
      (await one<{ n: number }>(
        pool,
        `SELECT count(*)::int AS n FROM radiologist_state WHERE status = 'ready' AND heartbeat_at > now() - make_interval(secs => $1)`,
        [presenceStaleSeconds],
      ))!.n,
    );
  });
  gauge('vf_decision_seconds_p95_15m', 'P95 time from receipt to allocation decision over the last 15 minutes', [], async (g) => {
    g.set(
      (await one<{ s: number | null }>(
        pool,
        `SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM e.created_at - s.created_at))::float AS s
           FROM evaluations e JOIN studies s ON s.id = e.study_id WHERE e.created_at > now() - interval '15 minutes'`,
      ))!.s ?? 0,
    );
  });

  return { registry, intakeMessages, intakeAckSeconds };
}

export type Metrics = ReturnType<typeof createMetrics>;
