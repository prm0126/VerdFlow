import type Anthropic from '@anthropic-ai/sdk';
import { TAT_INTERVALS, type Permission } from '@vf/shared';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { SessionUser } from '../auth/auth.service';
import type { AppConfig } from '../config';
import { many, one } from '../database/db';
import { absenceNow, onShiftNow } from '../rota/rota.service';

/**
 * The assistant's tools. Every tool is read-only, runs with the signed-in user's own permissions, and
 * never returns patient names or patient identifiers: answers refer to studies by accession number.
 * The same tools serve the Claude engine and the built-in engine.
 */
export interface ToolContext {
  pool: Pool;
  config: AppConfig;
  user: SessionUser;
}

interface ToolSpec<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  permission: Permission;
  input: S;
  /** JSON schema sent to Claude; kept by hand so it matches `input` exactly with strict mode. */
  schema: Anthropic.Beta.BetaTool['input_schema'];
  run: (ctx: ToolContext, input: z.infer<S>) => Promise<unknown>;
}

const DAY = 86400_000;
const london = (d: Date | string) =>
  new Date(d).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

async function linkedRadiologist(ctx: ToolContext) {
  return one<{ id: string; code: string; full_name: string }>(ctx.pool, 'SELECT id, code, full_name FROM radiologists WHERE user_id = $1', [ctx.user.id]);
}

/** "CT head" rather than "CT CT head" when the service name already starts with the modality. */
export const studyName = (modality: string, service: string) => (service.toUpperCase().startsWith(modality.toUpperCase()) ? service : `${modality} ${service}`);

function tool<S extends z.ZodTypeAny>(t: ToolSpec<S>) {
  return t;
}

const mySchedule = tool({
  name: 'my_schedule',
  description:
    "The signed-in user's own rota: shifts, leave, breaks and training from a start date for a number of days, plus whether they can take new work right now. Use for questions like 'what is scheduled under my name', 'when am I working', 'am I on call'.",
  permission: 'dashboard.view',
  input: z.object({ fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), days: z.number().int().min(1).max(31).nullable() }),
  schema: {
    type: 'object',
    properties: {
      fromDate: { type: ['string', 'null'], description: 'First day, YYYY-MM-DD. Null means today.' },
      days: { type: ['integer', 'null'], description: 'How many days to include, 1 to 31. Null means 7.' },
    },
    required: ['fromDate', 'days'],
    additionalProperties: false,
  },
  async run(ctx, input) {
    const r = await linkedRadiologist(ctx);
    if (!r) return { linked: false, message: 'Your sign-in is not linked to a radiologist profile, so there is no rota under your name. An administrator can link it in Masters.' };
    const from = input.fromDate ? new Date(`${input.fromDate}T00:00:00Z`) : new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
    const to = new Date(from.getTime() + (input.days ?? 7) * DAY);
    const [shifts, absences, now] = await Promise.all([
      many<{ starts_at: string; ends_at: string; kind: string; note: string | null }>(
        ctx.pool,
        'SELECT starts_at, ends_at, kind, note FROM shifts WHERE radiologist_id = $1 AND starts_at < $3 AND ends_at > $2 ORDER BY starts_at',
        [r.id, from, to],
      ),
      many<{ kind: string; starts_at: string; ends_at: string | null }>(
        ctx.pool,
        'SELECT kind, starts_at, ends_at FROM absences WHERE radiologist_id = $1 AND starts_at < $3 AND (ends_at IS NULL OR ends_at > $2) ORDER BY starts_at',
        [r.id, from, to],
      ),
      one<{ status: string; on_shift: boolean; absence: string | null; active_units: number; capacity_units: number }>(
        ctx.pool,
        `SELECT st.status, ${onShiftNow('st.radiologist_id')} AS on_shift, ${absenceNow('st.radiologist_id')} AS absence, st.active_units, st.capacity_units
           FROM radiologist_state st WHERE st.radiologist_id = $1`,
        [r.id],
      ),
    ]);
    return {
      linked: true,
      radiologist: r.full_name,
      period: { from: from.toISOString().slice(0, 10), to: new Date(to.getTime() - DAY).toISOString().slice(0, 10) },
      timesShownIn: 'Europe/London',
      shifts: shifts.map((s) => ({ starts: london(s.starts_at), ends: london(s.ends_at), type: s.kind === 'on_call' ? 'on call' : 'reporting', note: s.note })),
      absences: absences.map((a) => ({ type: a.kind, starts: london(a.starts_at), ends: a.ends_at ? london(a.ends_at) : 'not ended yet' })),
      now: now && {
        status: now.status,
        onShift: now.on_shift,
        absence: now.absence,
        loadWorkUnits: `${now.active_units} of ${now.capacity_units}`,
      },
    };
  },
});

