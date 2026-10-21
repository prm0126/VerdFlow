import {
  buildAssignmentMessage,
  evaluateExclusions,
  evaluateRouting,
  ruleSetDefinitionSchema,
  type Facts,
  type RuleSetDefinition,
} from '@vf/shared';
import type { PoolClient } from 'pg';
import type { AppConfig } from '../config';
import { many, one } from '../database/db';
import { absenceNow, onShiftNow } from '../rota/rota.service';

export interface StudyRow {
  id: string;
  hospital_id: string;
  hospital_code: string;
  issuer: string;
  accession: string;
  placer_order: string | null;
  patient_id: string;
  patient_identifier: string;
  patient_authority: string;
  encounter_number: string | null;
  modality_code: string;
  service_code: string;
  priority: string;
  location: string | null;
  room: string | null;
  state: string;
}

interface CandidateRow {
  radiologist_id: string;
  code: string;
  full_name: string;
  external_id: string;
  grade: string | null;
  specialties: string[];
  active: boolean;
  has_privilege: boolean;
  has_hospital: boolean;
  status: string | null;
  heartbeat_age_s: number | null;
  capacity_units: number | null;
  active_units: number | null;
  on_shift: boolean;
  absence: string | null;
}

export interface CandidateTrace {
  radiologistId: string;
  code: string;
  name: string;
  eligible: boolean;
  reasons: string[];
  loadRatio?: number;
  rank?: number;
}

export interface AllocationOutcome {
  outcome: 'assigned' | 'no_eligible' | 'no_route' | 'no_rules' | 'no_destination' | 'room_hold';
  reasonCode: string;
  evaluationId: string;
  assignmentId?: string;
  radiologistId?: string;
}

const MAX_GATE_ATTEMPTS = 5;

/** Loads one study with the joins the allocator needs. Locks the study row. */
export async function lockStudy(client: PoolClient, studyId: string): Promise<StudyRow> {
  const s = await one<StudyRow>(
    client,
    `SELECT s.id, s.hospital_id, h.code AS hospital_code, s.issuer, s.accession, s.placer_order, s.patient_id,
            p.identifier AS patient_identifier, p.authority AS patient_authority, s.encounter_number, s.modality_code,
            s.service_code, s.priority, s.location, s.room, s.state
       FROM studies s JOIN hospitals h ON h.id = s.hospital_id JOIN patients p ON p.id = s.patient_id
      WHERE s.id = $1
      FOR UPDATE OF s`,
    [studyId],
  );
  if (!s) throw new Error(`Study ${studyId} not found`);
  return s;
}

export function studyFacts(s: StudyRow): Facts {
  return {
    'study.hospitalCode': s.hospital_code,
    'study.modality': s.modality_code,
    'study.serviceCode': s.service_code,
    'study.priority': s.priority,
    'study.location': s.location,
    'study.room': s.room,
  };
}

/**
 * Decides and commits the primary assignment for a study, inside the caller's transaction (which must
 * hold the study row lock). Lock order: study → patient affinity guard → radiologist_state.
 * No network calls are made here; the outbound message is written as an outbox row.
 */
