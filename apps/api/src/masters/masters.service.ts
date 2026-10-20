import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { audit } from '../audit/audit';
import { randomToken, sha256 } from '../common/crypto';
import { many, one, withTransaction } from '../database/db';

const code = z.string().trim().regex(/^[A-Z0-9_-]{1,30}$/, 'Use capitals, digits, hyphens and underscores');
const name = z.string().trim().min(1).max(120);

export const hospitalSchema = z.object({
  code,
  name,
  timezone: z.string().trim().min(1).max(60).default('Europe/London'),
  outboundPartnerCode: code.nullable().optional(),
  active: z.boolean().default(true),
});
export const modalitySchema = z.object({ code, name, workUnits: z.number().positive().max(100).default(1), active: z.boolean().default(true) });
export const serviceSchema = z.object({
  code,
  name,
  modalityCode: code.nullable().optional(),
  workUnits: z.number().positive().max(100).nullable().optional(),
  active: z.boolean().default(true),
});
export const teamSchema = z.object({ code, name, active: z.boolean().default(true) });
export const radiologistSchema = z.object({
  code,
  fullName: name,
  externalId: z.string().trim().min(1).max(60),
  grade: z.string().trim().max(40).nullable().optional(),
  specialties: z.array(code).max(30).default([]),
  active: z.boolean().default(true),
  capacityUnits: z.number().min(0).max(1000).default(10),
  modalities: z.array(code).max(50).default([]),
  hospitals: z.array(code).max(500).default([]),
  teams: z.array(code).max(50).default([]),
});
export const partnerSchema = z.object({
  code,
  name,
  direction: z.enum(['inbound', 'outbound']),
  allowedFacilities: z.array(code).max(500).default([]),
  endpointUrl: z.string().url().max(500).nullable().optional(),
  receivingApplication: z.string().max(60).nullable().optional(),
  receivingFacility: z.string().max(60).nullable().optional(),
  timeoutMs: z.number().int().min(100).max(120000).default(10000),
  active: z.boolean().default(true),
});

export type MasterKind = 'hospitals' | 'modalities' | 'services' | 'teams' | 'radiologists' | 'partners';

export class MasterError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new MasterError('Please check the highlighted fields', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  return r.data;
}

async function idsFor(client: PoolClient, table: 'hospitals' | 'teams' | 'modalities', codes: string[]): Promise<string[]> {
  if (!codes.length) return [];
  const col = table === 'modalities' ? 'code' : 'id';
  const rows = await many<{ code: string; id: string }>(client, `SELECT code, ${col} AS id FROM ${table} WHERE code = ANY($1)`, [codes]);
  const missing = codes.filter((c) => !rows.some((r) => r.code === c));
  if (missing.length) throw new MasterError(`Unknown ${table}: ${missing.join(', ')}`);
  return rows.map((r) => r.id);
}

export class MastersService {
  constructor(private readonly pool: Pool) {}

  list(kind: MasterKind) {
    switch (kind) {
      case 'hospitals':
        return many(this.pool, `SELECT h.code, h.name, h.timezone, h.active, p.code AS "outboundPartnerCode" FROM hospitals h LEFT JOIN integration_partners p ON p.id = h.outbound_partner_id ORDER BY h.code`);
      case 'modalities':
        return many(this.pool, `SELECT code, name, work_units AS "workUnits", active FROM modalities ORDER BY code`);
      case 'services':
        return many(this.pool, `SELECT code, name, modality_code AS "modalityCode", work_units AS "workUnits", active FROM services ORDER BY code`);
      case 'teams':
        return many(
          this.pool,
          `SELECT t.code, t.name, t.active,
                  (SELECT count(*)::int FROM team_members tm WHERE tm.team_id = t.id AND (tm.valid_to IS NULL OR tm.valid_to >= CURRENT_DATE)) AS members
             FROM teams t ORDER BY t.code`,
        );
      case 'radiologists':
        return many(
          this.pool,
          `SELECT r.code, r.full_name AS "fullName", r.external_id AS "externalId", r.grade, r.specialties, r.active,
                  st.capacity_units AS "capacityUnits",
                  coalesce((SELECT array_agg(modality_code ORDER BY modality_code) FROM radiologist_privileges WHERE radiologist_id = r.id
                             AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)), '{}') AS modalities,
                  coalesce((SELECT array_agg(h.code ORDER BY h.code) FROM radiologist_hospitals rh JOIN hospitals h ON h.id = rh.hospital_id
                             WHERE rh.radiologist_id = r.id), '{}') AS hospitals,
                  coalesce((SELECT array_agg(t.code ORDER BY t.code) FROM team_members tm JOIN teams t ON t.id = tm.team_id
                             WHERE tm.radiologist_id = r.id AND tm.valid_from <= CURRENT_DATE
                               AND (tm.valid_to IS NULL OR tm.valid_to >= CURRENT_DATE)), '{}') AS teams
             FROM radiologists r LEFT JOIN radiologist_state st ON st.radiologist_id = r.id ORDER BY r.code`,
        );
      case 'partners':
        return many(
          this.pool,
          `SELECT code, name, direction, allowed_facilities AS "allowedFacilities", endpoint_url AS "endpointUrl",
                  receiving_application AS "receivingApplication", receiving_facility AS "receivingFacility",
                  timeout_ms AS "timeoutMs", active
             FROM integration_partners ORDER BY code`,
        );
    }
  }

