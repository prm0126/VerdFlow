import type { INestApplication } from '@nestjs/common';
import { buildAck, parseHl7, readMsh } from '@vf/shared';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/bootstrap';
import { many, one } from '../../src/database/db';
import { IntakeService } from '../../src/intake/intake.service';
import { archiveIntake } from '../../src/ops/archive';
import { DeliveryWorker, type Transport } from '../../src/outbound/delivery';
import { Processor } from '../../src/processing/processor';
import { StudiesService } from '../../src/studies/studies.service';
import { order, resetDatabase, seed, TEST_URL, testConfig, type Fixture } from './helpers';

const config = testConfig();
const pool = new Pool({ connectionString: TEST_URL, max: 10 });
let fx: Fixture;

async function routed(n: number) {
  const intake = new IntakeService(pool);
  for (let i = 0; i < n; i++) await intake.receive(fx.inboundKey, order({ accession: `E${i}`, modality: 'XR' }));
  const p = new Processor(pool, config);
  while (await p.processNext());
}

beforeEach(async () => {
  await resetDatabase(pool);
  fx = await seed(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('per-destination in-flight limit', () => {
  it('never has more messages in flight to one destination than its limit', async () => {
    await pool.query(`UPDATE integration_partners SET max_in_flight = 2 WHERE code = 'DEST'`);
    await routed(6);
    let inFlight = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const slow: Transport = async (_u, body) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => release.push(r));
      inFlight--;
      return { status: 200, body: buildAck(readMsh(parseHl7(body)), 'AA', 'D1') };
    };
    const workers = Array.from({ length: 5 }, () => new DeliveryWorker(pool, config, slow));
    const running = workers.map((w) => w.deliverNext());
    await new Promise((r) => setTimeout(r, 400));
    expect(inFlight).toBe(2);
    expect((await one<{ n: number }>(pool, `SELECT count(*)::int AS n FROM outbound_messages WHERE status = 'sending'`))!.n).toBe(2);
    release.splice(0).forEach((r) => r());
    const results = await Promise.all(running);
    expect(results.filter((r) => r?.outcome === 'accepted')).toHaveLength(2);
    expect(peak).toBe(2);
  });
});

describe('archive', () => {
  it('moves old processed payloads to a verified file and keeps quarantined ones', async () => {
    await routed(3);
    await new IntakeService(pool).receive(fx.inboundKey, order({ accession: 'BAD', modality: 'PET' }));
    await new Processor(pool, config).processNext();
    await pool.query(`UPDATE intake_messages SET received_at = now() - interval '40 days'`);

    const dir = mkdtempSync(join(tmpdir(), 'vf-archive-'));
    expect(await archiveIntake(pool, dir, 30, 2)).toBe(3);
    const files = readdirSync(dir).filter((f) => f.endsWith('.ndjson.gz'));
    expect(files).toHaveLength(2); // batches of 2
    const lines = files.flatMap((f) => gunzipSync(readFileSync(join(dir, f))).toString().trim().split('\n'));
    expect(lines.map((l) => JSON.parse(l).payload.startsWith('MSH|')).every(Boolean)).toBe(true);

    const rows = await many<{ status: string; payload: string | null; archive_ref: string | null }>(pool, 'SELECT status, payload, archive_ref FROM intake_messages');
    expect(rows.filter((r) => r.payload === null && r.archive_ref)).toHaveLength(3);
    expect(rows.find((r) => r.status === 'quarantined')!.payload).not.toBeNull();
    expect(await archiveIntake(pool, dir, 30, 2)).toBe(0);

    const id = (await one<{ id: string }>(pool, `SELECT id FROM intake_messages WHERE payload IS NULL LIMIT 1`))!.id;
    expect(await new StudiesService(pool, config).rawMessage('intake', id, fx.adminId)).toMatch(/^\(Archived in intake-/);
  });
});

describe('health, readiness and metrics', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createApp(testConfig({ metricsToken: 'test-metrics-token' }));
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('reports health and readiness without signing in', async () => {
    await request(app.getHttpServer()).get('/api/health').expect(200, { status: 'ok' });
    const ready = await request(app.getHttpServer()).get('/api/ready').expect(200);
    expect(ready.body.status).toBe('ready');
  });

  it('is not ready when the schema is behind this build', async () => {
    const latest = (await one<{ v: number }>(pool, 'SELECT max(version)::int AS v FROM schema_migrations'))!.v;
    await pool.query('DELETE FROM schema_migrations WHERE version = $1', [latest]);
    const r = await request(app.getHttpServer()).get('/api/ready').expect(503);
    expect(r.body.reason).toContain(`needs ${latest}`);
  });

  it('serves Prometheus metrics only with the token, and counts intake', async () => {
    await request(app.getHttpServer()).get('/api/metrics').expect(401);
    await request(app.getHttpServer())
      .post('/api/integration/hl7')
      .set('authorization', `Bearer ${fx.inboundKey}`)
      .set('content-type', 'x-application/hl7-v2+er7')
      .send(order({ accession: 'M1' }))
      .expect(200);
    const m = await request(app.getHttpServer()).get('/api/metrics').set('authorization', 'Bearer test-metrics-token').expect(200);
    expect(m.text).toContain('vf_intake_messages_total{outcome="accepted"} 1');
    expect(m.text).toContain('vf_intake_backlog_messages 1');
    expect(m.text).toMatch(/vf_intake_ack_seconds_count 1/);
  });
});