const myWork = tool({
  name: 'my_work',
  description:
    'Work waiting for the signed-in user: studies currently assigned to them with turnaround status, their open peer reviews, and (if they can vet) how many requests wait for vetting.',
  permission: 'dashboard.view',
  input: z.object({}),
  schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  async run(ctx) {
    const r = await linkedRadiologist(ctx);
    const canVet = ctx.user.permissions.includes('vetting.perform');
    const vetting = canVet ? (await one<{ n: number }>(ctx.pool, `SELECT count(*)::int AS n FROM studies WHERE state = 'awaiting_vetting'`))!.n : null;
    if (!r) return { linked: false, vettingWaiting: vetting, message: 'Your sign-in is not linked to a radiologist profile, so no studies are assigned to you.' };
    const [studies, reviews] = await Promise.all([
      many<{ accession: string; modality_code: string; service: string; priority: string; state: string; tat_state: string | null; due_at: string | null }>(
        ctx.pool,
        `SELECT s.accession, s.modality_code, coalesce(s.service_text, s.service_code) AS service, s.priority, s.state, c.state AS tat_state, c.due_at
           FROM assignments a JOIN studies s ON s.id = a.study_id
           LEFT JOIN LATERAL (SELECT state, due_at FROM tat_clocks WHERE study_id = s.id AND stopped_at IS NULL
                               ORDER BY CASE state WHEN 'breached' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, due_at LIMIT 1) c ON true
          WHERE a.radiologist_id = $1 AND a.status IN ('reserved', 'sent', 'delivered', 'accepted')
          ORDER BY CASE s.priority WHEN 'STAT' THEN 0 WHEN 'URGENT' THEN 1 ELSE 2 END, s.created_at`,
        [r.id],
      ),
      many<{ accession: string; created_at: string }>(
        ctx.pool,
        `SELECT s.accession, t.created_at FROM peer_review_tasks t JOIN studies s ON s.id = t.study_id
          WHERE t.reviewer_id = $1 AND t.status = 'open' ORDER BY t.created_at`,
        [r.id],
      ),
    ]);
    return {
      linked: true,
      radiologist: r.full_name,
      assignedStudies: studies.map((s) => ({
        accession: s.accession,
        study: studyName(s.modality_code, s.service),
        priority: s.priority,
        state: s.state,
        turnaround: s.tat_state ? { state: s.tat_state === 'breached' ? 'overdue' : s.tat_state === 'warning' ? 'at risk' : 'on time', due: s.due_at && london(s.due_at) } : null,
      })),
      openPeerReviews: reviews.map((t) => ({ accession: t.accession, since: london(t.created_at) })),
      vettingWaiting: vetting,
    };
  },
});

const whoIsOn = tool({
  name: 'who_is_on_shift',
  description: 'Who is on shift at a given time (default now), with their teams, availability and load. Use for "who is on today", "who is on call tonight", "is Dr X working".',
  permission: 'studies.view',
  input: z.object({ at: z.string().nullable() }),
  schema: {
    type: 'object',
    properties: { at: { type: ['string', 'null'], description: 'ISO date-time to check, for example 2026-10-21T20:00:00Z. Null means now.' } },
    required: ['at'],
    additionalProperties: false,
  },
  async run(ctx, input) {
    const at = input.at ? new Date(input.at) : new Date();
    if (isNaN(at.getTime())) return { error: 'That time could not be read. Use an ISO date-time.' };
    const rows = await many<{ full_name: string; kind: string; ends_at: string; teams: string[]; status: string; absence: string | null; active_units: number; capacity_units: number }>(
      ctx.pool,
      `SELECT r.full_name, sh.kind, sh.ends_at, st.status, st.active_units, st.capacity_units,
              (SELECT ab.kind FROM absences ab WHERE ab.radiologist_id = r.id AND ab.starts_at <= $1 AND (ab.ends_at IS NULL OR ab.ends_at > $1) LIMIT 1) AS absence,
              coalesce((SELECT array_agg(t.code ORDER BY t.code) FROM team_members tm JOIN teams t ON t.id = tm.team_id
                         WHERE tm.radiologist_id = r.id AND (tm.valid_to IS NULL OR tm.valid_to >= CURRENT_DATE)), '{}') AS teams
         FROM shifts sh JOIN radiologists r ON r.id = sh.radiologist_id JOIN radiologist_state st ON st.radiologist_id = r.id
        WHERE sh.starts_at <= $1 AND sh.ends_at > $1 AND r.active ORDER BY r.full_name`,
      [at],
    );
    return {
      at: london(at),
      onShift: rows.map((r) => ({
        radiologist: r.full_name,
        shift: r.kind === 'on_call' ? 'on call' : 'reporting',
        until: london(r.ends_at),
        teams: r.teams,
        status: r.absence ? `on ${r.absence}` : r.status,
        loadWorkUnits: `${r.active_units} of ${r.capacity_units}`,
      })),
    };
  },
});