  /** Creates or updates one record by code. Returns a new partner API key once, when one is issued. */
  async save(kind: MasterKind, input: unknown, userId: string, ip?: string): Promise<{ code: string; apiKey?: string }> {
    return withTransaction(this.pool, async (client) => {
      let result: { code: string; apiKey?: string };
      switch (kind) {
        case 'hospitals': {
          const h = parse(hospitalSchema, input);
          const partnerId = h.outboundPartnerCode
            ? (await one<{ id: string }>(client, `SELECT id FROM integration_partners WHERE code = $1 AND direction = 'outbound'`, [h.outboundPartnerCode]))?.id
            : null;
          if (h.outboundPartnerCode && !partnerId) throw new MasterError(`No outbound partner has code ${h.outboundPartnerCode}`);
          await client.query(
            `INSERT INTO hospitals (code, name, timezone, outbound_partner_id, active) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, timezone = EXCLUDED.timezone,
               outbound_partner_id = EXCLUDED.outbound_partner_id, active = EXCLUDED.active`,
            [h.code, h.name, h.timezone, partnerId, h.active],
          );
          result = { code: h.code };
          break;
        }
        case 'modalities': {
          const m = parse(modalitySchema, input);
          await client.query(
            `INSERT INTO modalities (code, name, work_units, active) VALUES ($1, $2, $3, $4)
             ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, work_units = EXCLUDED.work_units, active = EXCLUDED.active`,
            [m.code, m.name, m.workUnits, m.active],
          );
          result = { code: m.code };
          break;
        }
        case 'services': {
          const s = parse(serviceSchema, input);
          if (s.modalityCode) await idsFor(client, 'modalities', [s.modalityCode]);
          await client.query(
            `INSERT INTO services (code, name, modality_code, work_units, active) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, modality_code = EXCLUDED.modality_code,
               work_units = EXCLUDED.work_units, active = EXCLUDED.active`,
            [s.code, s.name, s.modalityCode ?? null, s.workUnits ?? null, s.active],
          );
          result = { code: s.code };
          break;
        }
        case 'teams': {
          const t = parse(teamSchema, input);
          await client.query(
            `INSERT INTO teams (code, name, active) VALUES ($1, $2, $3)
             ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active`,
            [t.code, t.name, t.active],
          );
          result = { code: t.code };
          break;
        }
        case 'radiologists':
          result = await this.saveRadiologist(client, parse(radiologistSchema, input));
          break;
        case 'partners':
          result = await this.savePartner(client, parse(partnerSchema, input));
          break;
      }
      await audit(client, { actorType: 'user', actorId: userId, action: `masters.${kind}.saved`, entityType: kind, entityId: result.code, detail: { input: redact(input) }, ip });
      return result;
    });
  }

