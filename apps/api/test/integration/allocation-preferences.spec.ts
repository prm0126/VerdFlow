import type { RuleSetDefinition } from '@vf/shared';
import { Pool } from 'pg';
import { AuthService } from '../../src/auth/auth.service';
import { AvailabilityService } from '../../src/availability/availability.service';
import { many, one } from '../../src/database/db';
import { IntakeService } from '../../src/intake/intake.service';
import { Processor } from '../../src/processing/processor';
import { RotaService } from '../../src/rota/rota.service';
import { RulesService } from '../../src/rules/rules.service';
import { order, resetDatabase, seed, TEST_URL, testConfig, type Fixture } from './helpers';

const config = testConfig();
const pool = new Pool({ connectionString: TEST_URL, max: 10 });
let fx: Fixture;

const rid = async (code: string) => (await one<{ id: string }>(pool, 'SELECT id FROM radiologists WHERE code = $1', [code]))!.id;

async function route(o: NonNullable<Parameters<typeof order>[0]>) {
  await new IntakeService(pool).receive(fx.inboundKey, order(o));
  const p = new Processor(pool, config);
  while (await p.processNext());
  const r = await one<{ code: string | null; reasons: unknown }>(
    pool,
    `SELECT r.code, e.candidates AS reasons FROM studies s
       JOIN LATERAL (SELECT candidates, selected_radiologist_id FROM evaluations WHERE study_id = s.id ORDER BY created_at DESC LIMIT 1) e ON true
       LEFT JOIN radiologists r ON r.id = e.selected_radiologist_id
      WHERE s.accession = $1`,
    [o.accession],
  );
  return { code: r!.code, candidates: r!.reasons as { code: string; reasons: string[]; eligible: boolean }[] };
}

async function publish(change: (d: RuleSetDefinition) => RuleSetDefinition) {
  const rules = new RulesService(pool);
  const current = (await rules.list()).find((r) => r.status === 'published')!;
  const draft = await rules.createDraft(change(current.definition), 'test', fx.adminId);
  await rules.submit(draft.id, fx.adminId);
  await rules.decide(draft.id, true, undefined, fx.approverId);
}

const clockIn = (code: string, minutesAgo: number | null) =>
  pool.query(`UPDATE radiologist_state SET clocked_in_at = ${minutesAgo === null ? 'NULL' : `now() - make_interval(mins => ${minutesAgo})`} WHERE radiologist_id = (SELECT id FROM radiologists WHERE code = $1)`, [code]);