const findStudies = tool({
  name: 'find_studies',
  description: 'Search studies by state, accession, priority or turnaround (overdue or at risk). Returns at most 25, newest first, without patient details.',
  permission: 'studies.view',
  input: z.object({
    state: z.string().max(40).nullable(),
    accession: z.string().max(40).nullable(),
    priority: z.enum(['STAT', 'URGENT', 'ROUTINE']).nullable(),
    turnaround: z.enum(['overdue', 'at_risk']).nullable(),
  }),
  schema: {
    type: 'object',
    properties: {
      state: { type: ['string', 'null'], description: 'Clinical state, e.g. manual_review, awaiting_vetting, assigned, preliminary, finalized. Null for any.' },
      accession: { type: ['string', 'null'], description: 'Accession number or part of it. Null for any.' },
      priority: { type: ['string', 'null'], enum: ['STAT', 'URGENT', 'ROUTINE', null] },
      turnaround: { type: ['string', 'null'], enum: ['overdue', 'at_risk', null], description: 'Only studies with an open clock in this state.' },
    },
    required: ['state', 'accession', 'priority', 'turnaround'],
    additionalProperties: false,
  },
  async run(ctx, i) {
    const rows = await many(
      ctx.pool,
      `SELECT s.accession, h.code AS hospital, s.modality_code AS modality, coalesce(s.service_text, s.service_code) AS service, s.priority, s.state,
              s.state_reason AS reason, r.full_name AS radiologist
         FROM studies s JOIN hospitals h ON h.id = s.hospital_id
         LEFT JOIN LATERAL (SELECT radiologist_id FROM assignments WHERE study_id = s.id AND status IN ('reserved','sent','delivered','accepted','completed')
                             ORDER BY version DESC LIMIT 1) a ON true
         LEFT JOIN radiologists r ON r.id = a.radiologist_id
        WHERE ($1::text IS NULL OR s.state = $1) AND ($2::text IS NULL OR s.accession ILIKE '%' || $2 || '%') AND ($3::text IS NULL OR s.priority = $3)
          AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM tat_clocks c WHERE c.study_id = s.id AND c.stopped_at IS NULL
                                            AND c.state = CASE $4 WHEN 'overdue' THEN 'breached' ELSE 'warning' END))
        ORDER BY s.created_at DESC LIMIT 25`,
      [i.state, i.accession, i.priority, i.turnaround],
    );
    return { count: rows.length, studies: rows };
  },
});

const explainStudy = tool({
  name: 'explain_study',
  description:
    'Everything about one study by accession: how it was routed, why this radiologist was chosen and why others were not, delivery, turnaround clocks, escalations and peer review. No patient details.',
  permission: 'studies.view',
  input: z.object({ accession: z.string().min(1).max(40) }),
  schema: { type: 'object', properties: { accession: { type: 'string' } }, required: ['accession'], additionalProperties: false },
  async run(ctx, i) {
    return studyFacts(ctx.pool, i.accession);
  },
});

const operations = tool({
  name: 'operations_summary',
  description: 'Current operational picture: intake backlog, studies by state, delivery problems, open escalations, overdue turnaround, radiologists available, peer reviews.',
  permission: 'dashboard.view',
  input: z.object({}),
  schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  async run(ctx) {
    return operationsFacts(ctx.pool, ctx.config);
  },
});

