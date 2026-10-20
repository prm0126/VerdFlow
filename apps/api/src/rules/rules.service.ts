import { ruleSetDefinitionSchema, type RuleSetDefinition } from '@vf/shared';
import type { Pool } from 'pg';
import { audit } from '../audit/audit';
import { sha256 } from '../common/crypto';
import { many, one, withTransaction } from '../database/db';

export class RuleError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

export interface RuleSetRow {
  id: string;
  version: number;
  status: string;
  definition: RuleSetDefinition;
  checksum: string;
  note: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  submitted_at: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  published_at: string | null;
}

const SELECT = `SELECT rs.id, rs.version, rs.status, rs.definition, rs.checksum, rs.note, rs.created_by, cu.full_name AS created_by_name,
                       rs.created_at, rs.submitted_at, du.full_name AS decided_by_name, rs.decided_at, rs.decision_note, rs.published_at
                  FROM rule_sets rs LEFT JOIN users cu ON cu.id = rs.created_by LEFT JOIN users du ON du.id = rs.decided_by`;

/**
 * Rule sets move draft → submitted → published (or rejected). The approver must be a different person
 * from the author. Publishing retires the previous version; decisions keep the version they used.
 */
export class RulesService {
  constructor(private readonly pool: Pool) {}

  list(): Promise<RuleSetRow[]> {
    return many<RuleSetRow>(this.pool, `${SELECT} ORDER BY rs.version DESC LIMIT 100`);
  }

  get(id: string): Promise<RuleSetRow | null> {
    return one<RuleSetRow>(this.pool, `${SELECT} WHERE rs.id = $1`, [id]);
  }

  async validate(input: unknown): Promise<RuleSetDefinition> {
    const parsed = ruleSetDefinitionSchema.safeParse(input);
    if (!parsed.success) {
      throw new RuleError(
        'The rule set is not valid',
        400,
        parsed.error.issues.map((i) => `${i.path.join('.') || 'rule set'}: ${i.message}`),
      );
    }
    const teamCodes = [...new Set(parsed.data.routing.map((r) => r.teamCode))];
    if (teamCodes.length) {
      const known = new Set(
        (await many<{ code: string }>(this.pool, 'SELECT code FROM teams WHERE code = ANY($1) AND active', [teamCodes])).map((t) => t.code),
      );
      const missing = teamCodes.filter((c) => !known.has(c));
      if (missing.length) throw new RuleError('The rule set is not valid', 400, missing.map((c) => `Team ${c} does not exist or is inactive`));
    }
    return parsed.data;
  }

  async createDraft(input: unknown, note: string | undefined, userId: string): Promise<RuleSetRow> {
    const def = await this.validate(input);
    const id = await withTransaction(this.pool, async (client) => {
      await client.query('LOCK TABLE rule_sets IN SHARE ROW EXCLUSIVE MODE');
      const next = ((await one<{ v: number }>(client, 'SELECT coalesce(max(version), 0) AS v FROM rule_sets'))?.v ?? 0) + 1;
      const row = await one<{ id: string }>(
        client,
        `INSERT INTO rule_sets (version, status, definition, checksum, note, created_by)
         VALUES ($1, 'draft', $2, $3, $4, $5) RETURNING id`,
        [next, JSON.stringify(def), sha256(JSON.stringify(def)), note?.slice(0, 500) ?? null, userId],
      );
      await audit(client, { actorType: 'user', actorId: userId, action: 'rules.draft_created', entityType: 'rule_set', entityId: row!.id, detail: { version: next } });
      return row!.id;
    });
    return (await this.get(id))!;
  }

  async updateDraft(id: string, input: unknown, note: string | undefined, userId: string): Promise<RuleSetRow> {
    const def = await this.validate(input);
    await withTransaction(this.pool, async (client) => {
      const row = await one<{ status: string; created_by: string }>(client, 'SELECT status, created_by FROM rule_sets WHERE id = $1 FOR UPDATE', [id]);
      if (!row) throw new RuleError('Rule set not found', 404);
      if (row.status !== 'draft') throw new RuleError('Only a draft can be edited. Create a new draft instead.', 409);
      await client.query(`UPDATE rule_sets SET definition = $2, checksum = $3, note = $4 WHERE id = $1`, [
        id,
        JSON.stringify(def),
        sha256(JSON.stringify(def)),
        note?.slice(0, 500) ?? null,
      ]);
      await audit(client, { actorType: 'user', actorId: userId, action: 'rules.draft_updated', entityType: 'rule_set', entityId: id });
    });
    return (await this.get(id))!;
  }

  async submit(id: string, userId: string): Promise<RuleSetRow> {
    await withTransaction(this.pool, async (client) => {
      const row = await one<{ status: string; definition: unknown }>(client, 'SELECT status, definition FROM rule_sets WHERE id = $1 FOR UPDATE', [id]);
      if (!row) throw new RuleError('Rule set not found', 404);
      if (row.status !== 'draft') throw new RuleError('Only a draft can be submitted', 409);
      await this.validate(row.definition);
      await client.query(`UPDATE rule_sets SET status = 'submitted', submitted_at = now() WHERE id = $1`, [id]);
      await audit(client, { actorType: 'user', actorId: userId, action: 'rules.submitted', entityType: 'rule_set', entityId: id });
    });
    return (await this.get(id))!;
  }

  async decide(id: string, approve: boolean, note: string | undefined, userId: string): Promise<RuleSetRow> {
    await withTransaction(this.pool, async (client) => {
      const row = await one<{ status: string; created_by: string | null; definition: unknown; version: number }>(
        client,
        'SELECT status, created_by, definition, version FROM rule_sets WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!row) throw new RuleError('Rule set not found', 404);
      if (row.status !== 'submitted') throw new RuleError('Only a submitted rule set can be approved or rejected', 409);
      if (row.created_by === userId) throw new RuleError('You cannot approve or reject a rule set you wrote', 403);
      if (!approve) {
        await client.query(`UPDATE rule_sets SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`, [
          id,
          userId,
          note?.slice(0, 500) ?? null,
        ]);
        await audit(client, { actorType: 'user', actorId: userId, action: 'rules.rejected', entityType: 'rule_set', entityId: id, detail: { note } });
        return;
      }
      await this.validate(row.definition);
      const retired = await one<{ id: string; version: number }>(
        client,
        `UPDATE rule_sets SET status = 'retired', retired_at = now() WHERE status = 'published' RETURNING id, version`,
      );
      await client.query(
        `UPDATE rule_sets SET status = 'published', decided_by = $2, decided_at = now(), decision_note = $3, published_at = now() WHERE id = $1`,
        [id, userId, note?.slice(0, 500) ?? null],
      );
      await audit(client, {
        actorType: 'user',
        actorId: userId,
        action: 'rules.published',
        entityType: 'rule_set',
        entityId: id,
        detail: { version: row.version, retiredVersion: retired?.version ?? null, note },
      });
    });
    return (await this.get(id))!;
  }
}
