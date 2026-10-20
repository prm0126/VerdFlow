import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/bootstrap';
import { AuthService } from '../../src/auth/auth.service';
import { many } from '../../src/database/db';
import { Processor } from '../../src/processing/processor';
import { order, resetDatabase, seed, TEST_URL, testConfig, type Fixture } from './helpers';

const config = testConfig();
const pool = new Pool({ connectionString: TEST_URL });
let app: INestApplication;
let fx: Fixture;

async function login(email: string) {
  const agent = request.agent(app.getHttpServer());
  await agent.post('/api/auth/login').set('x-requested-with', 'verdflow').send({ email, password: 'correct horse battery' }).expect(200);
  return agent;
}

beforeAll(async () => {
  await resetDatabase(pool);
  fx = await seed(pool);
  app = await createApp(config);
  await app.init();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('HTTP API', () => {
  it('accepts HL7 over HTTPS with a partner key and returns a commit ACK', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/integration/hl7')
      .set('authorization', `Bearer ${fx.inboundKey}`)
      .set('content-type', 'x-application/hl7-v2+er7')
      .send(order({ control: 'H1', accession: 'H1' }))
      .expect(200);
    expect(res.text).toContain('MSA|CA|H1');
    await request(app.getHttpServer()).post('/api/integration/hl7').set('content-type', 'text/plain').send(order()).expect(401);
  });

  it('records presence only from a partner key', async () => {
    await request(app.getHttpServer()).post('/api/integration/presence').send({ radiologistCodes: ['R1'] }).expect(401);
    const res = await request(app.getHttpServer())
      .post('/api/integration/presence')
      .set('authorization', `Bearer ${fx.presenceKey}`)
      .send({ radiologistCodes: ['R1', 'R2', 'NOBODY'] })
      .expect(200);
    expect(res.body).toEqual({ updated: 2 });
  });

  it('requires a session, the request header, and the right permission', async () => {
    await request(app.getHttpServer()).get('/api/studies').expect(401);
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'admin@test.local', password: 'correct horse battery' })
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('x-requested-with', 'verdflow')
      .send({ email: 'admin@test.local', password: 'wrong' })
      .expect(401);

    const viewer = await login('viewer@test.local');
    await viewer.get('/api/studies').expect(200);
    await viewer.get('/api/errors').expect(403);
    await viewer.put('/api/masters/teams').set('x-requested-with', 'verdflow').send({ code: 'X', name: 'X' }).expect(403);
    const admin = await login('admin@test.local');
    await admin.put('/api/masters/teams').send({ code: 'X', name: 'X' }).expect(403); // no request header
  });

  it('masks patient details without permission and audits raw HL7 views', async () => {
    await new Processor(pool, config).processNext();
    const viewer = await login('viewer@test.local');
    const [study] = (await viewer.get('/api/studies').expect(200)).body;
    expect(study.patient_name).toBe('P. T.');
    const detail = (await viewer.get(`/api/studies/${study.id}`).expect(200)).body;
    expect(detail.patient_identifier).toMatch(/^••••/);
    await viewer.get(`/api/messages/intake/${detail.intake[0].id}/raw`).expect(403);

    const admin = await login('admin@test.local');
    const raw = (await admin.get(`/api/messages/intake/${detail.intake[0].id}/raw`).expect(200)).body;
    expect(raw.payload).toContain('MSH|');
    expect((await many(pool, `SELECT 1 FROM audit_events WHERE action = 'hl7.raw_viewed'`)).length).toBe(1);
  });

  it('locks an account after five wrong passwords', async () => {
    const auth = new AuthService(pool, config);
    for (let i = 0; i < 5; i++) expect(await auth.login('approver@test.local', 'nope')).toBeNull();
    expect(await auth.login('approver@test.local', 'correct horse battery')).toBeNull();
    expect((await many(pool, `SELECT 1 FROM users WHERE email = 'approver@test.local' AND locked_until > now()`)).length).toBe(1);
  });

  it('rate-limits login attempts', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await request(app.getHttpServer()).post('/api/auth/login').set('x-requested-with', 'verdflow').send({ email: 'nobody@test.local', password: 'x' });
      statuses.push(r.status);
    }
    expect(statuses).toContain(429);
  });
});
