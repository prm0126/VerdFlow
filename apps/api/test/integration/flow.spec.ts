import { buildAck, parseHl7, readMsh } from '@vf/shared';
import { Pool } from 'pg';
import { many, one } from '../../src/database/db';
import { ErrorsService } from '../../src/errors/errors.service';
import { IntakeService } from '../../src/intake/intake.service';
import { DeliveryWorker, NotSentError, type Transport } from '../../src/outbound/delivery';
import { Processor } from '../../src/processing/processor';
import { AvailabilityService } from '../../src/availability/availability.service';
import { RulesService } from '../../src/rules/rules.service';
import { StudiesService } from '../../src/studies/studies.service';
import { order, resetDatabase, seed, TEST_URL, testConfig, type Fixture } from './helpers';

const config = testConfig();
const pool = new Pool({ connectionString: TEST_URL, max: 20 });
const intake = new IntakeService(pool);
const processor = new Processor(pool, config);
let fx: Fixture;

/** Destination that answers AA for whatever it receives, and records what it saw. */
function acceptingTransport(seen: string[] = []): Transport {
  return async (_url, body) => {
    const msh = readMsh(parseHl7(body));
    seen.push(msh.controlId!);
    return { status: 200, body: buildAck(msh, 'AA', 'D1') };
  };
}

async function receive(raw: string) {
  const r = await intake.receive(fx.inboundKey, raw);
  expect(r.httpStatus).toBe(200);
  return r;
}

async function drain() {
  const results = [];
  for (let i = 0; i < 50; i++) {
    const r = await processor.processNext();
    if (!r) break;
    results.push(r);
  }
  return results;
}

async function studyByAccession(acc: string) {
  return one<{ id: string; state: string; state_reason: string | null }>(pool, 'SELECT id, state, state_reason FROM studies WHERE accession = $1', [acc]);
}

async function activeAssignment(studyId: string) {
  return one<{ id: string; radiologist_code: string; status: string }>(
    pool,
    `SELECT a.id, r.code AS radiologist_code, a.status FROM assignments a JOIN radiologists r ON r.id = a.radiologist_id
      WHERE a.study_id = $1 AND a.status IN ('reserved','sent','delivered')`,
    [studyId],
  );
}

async function setStatus(code: string, status: string) {
  const r = await one<{ id: string }>(pool, 'SELECT id FROM radiologists WHERE code = $1', [code]);
  await new AvailabilityService(pool, config).setStatus(r!.id, status, undefined, fx.adminId);
}