export async function allocate(client: PoolClient, study: StudyRow, config: AppConfig): Promise<AllocationOutcome> {
  const facts = studyFacts(study);
  const ruleSet = await one<{ id: string; version: number; definition: unknown }>(
    client,
    `SELECT id, version, definition FROM rule_sets WHERE status = 'published'`,
  );
  if (!ruleSet) {
    return toManualReview(client, study, facts, null, { routing: null }, [], {}, 'no_rules', 'NO_PUBLISHED_RULES');
  }
  const def: RuleSetDefinition = ruleSetDefinitionSchema.parse(ruleSet.definition);

  const destination = await one<{ id: string; receiving_application: string | null; receiving_facility: string | null }>(
    client,
    `SELECT p.id, p.receiving_application, p.receiving_facility
       FROM hospitals h JOIN integration_partners p ON p.id = h.outbound_partner_id
      WHERE h.id = $1 AND p.active AND p.direction = 'outbound'`,
    [study.hospital_id],
  );
  if (!destination) {
    return toManualReview(client, study, facts, ruleSet, { routing: null }, [], {}, 'no_destination', 'NO_DESTINATION');
  }

  const room = await checkRoom(client, study);
  if (room.hold) {
    return toManualReview(client, study, facts, ruleSet, { routing: null, room }, [], {}, 'room_hold', room.reasonCode);
  }

  const routing = evaluateRouting(def, facts);
  if (!routing.teamCode) {
    return toManualReview(client, study, facts, ruleSet, { routing }, [], {}, 'no_route', routing.reasonCode);
  }

  // Patient continuity guard. Created if absent, then locked, so two first studies for the same
  // patient cannot both see "no previous radiologist" at the same time.
  const scopeKey = study.encounter_number ? `enc:${study.encounter_number}` : 'window';
  await client.query(
    `INSERT INTO patient_affinity (patient_id, scope_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [study.patient_id, scopeKey],
  );
  const affinity = await one<{ radiologist_id: string | null; recent: boolean }>(
    client,
    `SELECT radiologist_id,
            (last_assigned_at IS NOT NULL AND last_assigned_at > now() - make_interval(hours => $3)) AS recent
       FROM patient_affinity WHERE patient_id = $1 AND scope_key = $2 FOR UPDATE`,
    [study.patient_id, scopeKey, config.continuityWindowHours],
  );
  const priorRadiologistId =
    def.continuity.enabled && affinity?.radiologist_id && (scopeKey !== 'window' || affinity.recent) ? affinity.radiologist_id : null;

  const units = await workUnits(client, study);
  const rejected = await destinationRejections(client, study.id);
  const rows = await candidateRows(client, routing.teamCode, study, null);
  const traces = rows.map((r) => assess(r, def, facts, units, config, rejected));
  const eligible = traces.filter((t) => t.eligible);
  eligible.sort((a, b) => {
    const pa = a.radiologistId === priorRadiologistId ? 0 : 1;
    const pb = b.radiologistId === priorRadiologistId ? 0 : 1;
    return pa - pb || (a.loadRatio ?? 0) - (b.loadRatio ?? 0) || a.code.localeCompare(b.code);
  });
  eligible.forEach((t, i) => (t.rank = i + 1));

  const continuity: Record<string, unknown> = {
    enabled: def.continuity.enabled,
    scopeKey,
    priorRadiologistId,
  };
  if (priorRadiologistId) {
    const prior = traces.find((t) => t.radiologistId === priorRadiologistId);
    continuity.priorEligible = !!prior?.eligible;
    continuity.priorReasons = prior ? prior.reasons : ['NOT_IN_ROUTED_TEAM'];
  }

  // Final gate: lock the chosen radiologist's state row and re-check against committed data. If the
  // facts changed since ranking (break, capacity, revoked privilege), move to the next candidate.
  for (const candidate of eligible.slice(0, MAX_GATE_ATTEMPTS)) {
    await client.query('SELECT 1 FROM radiologist_state WHERE radiologist_id = $1 FOR UPDATE', [candidate.radiologistId]);
    const [fresh] = await candidateRows(client, routing.teamCode, study, candidate.radiologistId);
    const recheck = fresh ? assess(fresh, def, facts, units, config, rejected) : null;
    if (!fresh || !recheck?.eligible) {
      candidate.eligible = false;
      candidate.reasons = ['CHANGED_AT_FINAL_GATE', ...(recheck?.reasons ?? ['NO_LONGER_IN_TEAM'])];
      continue;
    }
    continuity.preserved = priorRadiologistId ? candidate.radiologistId === priorRadiologistId : null;

    const evaluationId = await recordEvaluation(client, study, facts, ruleSet, { routing }, traces, continuity, 'assigned', routing.reasonCode, candidate.radiologistId);
    const version =
      ((await one<{ v: number }>(client, 'SELECT coalesce(max(version), 0) AS v FROM assignments WHERE study_id = $1', [study.id]))?.v ?? 0) + 1;
    const assignment = await one<{ id: string }>(
      client,
      `INSERT INTO assignments (study_id, radiologist_id, team_code, version, status, work_units, evaluation_id)
       VALUES ($1, $2, $3, $4, 'reserved', $5, $6) RETURNING id`,
      [study.id, candidate.radiologistId, routing.teamCode, version, units, evaluationId],
    );
    await client.query(
      `UPDATE radiologist_state SET active_units = active_units + $2, version = version + 1, updated_at = now()
        WHERE radiologist_id = $1`,
      [candidate.radiologistId, units],
    );
    await client.query(
      `UPDATE patient_affinity SET radiologist_id = $3, last_study_id = $4, last_assigned_at = now()
        WHERE patient_id = $1 AND scope_key = $2`,
      [study.patient_id, scopeKey, candidate.radiologistId, study.id],
    );
    await enqueueOutbound(client, {
      kind: 'assignment',
      partnerId: destination.id,
      receivingApplication: destination.receiving_application ?? '',
      receivingFacility: destination.receiving_facility ?? '',
      study,
      assignmentId: assignment!.id,
      assignmentVersion: version,
      radiologist: fresh,
      teamCode: routing.teamCode,
      ruleSetVersion: ruleSet.version,
    });
    await client.query(
      `UPDATE studies SET state = 'reserved', state_reason = NULL, version = version + 1, updated_at = now() WHERE id = $1`,
      [study.id],
    );
    await client.query(
      `INSERT INTO study_events (study_id, kind, detail) VALUES ($1, 'assignment_reserved', $2)`,
      [study.id, JSON.stringify({ assignmentId: assignment!.id, radiologistId: candidate.radiologistId, version, continuity })],
    );
    return { outcome: 'assigned', reasonCode: routing.reasonCode, evaluationId, assignmentId: assignment!.id, radiologistId: candidate.radiologistId };
  }

  return toManualReview(client, study, facts, ruleSet, { routing }, traces, continuity, 'no_eligible', 'NO_ELIGIBLE_RADIOLOGIST');
}

async function workUnits(client: PoolClient, study: StudyRow): Promise<number> {
  const r = await one<{ units: number }>(
    client,
    `SELECT coalesce(sv.work_units, m.work_units, 1) AS units
       FROM modalities m LEFT JOIN services sv ON sv.code = $2
      WHERE m.code = $1`,
    [study.modality_code, study.service_code],
  );
  return r?.units ?? 1;
}

/** Team members with every fact the eligibility checks need. Optionally for one radiologist only. */
function candidateRows(client: PoolClient, teamCode: string, study: StudyRow, radiologistId: string | null) {
  return many<CandidateRow>(
    client,
    `SELECT r.id AS radiologist_id, r.code, r.full_name, r.external_id, r.grade, r.specialties, r.active,
            EXISTS (SELECT 1 FROM radiologist_privileges rp
                     WHERE rp.radiologist_id = r.id AND rp.modality_code = $2
                       AND (rp.valid_to IS NULL OR rp.valid_to >= CURRENT_DATE)) AS has_privilege,
            EXISTS (SELECT 1 FROM radiologist_hospitals rh
                     WHERE rh.radiologist_id = r.id AND rh.hospital_id = $3) AS has_hospital,
            st.status, extract(epoch FROM now() - st.heartbeat_at)::float AS heartbeat_age_s,
            st.capacity_units, st.active_units,
            ${onShiftNow('r.id')} AS on_shift, ${absenceNow('r.id')} AS absence
       FROM teams t
       JOIN team_members tm ON tm.team_id = t.id
                           AND tm.valid_from <= CURRENT_DATE AND (tm.valid_to IS NULL OR tm.valid_to >= CURRENT_DATE)
       JOIN radiologists r ON r.id = tm.radiologist_id
       LEFT JOIN radiologist_state st ON st.radiologist_id = r.id
      WHERE t.code = $1 AND t.active AND ($4::uuid IS NULL OR r.id = $4)
      ORDER BY r.code`,
    [teamCode, study.modality_code, study.hospital_id, radiologistId],
  );
}

const ABSENCE_REASON: Record<string, string> = { break: 'ON_BREAK', leave: 'ON_LEAVE', training: 'ON_TRAINING', other: 'ABSENT' };

export interface RoomCheck {
  hold: boolean;
  reasonCode: string;
  room?: string;
}

/**
 * Room and modality check for the performing room. Applies only when the hospital has rooms in the
 * master; otherwise it is recorded as not checked.
 */
async function checkRoom(client: PoolClient, study: StudyRow): Promise<RoomCheck> {
  if (!study.room) return { hold: false, reasonCode: 'NO_ROOM_GIVEN' };
  const configured = await one(client, 'SELECT 1 FROM rooms WHERE hospital_id = $1 AND active LIMIT 1', [study.hospital_id]);
  if (!configured) return { hold: false, reasonCode: 'ROOMS_NOT_CONFIGURED', room: study.room };
  const room = await one<{ status: string; modalities: string[] }>(
    client,
    'SELECT status, modalities FROM rooms WHERE hospital_id = $1 AND code = $2 AND active',
    [study.hospital_id, study.room],
  );
  if (!room) return { hold: true, reasonCode: 'UNKNOWN_ROOM', room: study.room };
  if (room.status !== 'open') return { hold: true, reasonCode: 'ROOM_CLOSED', room: study.room };
  if (room.modalities.length > 0 && !room.modalities.includes(study.modality_code)) {
    return { hold: true, reasonCode: 'ROOM_MODALITY_NOT_ALLOWED', room: study.room };
  }
  return { hold: false, reasonCode: 'ROOM_OK', room: study.room };
}

/** Radiologists rejected by the destination, who declined, or a coordinator moved the study from, are not offered it again. */
async function destinationRejections(client: PoolClient, studyId: string): Promise<Set<string>> {
  const rows = await many<{ radiologist_id: string }>(
    client,
    `SELECT DISTINCT radiologist_id FROM assignments WHERE study_id = $1 AND end_reason IN ('DESTINATION_REJECTED', 'RADIOLOGIST_DECLINED', 'COORDINATOR_REASSIGNED')`,
    [studyId],
  );
  return new Set(rows.map((r) => r.radiologist_id));
}

function assess(r: CandidateRow, def: RuleSetDefinition, facts: Facts, units: number, config: AppConfig, rejected: Set<string>): CandidateTrace {
  const reasons: string[] = [];
  if (!r.active) reasons.push('INACTIVE');
  if (rejected.has(r.radiologist_id)) reasons.push('ALREADY_REJECTED_OR_DECLINED');
  if (!r.has_hospital) reasons.push('NO_HOSPITAL_PERMISSION');
  if (!r.has_privilege) reasons.push('NO_MODALITY_PRIVILEGE');
  if (config.rotaRequired && !r.on_shift) reasons.push('NO_SHIFT');
  if (r.absence) reasons.push(ABSENCE_REASON[r.absence] ?? 'ABSENT');
  if (r.status !== 'ready') reasons.push(`NOT_READY_${(r.status ?? 'unknown').toUpperCase()}`);
  else if (r.heartbeat_age_s === null || r.heartbeat_age_s > config.presenceStaleSeconds) reasons.push('PRESENCE_STALE');
  const capacity = r.capacity_units ?? 0;
  const active = r.active_units ?? 0;
  if (active + units > capacity) reasons.push('AT_CAPACITY');
  for (const ex of evaluateExclusions(def, {
    ...facts,
    'radiologist.code': r.code,
    'radiologist.grade': r.grade,
    'radiologist.specialties': r.specialties,
  })) {
    reasons.push(`RULE_${ex.reasonCode}`);
  }
  return {
    radiologistId: r.radiologist_id,
    code: r.code,
    name: r.full_name,
    eligible: reasons.length === 0,
    reasons,
    loadRatio: capacity > 0 ? Math.round((active / capacity) * 1000) / 1000 : undefined,
  };
}

async function recordEvaluation(
  client: PoolClient,
  study: StudyRow,
  facts: Facts,
  ruleSet: { id: string; version: number } | null,
  routing: unknown,
  candidates: CandidateTrace[],
  continuity: Record<string, unknown>,
  outcome: AllocationOutcome['outcome'],
  reasonCode: string,
  selected: string | null,
): Promise<string> {
  const row = await one<{ id: string }>(
    client,
    `INSERT INTO evaluations (study_id, rule_set_id, rule_set_version, facts, routing, candidates, continuity, outcome, reason_code, selected_radiologist_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      study.id,
      ruleSet?.id ?? null,
      ruleSet?.version ?? null,
      JSON.stringify(facts),
      JSON.stringify(routing),
      JSON.stringify(candidates),
      JSON.stringify(continuity),
      outcome,
      reasonCode,
      selected,
    ],
  );
  return row!.id;
}

