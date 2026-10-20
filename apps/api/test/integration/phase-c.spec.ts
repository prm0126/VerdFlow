import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { AuthService } from '../../src/auth/auth.service';
import { AvailabilityService } from '../../src/availability/availability.service';
import { createApp } from '../../src/bootstrap';
import { many, one } from '../../src/database/db';
import { IntakeService } from '../../src/intake/intake.service';
import { MasterError } from '../../src/masters/masters.service';
import { Processor } from '../../src/processing/processor';
import { RotaService } from '../../src/rota/rota.service';
import { UsersService } from '../../src/users/users.service';
import { order, resetDatabase, seed, TEST_URL, testConfig, type Fixture } from './helpers';

const config = testConfig();
const pool = new Pool({ connectionString: TEST_URL, max: 10 });
const rota = new RotaService(pool);
const users = new UsersService(pool);
let fx: Fixture;

const rid = async (code: string) => (await one<{ id: string }>(pool, 'SELECT id FROM radiologists WHERE code = $1', [code]))!.id;
const hours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

async function route(o: NonNullable<Parameters<typeof order>[0]>) {
  await new IntakeService(pool).receive(fx.inboundKey, order(o));
  const p = new Processor(pool, config);
  while (await p.processNext());
  const s = await one<{ id: string; state: string; state_reason: string | null }>(pool, 'SELECT id, state, state_reason FROM studies WHERE accession = $1', [o.accession]);
  const a = await one<{ code: string }>(
    pool,
    `SELECT r.code FROM assignments a JOIN radiologists r ON r.id = a.radiologist_id WHERE a.study_id = $1 AND a.status IN ('reserved','sent','delivered')`,
    [s!.id],
  );
  const ev = await one<{ candidates: { code: string; reasons: string[] }[]; outcome: string }>(
    pool,
    'SELECT candidates, outcome FROM evaluations WHERE study_id = $1 ORDER BY created_at DESC LIMIT 1',
    [s!.id],
  );
  return { study: s!, radiologist: a?.code ?? null, evaluation: ev! };
}