const turnaround = tool({
  name: 'turnaround_report',
  description: 'Turnaround performance over the last N hours: for each interval and priority, how many were met, met late, and the median minutes taken.',
  permission: 'studies.view',
  input: z.object({ hours: z.number().int().min(1).max(720).nullable() }),
  schema: {
    type: 'object',
    properties: { hours: { type: ['integer', 'null'], description: 'Look-back window in hours, 1 to 720. Null means 24.' } },
    required: ['hours'],
    additionalProperties: false,
  },
  async run(ctx, i) {
    const rows = await many<{ interval_code: keyof typeof TAT_INTERVALS; priority: string; met: number; late: number; median_minutes: number | null }>(
      ctx.pool,
      `SELECT c.interval_code, s.priority, count(*) FILTER (WHERE c.state = 'met')::int AS met, count(*) FILTER (WHERE c.state = 'met_late')::int AS late,
              round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM c.stopped_at - c.started_at) / 60))::numeric, 1)::float AS median_minutes
         FROM tat_clocks c JOIN studies s ON s.id = c.study_id
        WHERE c.state IN ('met', 'met_late') AND c.stopped_at > now() - make_interval(hours => $1)
        GROUP BY 1, 2 ORDER BY 1, 2`,
      [i.hours ?? 24],
    );
    return { hours: i.hours ?? 24, intervals: rows.map((r) => ({ ...r, interval: TAT_INTERVALS[r.interval_code]?.label ?? r.interval_code })) };
  },
});

const escalations = tool({
  name: 'open_escalations',
  description: 'Open escalations: studies waiting for a coordinator and turnaround clocks at risk or overdue, with who has acknowledged them.',
  permission: 'studies.view',
  input: z.object({}),
  schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  async run(ctx) {
    const rows = await many<{ accession: string; priority: string; kind: string; reason_code: string; raised_at: string; acknowledged_by: string | null }>(
      ctx.pool,
      `SELECT s.accession, s.priority, e.kind, e.reason_code, e.raised_at, u.full_name AS acknowledged_by
         FROM escalations e JOIN studies s ON s.id = e.study_id LEFT JOIN users u ON u.id = e.acknowledged_by
        WHERE e.resolved_at IS NULL ORDER BY e.raised_at LIMIT 50`,
    );
    return {
      count: rows.length,
      escalations: rows.map((e) => ({
        accession: e.accession,
        priority: e.priority,
        what: e.kind === 'tat_breach' ? 'overdue' : e.kind === 'tat_warning' ? 'at risk' : 'needs a coordinator',
        reason: TAT_INTERVALS[e.reason_code as keyof typeof TAT_INTERVALS]?.label ?? e.reason_code,
        raised: london(e.raised_at),
        acknowledgedBy: e.acknowledged_by,
      })),
    };
  },
});

export const TOOLS = [mySchedule, myWork, whoIsOn, findStudies, explainStudy, operations, turnaround, escalations];
export type AssistantTool = (typeof TOOLS)[number];

/** The tools this user may use, as Claude tool definitions. */
export function toolDefinitions(user: SessionUser): Anthropic.Beta.BetaTool[] {
  return TOOLS.filter((t) => user.permissions.includes(t.permission)).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.schema,
    strict: true,
  }));
}

/** Runs a tool by name after checking the user's permission and validating the input. */
export async function runTool(ctx: ToolContext, name: string, input: unknown): Promise<{ ok: boolean; result: unknown }> {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return { ok: false, result: { error: `Unknown tool ${name}` } };
  if (!ctx.user.permissions.includes(t.permission)) return { ok: false, result: { error: 'You do not have permission to see this.' } };
  const parsed = t.input.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, result: { error: 'Invalid input', issues: parsed.error.issues.map((i) => i.message) } };
  return { ok: true, result: await (t.run as (c: ToolContext, i: unknown) => Promise<unknown>)(ctx, parsed.data) };
}