async function toManualReview(
  client: PoolClient,
  study: StudyRow,
  facts: Facts,
  ruleSet: { id: string; version: number } | null,
  routing: unknown,
  candidates: CandidateTrace[],
  continuity: Record<string, unknown>,
  outcome: Exclude<AllocationOutcome['outcome'], 'assigned'>,
  reasonCode: string,
): Promise<AllocationOutcome> {
  const evaluationId = await recordEvaluation(client, study, facts, ruleSet, routing, candidates, continuity, outcome, reasonCode, null);
  await client.query(
    `UPDATE studies SET state = 'manual_review', state_reason = $2, version = version + 1, updated_at = now() WHERE id = $1`,
    [study.id, reasonCode],
  );
  await client.query(`INSERT INTO study_events (study_id, kind, detail) VALUES ($1, 'manual_review', $2)`, [
    study.id,
    JSON.stringify({ reasonCode, evaluationId }),
  ]);
  return { outcome, reasonCode, evaluationId };
}

export interface OutboundIntent {
  kind: 'assignment' | 'cancellation';
  partnerId: string;
  receivingApplication: string;
  receivingFacility: string;
  study: StudyRow;
  assignmentId: string;
  assignmentVersion: number;
  radiologist: { code: string; external_id: string; full_name: string };
  teamCode: string;
  ruleSetVersion: number;
}