beforeEach(async () => {
  await resetDatabase(pool);
  fx = await seed(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('intake boundary', () => {
  it('acknowledges only authenticated, allowed senders, after storing the message', async () => {
    expect((await intake.receive('wrong-key-wrong-key-wrong', order())).httpStatus).toBe(401);
    expect((await intake.receive(fx.inboundKey, order({ facility: 'OTHERH' }))).httpStatus).toBe(403);
    expect((await intake.receive(fx.inboundKey, 'not hl7')).httpStatus).toBe(400);

    const r = await receive(order({ control: 'C1' }));
    expect(r.outcome).toBe('accepted');
    expect(r.ack).toContain('MSA|CA|C1');
    expect(await one(pool, 'SELECT 1 FROM intake_messages WHERE id = $1', [r.intakeMessageId])).toBeTruthy();
  });

  it('treats a retried message as a duplicate and a reused control ID with new content as a collision', async () => {
    const raw = order({ control: 'C1', accession: 'A1' });
    await receive(raw);
    expect((await receive(raw)).outcome).toBe('duplicate');
    expect((await receive(order({ control: 'C1', accession: 'A2' }))).outcome).toBe('collision');
    expect((await many(pool, 'SELECT 1 FROM intake_messages')).length).toBe(1);
    expect((await many(pool, 'SELECT 1 FROM intake_collisions')).length).toBe(1);
  });
});

describe('end-to-end slice', () => {
  it('routes, reserves, sends and records the ACK, keeping receipt, decision and delivery separate', async () => {
    await receive(order({ accession: 'A1', service: 'CTHEAD' }));
    const [res] = await drain();
    expect(res).toMatchObject({ status: 'processed', reasonCode: 'NEURO_SERVICE' });

    const study = await studyByAccession('A1');
    expect(study!.state).toBe('reserved');
    const evalRow = await one<{ rule_set_version: number; outcome: string; candidates: { eligible: boolean }[] }>(
      pool,
      'SELECT rule_set_version, outcome, candidates FROM evaluations WHERE study_id = $1',
      [study!.id],
    );
    expect(evalRow).toMatchObject({ rule_set_version: 1, outcome: 'assigned' });
    expect(evalRow!.candidates).toHaveLength(3);

    const seen: string[] = [];
    const delivery = new DeliveryWorker(pool, config, acceptingTransport(seen));
    expect(await delivery.deliverNext()).toMatchObject({ outcome: 'accepted' });
    expect(seen).toHaveLength(1);
    expect((await studyByAccession('A1'))!.state).toBe('awaiting_acceptance');
    expect((await activeAssignment(study!.id))!.status).toBe('delivered');
    expect(await delivery.deliverNext()).toBeNull();
  });

  it('never creates a second assignment for the same order under a new message ID', async () => {
    await receive(order({ control: 'X1', accession: 'A1' }));
    await receive(order({ control: 'X2', accession: 'A1' }));
    const results = await drain();
    expect(results.map((r) => r.status)).toEqual(['processed', 'ignored']);
    expect(results[1].reasonCode).toBe('DUPLICATE_ORDER');
    expect((await many(pool, 'SELECT 1 FROM assignments')).length).toBe(1);
  });

  it('quarantines malformed messages and unknown codes with a reason, and can requeue them', async () => {
    await receive(order({ accession: 'A1', modality: 'PET' }));
    await receive(order({ accession: 'A2', messageType: 'ADT^A01' }));
    const results = await drain();
    expect(results.map((r) => r.reasonCode).sort()).toEqual(['UNKNOWN_MODALITY', 'UNSUPPORTED_TYPE']);
    const quarantined = await many<{ id: string; reason_code: string }>(pool, `SELECT id, reason_code FROM intake_messages WHERE status = 'quarantined'`);
    expect(quarantined).toHaveLength(2);

    // Once the missing modality is added to the master, the message can be put back in the queue.
    await fx.masters.save('modalities', { code: 'PET', name: 'PET' }, fx.adminId);
    await fx.masters.save('radiologists', { code: 'R1', fullName: 'Dr One', externalId: 'EXT-R1', grade: 'CONSULTANT', modalities: ['CT', 'XR', 'PET'], hospitals: ['CITYH'], teams: ['NEURO', 'GENERAL'] }, fx.adminId);
    await new ErrorsService(pool).requeueIntake(quarantined.find((q) => q.reason_code === 'UNKNOWN_MODALITY')!.id, fx.adminId);
    await drain();
    expect((await studyByAccession('A1'))!.state).toBe('reserved');
  });
});

describe('eligibility, continuity and the final gate', () => {
  it('prefers the previous radiologist for the same encounter, and records when continuity is broken', async () => {
    await receive(order({ accession: 'A1', patient: 'P1', encounter: 'E1' }));
    await drain();
    const first = await activeAssignment((await studyByAccession('A1'))!.id);

    await receive(order({ accession: 'A2', patient: 'P1', encounter: 'E1', modality: 'XR' }));
    await drain();
    const second = await activeAssignment((await studyByAccession('A2'))!.id);
    expect(second!.radiologist_code).toBe(first!.radiologist_code);

    await setStatus(first!.radiologist_code, 'on_break');
    await receive(order({ accession: 'A3', patient: 'P1', encounter: 'E1', modality: 'XR' }));
    await drain();
    const s3 = (await studyByAccession('A3'))!;
    const third = await activeAssignment(s3.id);
    expect(third!.radiologist_code).not.toBe(first!.radiologist_code);
    const ev = await one<{ continuity: { preserved: boolean; priorReasons: string[] } }>(pool, 'SELECT continuity FROM evaluations WHERE study_id = $1', [s3.id]);
    expect(ev!.continuity.preserved).toBe(false);
    expect(ev!.continuity.priorReasons).toContain('NOT_READY_ON_BREAK');
  });

  it('applies rule exclusions and sends a study with nobody eligible to a coordinator', async () => {
    await setStatus('R1', 'on_break');
    await setStatus('R2', 'off_shift');
    await receive(order({ accession: 'A1', priority: 'S' }));
    await drain();
    const s = (await studyByAccession('A1'))!;
    expect(s).toMatchObject({ state: 'manual_review', state_reason: 'NO_ELIGIBLE_RADIOLOGIST' });
    const ev = await one<{ candidates: { code: string; reasons: string[] }[] }>(pool, 'SELECT candidates FROM evaluations WHERE study_id = $1', [s.id]);
    expect(ev!.candidates.find((c) => c.code === 'R3')!.reasons).toEqual(['RULE_STAT_CONSULTANT_ONLY']);
  });

  it('does not count a stale heartbeat as present', async () => {
    await pool.query(`UPDATE radiologist_state SET heartbeat_at = now() - interval '10 minutes'`);
    await receive(order({ accession: 'A1' }));
    await drain();
    expect((await studyByAccession('A1'))!.state_reason).toBe('NO_ELIGIBLE_RADIOLOGIST');
  });

  it('never exceeds capacity when workers allocate at the same time', async () => {
    // Capacity 2 and CT costs 2: each radiologist can take exactly one study.
    await pool.query('UPDATE radiologist_state SET capacity_units = 2');
    for (let i = 0; i < 6; i++) await receive(order({ accession: `C${i}`, patient: i < 2 ? 'SAME' : `P${i}` }));
    const workers = Array.from({ length: 6 }, () => new Processor(pool, config));
    for (let round = 0; round < 3; round++) await Promise.all(workers.map((w) => w.processNext()));
    await drain();

    const load = await many<{ code: string; active_units: number; n: number }>(
      pool,
      `SELECT r.code, st.active_units,
              (SELECT count(*)::int FROM assignments a WHERE a.radiologist_id = r.id AND a.status IN ('reserved','sent','delivered')) AS n
         FROM radiologists r JOIN radiologist_state st ON st.radiologist_id = r.id ORDER BY r.code`,
    );
    expect(load.map((l) => l.n)).toEqual([1, 1, 1]);
    expect(load.every((l) => l.active_units === 2)).toBe(true);
    expect((await many(pool, `SELECT 1 FROM studies WHERE state = 'manual_review'`)).length).toBe(3);
  });

  it('excludes radiologists whose modality privilege has been withdrawn', async () => {
    // Withdraw R1 and R2's CT privilege while keeping them in the team: only R3 can take the study.
    await fx.masters.save('radiologists', { code: 'R1', fullName: 'Dr One', externalId: 'EXT-R1', grade: 'CONSULTANT', modalities: ['XR'], hospitals: ['CITYH'], teams: ['NEURO', 'GENERAL'] }, fx.adminId);
    await fx.masters.save('radiologists', { code: 'R2', fullName: 'Dr Two', externalId: 'EXT-R2', grade: 'CONSULTANT', modalities: ['XR'], hospitals: ['CITYH'], teams: ['NEURO', 'GENERAL'] }, fx.adminId);
    await receive(order({ accession: 'A1' }));
    await drain();
    expect((await activeAssignment((await studyByAccession('A1'))!.id))!.radiologist_code).toBe('R3');
  });
});

describe('ordering, cancellation and uncertain delivery', () => {
  it('processes a cancel after its order even when two workers race', async () => {
    await receive(order({ control: 'N1', accession: 'A1' }));
    await receive(order({ control: 'N2', accession: 'A1', orderControl: 'CA' }));
    const a = new Processor(pool, config);
    const b = new Processor(pool, config);
    await Promise.all([a.processNext(), b.processNext()]);
    await drain();
    const s = (await studyByAccession('A1'))!;
    expect(s.state).toBe('cancelled');
    const units = await many<{ active_units: number }>(pool, 'SELECT active_units FROM radiologist_state');
    expect(units.every((u) => u.active_units === 0)).toBe(true);
    // The assignment was never sent, so nothing goes to the destination.
    expect(await new DeliveryWorker(pool, config, acceptingTransport()).deliverNext()).toBeNull();
  });

  it('sends a cancellation after a delivered assignment, never before it', async () => {
    await receive(order({ control: 'N1', accession: 'A1' }));
    await drain();
    const seen: string[] = [];
    const delivery = new DeliveryWorker(pool, config, acceptingTransport(seen));
    await delivery.deliverNext();
    await receive(order({ control: 'N2', accession: 'A1', orderControl: 'CA' }));
    await drain();
    expect(await delivery.deliverNext()).toMatchObject({ outcome: 'accepted' });
    const kinds = await many<{ kind: string; status: string }>(pool, 'SELECT kind, status FROM outbound_messages ORDER BY created_at');
    expect(kinds).toEqual([
      { kind: 'assignment', status: 'accepted' },
      { kind: 'cancellation', status: 'accepted' },
    ]);
    expect(seen).toHaveLength(2);
  });

  it('keeps the reservation and the control ID when an ACK is lost, and never sends a conflicting assignment', async () => {
    await receive(order({ accession: 'A1' }));
    await drain();
    const sent: string[] = [];
    let call = 0;
    const flaky: Transport = async (url, body, t) => {
      call++;
      sent.push(readMsh(parseHl7(body)).controlId!);
      if (call === 1) throw new Error('The operation was aborted due to timeout');
      return acceptingTransport()(url, body, t);
    };
    const delivery = new DeliveryWorker(pool, config, flaky);
    expect(await delivery.deliverNext()).toMatchObject({ outcome: 'unknown' });
    const o = await one<{ status: string; possibly_delivered: boolean }>(pool, 'SELECT status, possibly_delivered FROM outbound_messages');
    expect(o).toEqual({ status: 'unknown', possibly_delivered: true });
    const s = (await studyByAccession('A1'))!;
    expect((await activeAssignment(s.id))!.status).toBe('sent');

    await pool.query('UPDATE outbound_messages SET next_attempt_at = now()');
    expect(await delivery.deliverNext()).toMatchObject({ outcome: 'accepted' });
    expect(new Set(sent).size).toBe(1);
    expect((await many(pool, 'SELECT 1 FROM outbound_messages')).length).toBe(1);
  });

  it('retries a send that never left, and fails to a coordinator after the last attempt', async () => {
    const short = testConfig({ outboundMaxAttempts: 2 });
    await receive(order({ accession: 'A1' }));
    await drain();
    const down: Transport = async () => {
      throw new NotSentError('ECONNREFUSED');
    };
    const delivery = new DeliveryWorker(pool, short, down);
    expect(await delivery.deliverNext()).toMatchObject({ outcome: 'retry' });
    await pool.query('UPDATE outbound_messages SET next_attempt_at = now()');
    expect(await delivery.deliverNext()).toMatchObject({ outcome: 'failed' });
    expect(await one(pool, 'SELECT status, possibly_delivered FROM outbound_messages')).toEqual({ status: 'failed', possibly_delivered: false });
    expect((await studyByAccession('A1'))!.state_reason).toBe('DELIVERY_FAILED');
  });

  it('releases capacity and asks a coordinator when the destination rejects the assignment', async () => {
    await receive(order({ accession: 'A1' }));
    await drain();
    const rejecting: Transport = async (_u, body) => ({ status: 200, body: buildAck(readMsh(parseHl7(body)), 'AE', 'D1', 'Unknown radiologist') });
    expect(await new DeliveryWorker(pool, config, rejecting).deliverNext()).toMatchObject({ outcome: 'rejected' });
    const s = (await studyByAccession('A1'))!;
    expect(s.state_reason).toBe('DESTINATION_REJECTED');
    const units = await many<{ active_units: number }>(pool, 'SELECT active_units FROM radiologist_state');
    expect(units.every((u) => u.active_units === 0)).toBe(true);

    // Routing again never offers the study to the radiologist the destination just rejected.
    const rejectedCode = (await one<{ code: string }>(pool, 'SELECT r.code FROM assignments a JOIN radiologists r ON r.id = a.radiologist_id WHERE a.study_id = $1', [s.id]))!.code;
    await new StudiesService(pool, config).reallocate(s.id, fx.adminId);
    const next = await activeAssignment(s.id);
    expect(next!.radiologist_code).not.toBe(rejectedCode);
  });

  it('treats an ACK for a different control ID as uncertain', async () => {
    await receive(order({ accession: 'A1' }));
    await drain();
    const wrong: Transport = async () => ({ status: 200, body: buildAck({ controlId: 'SOMETHING_ELSE' }, 'AA', 'D1') });
    expect(await new DeliveryWorker(pool, config, wrong).deliverNext()).toMatchObject({ outcome: 'unknown' });
  });
});

describe('rule governance', () => {
  it('needs a different approver, and publishing retires the previous version', async () => {
    const rules = new RulesService(pool);
    const current = (await rules.list()).find((r) => r.status === 'published')!;
    const draft = await rules.createDraft({ ...current.definition, continuity: { enabled: false } }, 'turn off continuity', fx.adminId);
    await rules.submit(draft.id, fx.adminId);
    await expect(rules.decide(draft.id, true, undefined, fx.adminId)).rejects.toThrow('you wrote');
    await rules.decide(draft.id, true, undefined, fx.approverId);
    const statuses = (await rules.list()).map((r) => [r.version, r.status]);
    expect(statuses).toEqual([
      [2, 'published'],
      [1, 'retired'],
    ]);
    await expect(rules.createDraft({ ...current.definition, routing: [{ ...current.definition.routing[0], teamCode: 'NOPE' }] }, undefined, fx.adminId)).rejects.toThrow(
      'not valid',
    );
  });
});