/** Facts for one study, without patient details. Shared by the explain tool and "Explain this study". */
export async function studyFacts(pool: Pool, accession: string) {
  const s = await one<{ id: string; accession: string; hospital: string; modality: string; service: string; priority: string; state: string; reason: string | null; vetting_protocol: string | null }>(
    pool,
    `SELECT s.id, s.accession, h.code AS hospital, s.modality_code AS modality, coalesce(s.service_text, s.service_code) AS service, s.priority, s.state,
            s.state_reason AS reason, s.vetting_protocol
       FROM studies s JOIN hospitals h ON h.id = s.hospital_id WHERE s.accession = $1 ORDER BY s.created_at DESC LIMIT 1`,
    [accession.trim()],
  );
  if (!s) return { found: false, accession };
  const [evaluation, assignments, clocks, escalationRows, review, delivery] = await Promise.all([
    one<{ rule_set_version: number | null; outcome: string; reason_code: string; routing: unknown; candidates: unknown; continuity: unknown }>(
      pool,
      'SELECT rule_set_version, outcome, reason_code, routing, candidates, continuity FROM evaluations WHERE study_id = $1 ORDER BY created_at DESC LIMIT 1',
      [s.id],
    ),
    many(
      pool,
      `SELECT a.version, r.full_name AS radiologist, a.team_code AS team, a.status, a.end_reason FROM assignments a
         JOIN radiologists r ON r.id = a.radiologist_id WHERE a.study_id = $1 ORDER BY a.version`,
      [s.id],
    ),
    many<{ interval_code: keyof typeof TAT_INTERVALS; target_minutes: number; state: string; due_at: string; stopped_at: string | null }>(
      pool,
      'SELECT interval_code, target_minutes, state, due_at, stopped_at FROM tat_clocks WHERE study_id = $1 ORDER BY started_at',
      [s.id],
    ),
    many(pool, 'SELECT kind, reason_code, resolved_at IS NULL AS open FROM escalations WHERE study_id = $1 ORDER BY raised_at', [s.id]),
    one(pool, `SELECT t.status, t.skip_reason, t.outcome, r.full_name AS reviewer FROM peer_review_tasks t LEFT JOIN radiologists r ON r.id = t.reviewer_id WHERE t.study_id = $1`, [s.id]),
    many(pool, 'SELECT kind, status, ack_code, attempts FROM outbound_messages WHERE study_id = $1 ORDER BY created_at', [s.id]),
  ]);
  const { id: _id, ...study } = s;
  return {
    found: true,
    study,
    decision: evaluation,
    assignments,
    delivery,
    turnaround: clocks.map((c) => ({
      interval: TAT_INTERVALS[c.interval_code]?.label ?? c.interval_code,
      targetMinutes: c.target_minutes,
      state: c.state,
      due: london(c.due_at),
      finished: c.stopped_at ? london(c.stopped_at) : null,
    })),
    escalations: escalationRows,
    peerReview: review,
  };
}

export async function operationsFacts(pool: Pool, config: AppConfig) {
  return one(
    pool,
    `SELECT
       (SELECT count(*)::int FROM intake_messages WHERE status = 'received') AS intake_waiting,
       (SELECT count(*)::int FROM intake_messages WHERE status = 'quarantined') AS quarantined,
       (SELECT count(*)::int FROM studies WHERE created_at > now() - interval '24 hours') AS studies_last_24h,
       (SELECT count(*)::int FROM studies WHERE state = 'awaiting_vetting') AS awaiting_vetting,
       (SELECT count(*)::int FROM studies WHERE state = 'manual_review') AS needing_coordinator,
       (SELECT count(*)::int FROM studies WHERE state IN ('reserved', 'awaiting_acceptance')) AS waiting_for_acceptance,
       (SELECT count(*)::int FROM studies WHERE state IN ('assigned', 'preliminary')) AS being_reported,
       (SELECT count(*)::int FROM studies WHERE state = 'finalized' AND finalized_at > now() - interval '24 hours') AS finalised_last_24h,
       (SELECT count(*)::int FROM outbound_messages WHERE status IN ('failed', 'rejected', 'unknown')) AS delivery_problems,
       (SELECT count(*)::int FROM escalations WHERE resolved_at IS NULL) AS open_escalations,
       (SELECT count(*)::int FROM escalations WHERE resolved_at IS NULL AND acknowledged_at IS NULL) AS unacknowledged_escalations,
       (SELECT count(*)::int FROM tat_clocks WHERE state = 'breached') AS turnaround_overdue,
       (SELECT count(*)::int FROM tat_clocks WHERE state = 'warning') AS turnaround_at_risk,
       (SELECT count(*)::int FROM radiologist_state WHERE status = 'ready' AND heartbeat_at > now() - make_interval(secs => $1)) AS radiologists_available,
       (SELECT count(*)::int FROM peer_review_tasks WHERE status = 'open') AS peer_reviews_open`,
    [config.presenceStaleSeconds],
  );
}
