import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { audit } from '../audit/audit';
import { many, one, withTransaction } from '../database/db';
import { Conflict, NotFound } from '../studies/studies.service';

export class RotaError extends Error {}

const shiftSchema = z
  .object({
    radiologistId: z.string().uuid(),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    kind: z.enum(['reporting', 'on_call']).default('reporting'),
    note: z.string().max(200).optional(),
  })
  .refine((s) => new Date(s.endsAt) > new Date(s.startsAt), 'The shift must end after it starts')
  .refine((s) => new Date(s.endsAt).getTime() - new Date(s.startsAt).getTime() <= 36 * 3600_000, 'A shift can be at most 36 hours');

const absenceSchema = z
  .object({
    radiologistId: z.string().uuid(),
    kind: z.enum(['leave', 'break', 'training', 'other']),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .refine((a) => !a.endsAt || new Date(a.endsAt) > new Date(a.startsAt), 'The absence must end after it starts')
  .refine((a) => a.kind === 'break' || !!a.endsAt, 'Leave, training and other absences need an end time');

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new RotaError(r.error.issues.map((i) => i.message).join('; '));
  return r.data;
}

/**
 * SQL fragments for "on shift now" and "absent now", for a radiologist id expression. Shared by the
 * allocation gate, the pre-send re-check and the availability view so they never disagree.
 */
export const onShiftNow = (rid: string) =>
  `EXISTS (SELECT 1 FROM shifts sh WHERE sh.radiologist_id = ${rid} AND sh.starts_at <= now() AND sh.ends_at > now())`;
export const absenceNow = (rid: string) =>
  `(SELECT ab.kind FROM absences ab WHERE ab.radiologist_id = ${rid} AND ab.starts_at <= now()
      AND (ab.ends_at IS NULL OR ab.ends_at > now()) ORDER BY ab.starts_at DESC LIMIT 1)`;

/**
 * Rota changes take the radiologist's state-row lock, the same lock the allocation gate takes, so a
 * reservation never relies on a shift or break that is changing at the same moment.
 */
async function lockRadiologist(client: PoolClient, radiologistId: string) {
  const r = await one(client, 'SELECT 1 FROM radiologist_state WHERE radiologist_id = $1 FOR UPDATE', [radiologistId]);
  if (!r) throw new NotFound();
}

export class RotaService {
  constructor(private readonly pool: Pool) {}

  async week(from: string, to: string) {
    const f = new Date(from);
    const t = new Date(to);
    if (isNaN(f.getTime()) || isNaN(t.getTime()) || t <= f || t.getTime() - f.getTime() > 62 * 86400_000) {
      throw new RotaError('Choose a date range of up to two months');
    }
    const [radiologists, shifts, absences] = await Promise.all([
      many(
        this.pool,
        `SELECT r.id, r.code, r.full_name,
                ${onShiftNow('r.id')} AS on_shift_now, ${absenceNow('r.id')} AS absent_now
           FROM radiologists r WHERE r.active ORDER BY r.full_name`,
      ),
      many(
        this.pool,
        `SELECT id, radiologist_id, starts_at, ends_at, kind, note FROM shifts
          WHERE starts_at < $2 AND ends_at > $1 ORDER BY starts_at`,
        [f, t],
      ),
      many(
        this.pool,
        `SELECT id, radiologist_id, kind, starts_at, ends_at FROM absences
          WHERE starts_at < $2 AND (ends_at IS NULL OR ends_at > $1) ORDER BY starts_at`,
        [f, t],
      ),
    ]);
    return { radiologists, shifts, absences };
  }

  async addShift(input: unknown, userId: string, ip?: string) {
    const s = parse(shiftSchema, input);
    return withTransaction(this.pool, async (client) => {
      await lockRadiologist(client, s.radiologistId);
      const clash = await one(
        client,
        'SELECT 1 FROM shifts WHERE radiologist_id = $1 AND starts_at < $3 AND ends_at > $2',
        [s.radiologistId, s.startsAt, s.endsAt],
      );
      if (clash) throw new Conflict('This shift overlaps another shift for the same radiologist');
      const row = await one<{ id: string }>(
        client,
        `INSERT INTO shifts (radiologist_id, starts_at, ends_at, kind, note, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [s.radiologistId, s.startsAt, s.endsAt, s.kind, s.note ?? null, userId],
      );
      await audit(client, { actorType: 'user', actorId: userId, action: 'rota.shift_added', entityType: 'radiologist', entityId: s.radiologistId, detail: { shiftId: row!.id, ...s }, ip });
      return { id: row!.id };
    });
  }

  async deleteShift(id: string, userId: string, ip?: string) {
    return withTransaction(this.pool, async (client) => {
      const s = await one<{ radiologist_id: string; starts_at: string; ends_at: string }>(client, 'SELECT radiologist_id, starts_at, ends_at FROM shifts WHERE id = $1', [id]);
      if (!s) throw new NotFound();
      await lockRadiologist(client, s.radiologist_id);
      await client.query('DELETE FROM shifts WHERE id = $1', [id]);
      await audit(client, { actorType: 'user', actorId: userId, action: 'rota.shift_removed', entityType: 'radiologist', entityId: s.radiologist_id, detail: { shiftId: id, startsAt: s.starts_at, endsAt: s.ends_at }, ip });
      return { ok: true };
    });
  }

  async addAbsence(input: unknown, userId: string, ip?: string) {
    const a = parse(absenceSchema, input);
    return withTransaction(this.pool, async (client) => {
      await lockRadiologist(client, a.radiologistId);
      if (a.kind === 'break') {
        const open = await one(client, `SELECT 1 FROM absences WHERE radiologist_id = $1 AND kind = 'break' AND ends_at IS NULL`, [a.radiologistId]);
        if (open) throw new Conflict('This radiologist is already on a break');
      }
      const row = await one<{ id: string }>(
        client,
        `INSERT INTO absences (radiologist_id, kind, starts_at, ends_at, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [a.radiologistId, a.kind, a.startsAt, a.endsAt ?? null, userId],
      );
      await audit(client, { actorType: 'user', actorId: userId, action: 'rota.absence_added', entityType: 'radiologist', entityId: a.radiologistId, detail: { absenceId: row!.id, kind: a.kind, startsAt: a.startsAt, endsAt: a.endsAt ?? null }, ip });
      return { id: row!.id };
    });
  }

  /** Ends an absence now (or removes one that has not started). */
  async endAbsence(id: string, userId: string, ip?: string) {
    return withTransaction(this.pool, async (client) => {
      const a = await one<{ radiologist_id: string; started: boolean }>(client, 'SELECT radiologist_id, starts_at <= now() AS started FROM absences WHERE id = $1', [id]);
      if (!a) throw new NotFound();
      await lockRadiologist(client, a.radiologist_id);
      if (a.started) await client.query('UPDATE absences SET ends_at = now() WHERE id = $1 AND (ends_at IS NULL OR ends_at > now())', [id]);
      else await client.query('DELETE FROM absences WHERE id = $1', [id]);
      await audit(client, { actorType: 'user', actorId: userId, action: 'rota.absence_ended', entityType: 'radiologist', entityId: a.radiologist_id, detail: { absenceId: id }, ip });
      return { ok: true };
    });
  }

  startBreak(radiologistId: string, userId: string, ip?: string) {
    return this.addAbsence({ radiologistId, kind: 'break', startsAt: new Date().toISOString() }, userId, ip);
  }

  async endBreak(radiologistId: string, userId: string, ip?: string) {
    const open = await one<{ id: string }>(this.pool, `SELECT id FROM absences WHERE radiologist_id = $1 AND kind = 'break' AND ends_at IS NULL`, [radiologistId]);
    if (!open) throw new Conflict('This radiologist is not on a break');
    return this.endAbsence(open.id, userId, ip);
  }
}
