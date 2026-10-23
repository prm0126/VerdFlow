import type { INestApplication } from '@nestjs/common';
import { buildAck, parseHl7, readMsh } from '@vf/shared';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/bootstrap';
import { many, one } from '../../src/database/db';
import { MessagesService } from '../../src/messages/messages.service';
import { DeliveryWorker } from '../../src/outbound/delivery';
import { Processor } from '../../src/processing/processor';
import { resetDatabase, seed, TEST_URL, testConfig, type Fixture } from './helpers';

const config = testConfig();
const pool = new Pool({ connectionString: TEST_URL, max: 10 });
const messages = new MessagesService(pool);
let fx: Fixture;

async function drain() {
  const p = new Processor(pool, config);
  while (await p.processNext());
  const d = new DeliveryWorker(pool, config, async (_u, body) => ({ status: 200, body: buildAck(readMsh(parseHl7(body)), 'AA', 'D1') }));
  while (await d.deliverNext());
}

beforeEach(async () => {
  await resetDatabase(pool);
  fx = await seed(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('manual HL7', () => {
  it('sends a new order through the normal intake path and shows it in both logs', async () => {
    const t = await messages.template('new_order');
    expect(t.partner).toBe('RIS');
    expect(t.payload).toContain('\n'); // editable, one segment per line
    const r = await messages.send(t.partner!, t.payload, fx.adminId);
    expect(r).toMatchObject({ httpStatus: 200, outcome: 'accepted', partner: 'RIS' });
    expect(r.ack).toContain('MSA|CA|');
    await drain();

    const received = await messages.received({});
    expect(received[0]).toMatchObject({ partner_code: 'RIS', status: 'processed', message_type: 'ORM^O01' });
    const stored = await one<{ payload: string }>(pool, 'SELECT payload FROM intake_messages WHERE id = $1', [r.intakeMessageId]);
    expect(stored!.payload).not.toContain('\n'); // newlines became segment separators

    const sent = await messages.sent({});
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'assignment', status: 'accepted', ack_code: 'AA' });

    const audits = await many<{ detail: Record<string, unknown> }>(pool, `SELECT detail FROM audit_events WHERE action = 'hl7.manual_send'`);
    expect(audits).toHaveLength(1);
    expect(audits[0].detail).toMatchObject({ partner: 'RIS', outcome: 'accepted' });
    expect(JSON.stringify(audits)).not.toContain('PID|');
  });

  it('builds reporting replies for the current assignment, and they move the study on', async () => {
    const order = await messages.template('new_order');
    await messages.send(order.partner!, order.payload, fx.adminId);
    await drain();
    const accession = (await one<{ accession: string }>(pool, 'SELECT accession FROM studies'))!.accession;

    const accept = await messages.template('accept', accession);
    expect(accept.partner).toBe('REPORTING');
    await messages.send(accept.partner!, accept.payload, fx.adminId);
    await drain();
    expect((await one<{ state: string }>(pool, 'SELECT state FROM studies'))!.state).toBe('assigned');

    const final = await messages.template('final', accession);
    await messages.send(final.partner!, final.payload, fx.adminId);
    await drain();
    expect((await one<{ state: string }>(pool, 'SELECT state FROM studies'))!.state).toBe('finalized');
  });

  it('applies the same checks as a real partner', async () => {
    // Wrong facility for the partner: refused at the boundary, nothing stored.
    const t = await messages.template('new_order');
    const r = await messages.send('RIS', t.payload.replace('|CITYH|', '|OTHER|'), fx.adminId);
    expect(r).toMatchObject({ httpStatus: 403, outcome: 'rejected' });
    expect(await many(pool, 'SELECT 1 FROM intake_messages')).toHaveLength(0);
    // Not HL7 at all.
    expect((await messages.send('RIS', 'hello', fx.adminId)).httpStatus).toBe(400);
    // Presence partners and unknown partners cannot be used.
    await expect(messages.send('PACS', t.payload, fx.adminId)).rejects.toThrow('presence');
    await expect(messages.send('NOPE', t.payload, fx.adminId)).rejects.toThrow();
    await expect(messages.template('accept', 'NO-SUCH')).rejects.toThrow('No study');
  });
});

describe('HTTP permissions', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createApp(config);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('shows the logs and sending only to people with the HL7 permissions', async () => {
    const login = async (email: string) => {
      const agent = request.agent(app.getHttpServer());
      await agent.post('/api/auth/login').set('x-requested-with', 'verdflow').send({ email, password: 'correct horse battery' }).expect(200);
      return agent;
    };
    const viewer = await login('viewer@test.local');
    await viewer.get('/api/hl7/received').expect(403);
    await viewer.post('/api/hl7/send').set('x-requested-with', 'verdflow').send({ partner: 'RIS', payload: 'x' }).expect(403);

    const admin = await login('admin@test.local');
    await admin.get('/api/hl7/received').expect(200);
    await admin.get('/api/hl7/sent').expect(200);
    const t = (await admin.get('/api/hl7/templates/new_order').expect(200)).body;
    const r = (await admin.post('/api/hl7/send').set('x-requested-with', 'verdflow').send({ partner: t.partner, payload: t.payload }).expect(200)).body;
    expect(r.outcome).toBe('accepted');
  });
});
