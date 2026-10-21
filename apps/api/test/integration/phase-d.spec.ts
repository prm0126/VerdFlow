import { buildAck, buildLifecycleMessage, parseHl7, readMsh, type LifecycleEvent, type RuleSetDefinition } from '@vf/shared';
import { Pool } from 'pg';
import { many, one } from '../../src/database/db';
import { IntakeService } from '../../src/intake/intake.service';
import { DeliveryWorker, type Transport } from '../../src/outbound/delivery';
import { Processor } from '../../src/processing/processor';
import { RulesService } from '../../src/rules/rules.service';
import { StudiesService } from '../../src/studies/studies.service';
import { VettingService } from '../../src/vetting/vetting.service';
import { PeerReviewService, sampleBucket } from '../../src/workflow/peer-review';
import { TimerWorker } from '../../src/workflow/timers';
import { order, resetDatabase, seed, TEST_URL, testConfig, type Fixture } from './helpers';

const config = testConfig();
const pool = new Pool({ connectionString: TEST_URL, max: 10 });
const intake = new IntakeService(pool);
const processor = new Processor(pool, config);
const timers = new TimerWorker(pool);
let fx: Fixture;
let seq = 0;

const accept: Transport = async (_u, body) => ({ status: 200, body: buildAck(readMsh(parseHl7(body)), 'AA', 'D1') });

async function drain() {
  while (await processor.processNext());
  const d = new DeliveryWorker(pool, config, accept);
  while (await d.deliverNext());
}

async function study(accession: string) {
  return (await one<{ id: string; state: string; state_reason: string | null; accepted_at: string | null; finalized_at: string | null; reported_by: string | null }>(
    pool,
    'SELECT id, state, state_reason, accepted_at, finalized_at, reported_by FROM studies WHERE accession = $1',
    [accession],
  ))!;
}

async function current(accession: string) {
  return one<{ id: string; version: number; status: string; code: string }>(
    pool,
    `SELECT a.id, a.version, a.status, r.code FROM assignments a JOIN radiologists r ON r.id = a.radiologist_id
      JOIN studies s ON s.id = a.study_id WHERE s.accession = $1 ORDER BY a.version DESC LIMIT 1`,
    [accession],
  );
}

/** The reporting side sends an event for the current assignment of a study. */
async function lifecycle(accession: string, kind: LifecycleEvent['kind'], opts: { key?: string; version?: number; reason?: string } = {}) {
  const a = (await current(accession))!;
  const raw = buildLifecycleMessage({
    kind,
    assignmentId: a.id,
    assignmentVersion: opts.version ?? a.version,
    accession,
    reason: opts.reason,
    controlId: `L${++seq}`,
    sendingFacility: 'TELERAD',
  });
  const r = await intake.receive(opts.key ?? fx.reportingKey, raw);
  expect(r.httpStatus).toBe(200);
  await drain();
  return (await one<{ status: string; reason_code: string }>(pool, 'SELECT status, reason_code FROM intake_messages WHERE id = $1', [r.intakeMessageId]))!;
}

async function routed(accession: string, extra: Parameters<typeof order>[0] = {}) {
  await intake.receive(fx.inboundKey, order({ accession, ...extra }));
  await drain();
}

async function publish(change: (d: RuleSetDefinition) => RuleSetDefinition) {
  const rules = new RulesService(pool);
  const current = (await rules.list()).find((r) => r.status === 'published')!;
  const draft = await rules.createDraft(change(current.definition), 'test', fx.adminId);
  await rules.submit(draft.id, fx.adminId);
  await rules.decide(draft.id, true, undefined, fx.approverId);
}