beforeEach(async () => {
  await resetDatabase(pool);
  fx = await seed(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('whoever clocked in first', () => {
  it('gives the study to the radiologist who clocked in first this shift, when the rule set asks for it', async () => {
    await clockIn('R1', 10);
    await clockIn('R2', 40);
    await clockIn('R3', null);
    // Default ranking is least loaded, then code: R1.
    expect((await route({ accession: 'A1', modality: 'XR' })).code).toBe('R1');

    await publish((d) => ({ ...d, ranking: { prefer: 'earliest_clock_in' } }));
    await pool.query('UPDATE radiologist_state SET active_units = 0');
    expect((await route({ accession: 'A2', modality: 'XR' })).code).toBe('R2');
  });

  it('does not count a clock-in from before the current shift', async () => {
    await publish((d) => ({ ...d, ranking: { prefer: 'earliest_clock_in' } }));
    await clockIn('R2', 60 * 20); // yesterday
    await clockIn('R3', 5);
    expect((await route({ accession: 'A1', modality: 'XR' })).code).toBe('R3');
  });

  it('records the clock-in at the first heartbeat of a session and keeps it while presence continues', async () => {
    const availability = new AvailabilityService(pool, config);
    await pool.query('UPDATE radiologist_state SET heartbeat_at = NULL, clocked_in_at = NULL');
    await availability.heartbeat(['R1']);
    const first = (await one<{ t: Date }>(pool, `SELECT clocked_in_at AS t FROM radiologist_state WHERE radiologist_id = $1`, [await rid('R1')]))!.t;
    expect(first).not.toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    await availability.heartbeat(['R1']);
    expect((await one<{ t: Date }>(pool, `SELECT clocked_in_at AS t FROM radiologist_state WHERE radiologist_id = $1`, [await rid('R1')]))!.t).toEqual(first);

    // After a gap longer than the presence window, the next heartbeat is a new clock-in.
    // Clocked in 30 minutes ago, last heartbeat 10 minutes ago: presence lapsed.
    await pool.query(
      `UPDATE radiologist_state SET clocked_in_at = now() - interval '30 minutes', heartbeat_at = now() - interval '10 minutes' WHERE radiologist_id = $1`,
      [await rid('R1')],
    );
    await availability.heartbeat(['R1']);
    const later = (await one<{ t: Date }>(pool, `SELECT clocked_in_at AS t FROM radiologist_state WHERE radiologist_id = $1`, [await rid('R1')]))!.t;
    expect(later.getTime()).toBeGreaterThan(Date.now() - 5_000);

    // Going offline clears it.
    await availability.setStatus(await rid('R1'), 'offline', undefined, fx.adminId);
    expect((await one<{ t: Date | null }>(pool, `SELECT clocked_in_at AS t FROM radiologist_state WHERE radiologist_id = $1`, [await rid('R1')]))!.t).toBeNull();
  });

  it('counts a radiologist signing in to VerdFlow as clocking in, once per shift', async () => {
    await pool.query('UPDATE radiologist_state SET clocked_in_at = NULL');
    await pool.query(`UPDATE radiologists SET user_id = $1 WHERE code = 'R2'`, [fx.approverId]);
    const auth = new AuthService(pool, config);
    await auth.login('approver@test.local', 'correct horse battery');
    const t1 = (await one<{ t: Date }>(pool, `SELECT clocked_in_at AS t FROM radiologist_state WHERE radiologist_id = $1`, [await rid('R2')]))!.t;
    expect(t1).not.toBeNull();
    await auth.login('approver@test.local', 'correct horse battery');
    expect((await one<{ t: Date }>(pool, `SELECT clocked_in_at AS t FROM radiologist_state WHERE radiologist_id = $1`, [await rid('R2')]))!.t).toEqual(t1);
  });
});

describe('same patient, same specialty', () => {
  it('keeps the same radiologist across different encounters when the studies go to the same team', async () => {
    await publish((d) => ({ ...d, continuity: { enabled: true, matchOn: 'team' } }));
    const first = await route({ accession: 'A1', patient: 'P1', encounter: 'E1', modality: 'XR' });
    // Make that radiologist the busiest, so only continuity would bring the next study back to them.
    await pool.query('UPDATE radiologist_state SET active_units = 5 WHERE radiologist_id = (SELECT id FROM radiologists WHERE code = $1)', [first.code]);
    const second = await route({ accession: 'A2', patient: 'P1', encounter: 'E2', modality: 'XR' });
    expect(second.code).toBe(first.code);
    const ev = await one<{ continuity: { scopeKey: string; preserved: boolean } }>(
      pool,
      `SELECT e.continuity FROM evaluations e JOIN studies s ON s.id = e.study_id WHERE s.accession = 'A2'`,
    );
    expect(ev!.continuity).toMatchObject({ scopeKey: 'team:GENERAL', preserved: true });
  });

  it('with the default, a new encounter does not carry the radiologist over', async () => {
    const first = await route({ accession: 'A1', patient: 'P1', encounter: 'E1', modality: 'XR' });
    await pool.query('UPDATE radiologist_state SET active_units = 5 WHERE radiologist_id = (SELECT id FROM radiologists WHERE code = $1)', [first.code]);
    expect((await route({ accession: 'A2', patient: 'P1', encounter: 'E2', modality: 'XR' })).code).not.toBe(first.code);
  });

  it('still respects a break: the same doctor is skipped while on a planned break', async () => {
    await publish((d) => ({ ...d, continuity: { enabled: true, matchOn: 'team' } }));
    const first = await route({ accession: 'A1', patient: 'P1', modality: 'XR' });
    await new RotaService(pool).addAbsence(
      { radiologistId: await rid(first.code!), kind: 'break', startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 30 * 60_000).toISOString() },
      fx.adminId,
    );
    const second = await route({ accession: 'A2', patient: 'P1', modality: 'XR' });
    expect(second.code).not.toBe(first.code);
    expect(second.candidates.find((c) => c.code === first.code)!.reasons).toEqual(['ON_BREAK']);
  });
});

describe('CT to MSK radiologists', () => {
  it('routes CT to the MSK team and excludes radiologists without the MSK specialty', async () => {
    await fx.masters.save('teams', { code: 'MSK', name: 'Musculoskeletal' }, fx.adminId);
    const base = { externalId: 'X', grade: 'CONSULTANT', modalities: ['CT', 'XR'], hospitals: ['CITYH'] };
    await fx.masters.save('radiologists', { ...base, code: 'R1', fullName: 'Dr One', externalId: 'EXT-R1', specialties: [], teams: ['NEURO', 'GENERAL', 'MSK'] }, fx.adminId);
    await fx.masters.save('radiologists', { ...base, code: 'R2', fullName: 'Dr Two', externalId: 'EXT-R2', specialties: ['MSK'], teams: ['NEURO', 'GENERAL', 'MSK'] }, fx.adminId);
    await publish((d) => ({
      ...d,
      routing: [...d.routing, { id: 'ct-to-msk', name: 'CT to MSK', priority: 5, when: { fact: 'study.modality', op: 'eq', value: 'CT' }, teamCode: 'MSK', reasonCode: 'CT_TO_MSK' }],
      exclusions: [
        ...d.exclusions,
        {
          id: 'ct-needs-msk',
          name: 'CT needs MSK',
          when: { all: [{ fact: 'study.modality', op: 'eq', value: 'CT' }, { not: { fact: 'radiologist.specialties', op: 'contains', value: 'MSK' } }] },
          reasonCode: 'CT_NEEDS_MSK',
        },
      ],
    }));
    const r = await route({ accession: 'A1', modality: 'CT' });
    expect(r.code).toBe('R2');
    expect(r.candidates.find((c) => c.code === 'R1')!.reasons).toEqual(['RULE_UNKNOWN_FACT_CT_NEEDS_MSK']);
    const team = await one<{ team_code: string }>(pool, `SELECT a.team_code FROM assignments a JOIN studies s ON s.id = a.study_id WHERE s.accession = 'A1'`);
    expect(team!.team_code).toBe('MSK');
    // X-rays are not affected.
    expect((await route({ accession: 'A2', modality: 'XR' })).code).not.toBeNull();
    expect(await many(pool, `SELECT 1 FROM studies WHERE state = 'manual_review'`)).toHaveLength(0);
  });
});