/** Writes the outbound HL7 as an outbox row. The control ID is fixed now and reused on every retry. */
export async function enqueueOutbound(client: PoolClient, o: OutboundIntent): Promise<void> {
  const seq = await one<{ n: string }>(client, `SELECT nextval('outbound_control_seq')::text AS n`);
  const controlId = `VF${seq!.n.padStart(10, '0')}`;
  const payload = buildAssignmentMessage({
    controlId,
    messageTime: new Date(),
    receivingApplication: o.receivingApplication,
    receivingFacility: o.receivingFacility,
    orderControl: o.kind === 'assignment' ? 'XO' : 'CA',
    patientId: o.study.patient_identifier,
    patientAuthority: o.study.patient_authority,
    placerOrder: o.study.placer_order ?? undefined,
    accession: o.study.accession,
    serviceCode: o.study.service_code,
    modality: o.study.modality_code,
    assignmentId: o.assignmentId,
    assignmentVersion: o.assignmentVersion,
    radiologistExternalId: o.radiologist.external_id,
    radiologistName: o.radiologist.full_name,
    teamCode: o.teamCode,
    ruleSetVersion: o.ruleSetVersion,
  });
  await client.query(
    `INSERT INTO outbound_messages (partner_id, study_id, assignment_id, kind, control_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [o.partnerId, o.study.id, o.assignmentId, o.kind, controlId, payload],
  );
}