beforeEach(async () => {
  await resetDatabase(pool);
  fx = await seed(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('vetting', () => {
  beforeEach(async () => {
    await fx.masters.save('services', { code: 'CTCAP', name: 'CT CAP', modalityCode: 'CT', requiresVetting: true, vettingProtocols: ['Contrast', 'Non-contrast'] }, fx.adminId);
  });

  it('holds a study that needs vetting, then routes it once approved with a protocol', async () => {
    await routed('A1');
    expect((await study('A1')).state).toBe('awaiting_vetting');
    expect(await current('A1')).toBeNull();

    const vetting = new VettingService(pool, config);
    const s = await study('A1');
    await expect(vetting.decide(s.id, { decision: 'approve' }, fx.adminId)).rejects.toThrow('Choose a protocol');
    expect(await vetting.decide(s.id, { decision: 'approve', protocol: 'Contrast' }, fx.adminId)).toMatchObject({ outcome: 'approved', allocation: 'assigned' });
    expect((await study('A1')).state).toBe('reserved');
    await expect(vetting.decide(s.id, { decision: 'approve', protocol: 'Contrast' }, fx.adminId)).rejects.toThrow('no longer waiting');
  });

  it('ends the workflow when vetting rejects the request, and ignores later updates', async () => {
    await routed('A1');
    const s = await study('A1');
    await expect(new VettingService(pool, config).decide(s.id, { decision: 'reject', note: '' }, fx.adminId)).rejects.toThrow('Give a reason');
    await new VettingService(pool, config).decide(s.id, { decision: 'reject', note: 'Wrong test requested' }, fx.adminId);
    expect((await study('A1')).state).toBe('vetting_rejected');
    await intake.receive(fx.inboundKey, order({ accession: 'A1', orderControl: 'XO', control: 'UPD1' }));
    await drain();
    expect((await one<{ reason_code: string }>(pool, `SELECT reason_code FROM intake_messages WHERE control_id = 'UPD1'`))!.reason_code).toBe('STUDY_ALREADY_VETTING_REJECTED');
  });
});

describe('reporting lifecycle', () => {
  it('tracks acceptance, preliminary and final, and frees capacity at final', async () => {
    await routed('A1');
    expect((await study('A1')).state).toBe('awaiting_acceptance');
    expect(await lifecycle('A1', 'accepted')).toMatchObject({ status: 'processed', reason_code: 'ACCEPTED' });
    expect((await study('A1')).state).toBe('assigned');
    expect(await lifecycle('A1', 'accepted')).toMatchObject({ status: 'ignored', reason_code: 'ALREADY_ACCEPTED' });
    await lifecycle('A1', 'preliminary');
    expect((await study('A1')).state).toBe('preliminary');
    await lifecycle('A1', 'final');
    const s = await study('A1');
    expect(s.state).toBe('finalized');
    expect(s.reported_by).not.toBeNull();
    expect((await current('A1'))!.status).toBe('completed');
    const units = await many<{ active_units: number }>(pool, 'SELECT active_units FROM radiologist_state');
    expect(units.every((u) => u.active_units === 0)).toBe(true);
    // Nothing changes a finished study.
    expect(await lifecycle('A1', 'preliminary')).toMatchObject({ status: 'ignored', reason_code: 'ASSIGNMENT_COMPLETED' });
  });

  it('re-routes a declined study straight away, never back to the radiologist who declined', async () => {
    await routed('A1');
    const first = (await current('A1'))!;
    expect(await lifecycle('A1', 'declined', { reason: 'Outside my subspecialty' })).toMatchObject({ status: 'processed', reason_code: 'DECLINED_ASSIGNED' });
    await drain();
    const second = (await current('A1'))!;
    expect(second.version).toBe(2);
    expect(second.code).not.toBe(first.code);
    const ev = await one<{ candidates: { code: string; reasons: string[] }[] }>(
      pool,
      `SELECT candidates FROM evaluations e JOIN studies s ON s.id = e.study_id WHERE s.accession = 'A1' ORDER BY e.created_at DESC LIMIT 1`,
    );
    expect(ev!.candidates.find((c) => c.code === first.code)!.reasons).toContain('ALREADY_REJECTED_OR_DECLINED');
  });

  it('ignores an event for an older assignment version, and refuses lifecycle events from a source partner', async () => {
    await routed('A1');
    expect(await lifecycle('A1', 'accepted', { version: 7 })).toMatchObject({ status: 'ignored', reason_code: 'STALE_ASSIGNMENT_VERSION' });
    // Even when a source partner is allowed the facility, it may not send lifecycle events.
    await fx.masters.save('partners', { code: 'RIS', name: 'RIS', direction: 'inbound', allowedFacilities: ['CITYH', 'TELERAD'] }, fx.adminId);
    expect(await lifecycle('A1', 'accepted', { key: fx.inboundKey })).toMatchObject({ status: 'quarantined', reason_code: 'PARTNER_ROLE_NOT_ALLOWED' });
    expect((await study('A1')).state).toBe('awaiting_acceptance');
  });

  it('refuses orders from a reporting partner and HL7 from a presence partner', async () => {
    const raw = order({ accession: 'A1', facility: 'TELERAD' });
    await intake.receive(fx.reportingKey, raw);
    await drain();
    expect((await one<{ reason_code: string }>(pool, `SELECT reason_code FROM intake_messages`))!.reason_code).toBe('PARTNER_ROLE_NOT_ALLOWED');
    expect((await intake.receive(fx.presenceKey, order())).httpStatus).toBe(403);
  });
});

describe('coordinator reassignment', () => {
  it('takes a study back, tells the destination, and routes it to someone else', async () => {
    await routed('A1');
    await lifecycle('A1', 'accepted');
    const first = (await current('A1'))!;
    const studies = new StudiesService(pool, config);
    await expect(studies.reassign((await study('A1')).id, '', fx.adminId)).rejects.toThrow('reason');
    expect(await studies.reassign((await study('A1')).id, 'Radiologist went home unwell', fx.adminId)).toMatchObject({ outcome: 'assigned' });
    await drain();
    const second = (await current('A1'))!;
    expect(second.version).toBe(2);
    expect(second.code).not.toBe(first.code);
    const out = await many<{ kind: string }>(pool, `SELECT o.kind FROM outbound_messages o JOIN studies s ON s.id = o.study_id WHERE s.accession = 'A1' ORDER BY o.created_at`);
    expect(out.map((o) => o.kind)).toEqual(['assignment', 'cancellation', 'assignment']);
    // The old assignment's events no longer apply.
    const a1 = (await one<{ status: string }>(pool, 'SELECT status FROM assignments WHERE id = $1', [first.id]))!;
    expect(a1.status).toBe('released');

    await lifecycle('A1', 'preliminary');
    await expect(studies.reassign((await study('A1')).id, 'too late', fx.adminId)).rejects.toThrow('not yet reported');
  });
});

describe('turnaround timers and escalations', () => {
  beforeEach(async () => {
    await publish((d) => ({ ...d, tat: { warnAtPercent: 50, profiles: [{ priority: 'ROUTINE', intervals: [{ code: 'ready_to_accepted', minutes: 10 }, { code: 'ready_to_final', minutes: 60 }] }] } }));
  });

  it('starts clocks at ready, warns, breaches, escalates and records a late finish', async () => {
    await routed('A1');
    const s = await study('A1');
    const clocks = await many<{ interval_code: string; state: string; target_minutes: number; rule_set_version: number }>(
      pool,
      'SELECT interval_code, state, target_minutes, rule_set_version FROM tat_clocks WHERE study_id = $1 ORDER BY interval_code',
      [s.id],
    );
    expect(clocks).toEqual([
      { interval_code: 'ready_to_accepted', state: 'running', target_minutes: 10, rule_set_version: 2 },
      { interval_code: 'ready_to_final', state: 'running', target_minutes: 60, rule_set_version: 2 },
    ]);

    await pool.query(`UPDATE tat_clocks SET warn_at = now() - interval '1 second' WHERE interval_code = 'ready_to_accepted'`);
    expect((await timers.tick()).warned).toBe(1);
    expect((await timers.tick()).warned).toBe(0); // idempotent
    await pool.query(`UPDATE tat_clocks SET due_at = now() - interval '1 second' WHERE interval_code = 'ready_to_accepted'`);
    expect((await timers.tick()).breached).toBe(1);
    const open = await many<{ kind: string; reason_code: string }>(pool, 'SELECT kind, reason_code FROM escalations WHERE resolved_at IS NULL');
    expect(open).toEqual([{ kind: 'tat_breach', reason_code: 'ready_to_accepted' }]);

    await lifecycle('A1', 'accepted');
    expect((await one<{ state: string }>(pool, `SELECT state FROM tat_clocks WHERE interval_code = 'ready_to_accepted'`))!.state).toBe('met_late');
    expect(await many(pool, 'SELECT 1 FROM escalations WHERE resolved_at IS NULL')).toHaveLength(0);
  });

  it('keeps the target a clock started with when the rules change', async () => {
    await routed('A1');
    await publish((d) => ({ ...d, tat: { warnAtPercent: 50, profiles: [{ priority: 'ROUTINE', intervals: [{ code: 'ready_to_final', minutes: 5 }] }] } }));
    await lifecycle('A1', 'accepted');
    expect((await one<{ target_minutes: number }>(pool, `SELECT target_minutes FROM tat_clocks WHERE interval_code = 'ready_to_final'`))!.target_minutes).toBe(60);
  });

  it('stops clocks when a study is cancelled', async () => {
    await routed('A1');
    await intake.receive(fx.inboundKey, order({ accession: 'A1', orderControl: 'CA', control: 'CAN1' }));
    await drain();
    expect((await many<{ state: string }>(pool, 'SELECT state FROM tat_clocks')).map((c) => c.state)).toEqual(['cancelled', 'cancelled']);
  });

  it('raises an escalation for every study waiting for a coordinator, and clears it when the study moves on', async () => {
    await pool.query(`UPDATE radiologist_state SET status = 'offline'`);
    await routed('A1');
    expect((await timers.tick()).raised).toBe(1);
    expect((await timers.tick()).raised).toBe(0);
    await pool.query(`UPDATE radiologist_state SET status = 'ready'`);
    await new StudiesService(pool, config).reallocate((await study('A1')).id, fx.adminId);
    expect((await timers.tick()).resolved).toBe(1);
  });
});

describe('peer review', () => {
  async function finalised(accession: string) {
    await routed(accession, { priority: 'R' });
    await lifecycle(accession, 'final');
  }

  it('samples steadily, never picks the reporter, and respects the daily cap', async () => {
    await publish((d) => ({ ...d, peerReview: { enabled: true, percent: 100, dailyCapPerReviewer: 1 } }));
    for (const acc of ['A1', 'A2', 'A3', 'A4']) await finalised(acc);
    const tasks = await many<{ status: string; skip_reason: string | null; reporter: string; reviewer: string | null }>(
      pool,
      `SELECT t.status, t.skip_reason, rep.code AS reporter, rev.code AS reviewer FROM peer_review_tasks t
         JOIN studies s ON s.id = t.study_id JOIN radiologists rep ON rep.id = t.reporter_id LEFT JOIN radiologists rev ON rev.id = t.reviewer_id
        ORDER BY s.accession`,
    );
    expect(tasks).toHaveLength(4);
    for (const t of tasks) expect(t.reviewer).not.toBe(t.reporter);
    const reviewers = tasks.filter((t) => t.reviewer).map((t) => t.reviewer);
    expect(new Set(reviewers).size).toBe(reviewers.length); // cap 1 each
    // R1 reported all four, so only R2 and R3 can review: one each, then the cap is reached.
    expect(tasks.filter((t) => t.status === 'open').map((t) => t.reviewer).sort()).toEqual(['R2', 'R3']);
    expect(tasks.filter((t) => t.status === 'skipped').map((t) => t.skip_reason)).toEqual(['ALL_REVIEWERS_AT_DAILY_CAP', 'ALL_REVIEWERS_AT_DAILY_CAP']);

    const id = (await study('A1')).id;
    expect(sampleBucket(id)).toBe(sampleBucket(id));
  });

  it('lets only the assigned reviewer record the outcome', async () => {
    await publish((d) => ({ ...d, peerReview: { enabled: true, percent: 100, dailyCapPerReviewer: 5 } }));
    await finalised('A1');
    const t = (await one<{ id: string; reviewer_id: string }>(pool, 'SELECT id, reviewer_id FROM peer_review_tasks'))!;
    const reviews = new PeerReviewService(pool);
    await expect(reviews.complete(t.id, { outcome: 'agree' }, fx.adminId)).rejects.toThrow('Only the assigned reviewer');
    await pool.query('UPDATE radiologists SET user_id = $2 WHERE id = $1', [t.reviewer_id, fx.approverId]);
    await reviews.complete(t.id, { outcome: 'minor_discrepancy', comment: 'Small miss' }, fx.approverId);
    await expect(reviews.complete(t.id, { outcome: 'agree' }, fx.approverId)).rejects.toThrow('not open');
  });

  it('does nothing when peer review is off', async () => {
    await finalised('A1');
    expect(await many(pool, 'SELECT 1 FROM peer_review_tasks')).toHaveLength(0);
  });
});