  /**
   * Credential, team and activity changes lock the radiologist's state row, the same lock the
   * allocation gate takes, so a reservation never uses a privilege that is being withdrawn.
   */
  private async saveRadiologist(client: PoolClient, r: z.infer<typeof radiologistSchema>) {
    const row = await one<{ id: string }>(
      client,
      `INSERT INTO radiologists (code, full_name, external_id, grade, specialties, active) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (code) DO UPDATE SET full_name = EXCLUDED.full_name, external_id = EXCLUDED.external_id,
         grade = EXCLUDED.grade, specialties = EXCLUDED.specialties, active = EXCLUDED.active
       RETURNING id`,
      [r.code, r.fullName, r.externalId, r.grade ?? null, r.specialties, r.active],
    );
    const id = row!.id;
    await client.query(`INSERT INTO radiologist_state (radiologist_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
    await client.query('SELECT 1 FROM radiologist_state WHERE radiologist_id = $1 FOR UPDATE', [id]);
    await client.query('UPDATE radiologist_state SET capacity_units = $2, version = version + 1, updated_at = now() WHERE radiologist_id = $1', [id, r.capacityUnits]);

    const modalityCodes = await idsFor(client, 'modalities', r.modalities);
    await client.query('DELETE FROM radiologist_privileges WHERE radiologist_id = $1 AND NOT (modality_code = ANY($2))', [id, modalityCodes]);
    for (const m of modalityCodes) {
      await client.query(
        `INSERT INTO radiologist_privileges (radiologist_id, modality_code) VALUES ($1, $2)
         ON CONFLICT (radiologist_id, modality_code) DO UPDATE SET valid_to = NULL`,
        [id, m],
      );
    }
    const hospitalIds = await idsFor(client, 'hospitals', r.hospitals);
    await client.query('DELETE FROM radiologist_hospitals WHERE radiologist_id = $1 AND NOT (hospital_id = ANY($2))', [id, hospitalIds]);
    for (const h of hospitalIds) {
      await client.query('INSERT INTO radiologist_hospitals (radiologist_id, hospital_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, h]);
    }
    const teamIds = await idsFor(client, 'teams', r.teams);
    // Memberships keep their history: leaving a team ends the membership rather than deleting it.
    await client.query(
      `DELETE FROM team_members WHERE radiologist_id = $1 AND NOT (team_id = ANY($2)) AND valid_from >= CURRENT_DATE`,
      [id, teamIds],
    );
    await client.query(
      `UPDATE team_members SET valid_to = CURRENT_DATE - 1
        WHERE radiologist_id = $1 AND NOT (team_id = ANY($2)) AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)`,
      [id, teamIds],
    );
    for (const t of teamIds) {
      const current = await one(
        client,
        `SELECT 1 FROM team_members WHERE radiologist_id = $1 AND team_id = $2 AND valid_from <= CURRENT_DATE
            AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)`,
        [id, t],
      );
      if (!current) {
        await client.query(
          `INSERT INTO team_members (team_id, radiologist_id, valid_from) VALUES ($1, $2, CURRENT_DATE)
           ON CONFLICT (team_id, radiologist_id, valid_from) DO UPDATE SET valid_to = NULL`,
          [t, id],
        );
      }
    }
    return { code: r.code };
  }

  private async savePartner(client: PoolClient, p: z.infer<typeof partnerSchema>) {
    const existing = await one<{ id: string; direction: string }>(client, 'SELECT id, direction FROM integration_partners WHERE code = $1', [p.code]);
    if (existing && existing.direction !== p.direction) throw new MasterError('A partner cannot change direction. Create a new partner.');
    if (p.direction === 'outbound' && !p.endpointUrl) throw new MasterError('An outbound partner needs an endpoint URL');
    let apiKey: string | undefined;
    if (!existing && p.direction === 'inbound') apiKey = `vfk_${randomToken(32)}`;
    if (existing) {
      await client.query(
        `UPDATE integration_partners SET name = $2, allowed_facilities = $3, endpoint_url = $4, receiving_application = $5,
                receiving_facility = $6, timeout_ms = $7, active = $8 WHERE id = $1`,
        [existing.id, p.name, p.allowedFacilities, p.endpointUrl ?? null, p.receivingApplication ?? null, p.receivingFacility ?? null, p.timeoutMs, p.active],
      );
    } else {
      await client.query(
        `INSERT INTO integration_partners (code, name, direction, api_key_hash, allowed_facilities, endpoint_url,
                                           receiving_application, receiving_facility, timeout_ms, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [p.code, p.name, p.direction, apiKey ? sha256(apiKey) : null, p.allowedFacilities, p.endpointUrl ?? null, p.receivingApplication ?? null, p.receivingFacility ?? null, p.timeoutMs, p.active],
      );
    }
    return { code: p.code, apiKey };
  }

  /** Issues a new key for an inbound partner. The old key stops working at once. */
  async rotatePartnerKey(partnerCode: string, userId: string, ip?: string): Promise<{ apiKey: string }> {
    const apiKey = `vfk_${randomToken(32)}`;
    return withTransaction(this.pool, async (client) => {
      const r = await one(client, `UPDATE integration_partners SET api_key_hash = $2 WHERE code = $1 AND direction = 'inbound' RETURNING id`, [partnerCode, sha256(apiKey)]);
      if (!r) throw new MasterError('No inbound partner has that code');
      await audit(client, { actorType: 'user', actorId: userId, action: 'masters.partners.key_rotated', entityType: 'partners', entityId: partnerCode, ip });
      return { apiKey };
    });
  }
}

function redact(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const { apiKey: _ignored, ...rest } = input as Record<string, unknown>;
  return rest;
}