beforeEach(async () => {
  await resetDatabase(pool);
  fx = await seed(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('rota', () => {
  it('gives new work only to radiologists on shift', async () => {
    await pool.query(`DELETE FROM shifts WHERE radiologist_id IN ($1, $2)`, [await rid('R1'), await rid('R2')]);
    const r = await route({ accession: 'A1' });
    expect(r.radiologist).toBe('R3');
    expect(r.evaluation.candidates.find((c) => c.code === 'R1')!.reasons).toEqual(['NO_SHIFT']);
  });

  it('stops new work during a break and resumes when it ends', async () => {
    await pool.query(`DELETE FROM shifts WHERE radiologist_id IN ($1, $2)`, [await rid('R2'), await rid('R3')]);
    await rota.startBreak(await rid('R1'), fx.adminId);
    await expect(rota.startBreak(await rid('R1'), fx.adminId)).rejects.toThrow('already on a break');
    const during = await route({ accession: 'A1' });
    expect(during.study.state_reason).toBe('NO_ELIGIBLE_RADIOLOGIST');
    expect(during.evaluation.candidates.find((c) => c.code === 'R1')!.reasons).toEqual(['ON_BREAK']);

    await rota.endBreak(await rid('R1'), fx.adminId);
    expect((await route({ accession: 'A2' })).radiologist).toBe('R1');
  });

  it('excludes radiologists on leave, and shows why on the availability list', async () => {
    await rota.addAbsence({ radiologistId: await rid('R1'), kind: 'leave', startsAt: hours(-2), endsAt: hours(48) }, fx.adminId);
    const r = await route({ accession: 'A1' });
    expect(r.evaluation.candidates.find((c) => c.code === 'R1')!.reasons).toEqual(['ON_LEAVE']);
    const list = await new AvailabilityService(pool, config).list();
    expect(list.find((x) => x.code === 'R1')!.blockers).toEqual(['On leave']);
    expect(list.find((x) => x.code === 'R2')!.blockers).toEqual([]);
  });

  it('refuses overlapping shifts and open-ended leave, and audits rota changes', async () => {
    const id = await rid('R1');
    await expect(rota.addShift({ radiologistId: id, startsAt: hours(2), endsAt: hours(6) }, fx.adminId)).rejects.toThrow('overlaps');
    const s = await rota.addShift({ radiologistId: id, startsAt: hours(20), endsAt: hours(28) }, fx.adminId);
    await expect(rota.addShift({ radiologistId: id, startsAt: hours(30), endsAt: hours(80) }, fx.adminId)).rejects.toThrow('36 hours');
    await expect(rota.addAbsence({ radiologistId: id, kind: 'leave', startsAt: hours(1) }, fx.adminId)).rejects.toThrow('need an end time');
    await rota.deleteShift(s.id, fx.adminId);
    const actions = (await many<{ action: string }>(pool, `SELECT action FROM audit_events WHERE action LIKE 'rota.%' ORDER BY id`)).map((a) => a.action);
    expect(actions).toEqual(['rota.shift_added', 'rota.shift_removed']);
  });

  it('can be switched off for a demo without a rota', async () => {
    await pool.query('DELETE FROM shifts');
    await new IntakeService(pool).receive(fx.inboundKey, order({ accession: 'A1' }));
    await new Processor(pool, testConfig({ rotaRequired: false })).processNext();
    expect((await one<{ state: string }>(pool, `SELECT state FROM studies WHERE accession = 'A1'`))!.state).toBe('reserved');
  });
});

describe('rooms', () => {
  it('does not check rooms until the hospital has rooms in the master', async () => {
    const r = await route({ accession: 'A1' });
    expect(r.study.state).toBe('reserved');
  });

  it('holds studies for an unknown room, a closed room or a modality the room does not do', async () => {
    const save = (room: Record<string, unknown>) => fx.masters.save('rooms', { hospitalCode: 'CITYH', name: 'Room', ...room }, fx.adminId);
    await save({ code: 'ROOM1', modalities: ['CT'] });
    expect((await route({ accession: 'A1', modality: 'CT' })).study.state).toBe('reserved');

    expect((await route({ accession: 'A2', modality: 'XR' })).study.state_reason).toBe('ROOM_MODALITY_NOT_ALLOWED');
    await save({ code: 'ROOM1', modalities: ['CT'], status: 'closed' });
    const closed = await route({ accession: 'A3', modality: 'CT' });
    expect(closed.study).toMatchObject({ state: 'manual_review', state_reason: 'ROOM_CLOSED' });
    expect(closed.evaluation.outcome).toBe('room_hold');

    await save({ code: 'ROOM1', modalities: ['CT'], active: false });
    await save({ code: 'ROOM9' });
    expect((await route({ accession: 'A4' })).study.state_reason).toBe('UNKNOWN_ROOM');
  });
});

describe('employees', () => {
  it('links a radiologist to one employee only', async () => {
    await fx.masters.save('employees', { code: 'E1', fullName: 'Dr One' }, fx.adminId);
    const base = { fullName: 'Dr One', externalId: 'EXT-R1', grade: 'CONSULTANT', modalities: ['CT', 'XR'], hospitals: ['CITYH'], teams: ['NEURO', 'GENERAL'] };
    await fx.masters.save('radiologists', { ...base, code: 'R1', employeeCode: 'E1' }, fx.adminId);
    await expect(fx.masters.save('radiologists', { ...base, code: 'R2', employeeCode: 'E1' }, fx.adminId)).rejects.toThrow(MasterError);
    await expect(fx.masters.save('radiologists', { ...base, code: 'R2', employeeCode: 'NOPE' }, fx.adminId)).rejects.toThrow('No employee');
    const list = (await fx.masters.list('radiologists')) as { code: string; employeeCode: string | null }[];
    expect(list.find((r) => r.code === 'R1')!.employeeCode).toBe('E1');
  });
});

describe('users', () => {
  it('invites with a single-use set-password link and never handles a password', async () => {
    const { id, token } = await users.create({ email: 'New.User@Test.Local', fullName: 'New User', roles: ['coordinator'] }, fx.adminId);
    const auth = new AuthService(pool, config);
    expect(await auth.login('new.user@test.local', '')).toBeNull();
    expect(await users.checkLink(token)).toEqual({ email: 'new.user@test.local', fullName: 'New User' });
    await expect(users.setPassword(token, 'short')).rejects.toThrow('at least 12');
    await users.setPassword(token, 'a long enough passphrase');
    await expect(users.setPassword(token, 'another long passphrase')).rejects.toThrow('already been used');
    const session = await auth.login('new.user@test.local', 'a long enough passphrase');
    expect(session).not.toBeNull();

    // A new link replaces the old one.
    const first = await users.newLink(id, fx.adminId);
    const second = await users.newLink(id, fx.adminId);
    expect(await users.checkLink(first.token)).toBeNull();
    expect(await users.checkLink(second.token)).not.toBeNull();

    // Suspending signs the user out everywhere and kills outstanding links.
    await users.update(id, { status: 'suspended' }, fx.adminId);
    expect(await auth.resolve(session!.token)).toBeNull();
    expect(await users.checkLink(second.token)).toBeNull();
  });

  it('stops administrators locking themselves out', async () => {
    await expect(users.update(fx.adminId, { status: 'suspended' }, fx.adminId)).rejects.toThrow('your own account');
    await expect(users.update(fx.adminId, { roles: ['viewer'] }, fx.adminId)).rejects.toThrow('administrator role');
  });
});

describe('HTTP', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createApp(config);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('protects user management and the set-password endpoint', async () => {
    const viewer = request.agent(app.getHttpServer());
    await viewer.post('/api/auth/login').set('x-requested-with', 'verdflow').send({ email: 'viewer@test.local', password: 'correct horse battery' }).expect(200);
    await viewer.get('/api/users').expect(403);
    await viewer.post('/api/rota/shifts').set('x-requested-with', 'verdflow').send({}).expect(403);
    await viewer.get(`/api/rota?from=${hours(-24)}&to=${hours(24)}`).expect(200);

    const { token } = await users.create({ email: 'x@test.local', fullName: 'X', roles: ['viewer'] }, fx.adminId);
    await request(app.getHttpServer()).post(`/api/auth/password-link/${token}`).send({ password: 'a long enough passphrase' }).expect(403);
    await request(app.getHttpServer()).get('/api/auth/password-link/not-a-real-token').expect(404);
    await request(app.getHttpServer())
      .post(`/api/auth/password-link/${token}`)
      .set('x-requested-with', 'verdflow')
      .send({ password: 'a long enough passphrase' })
      .expect(200);
  });
});
