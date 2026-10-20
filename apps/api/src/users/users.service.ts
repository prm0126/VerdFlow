import { ROLES } from '@vf/shared';
import type { Pool } from 'pg';
import { z } from 'zod';
import { audit } from '../audit/audit';
import { hashPassword, randomToken, sha256 } from '../common/crypto';
import { many, one, withTransaction } from '../database/db';
import { Conflict, NotFound } from '../studies/studies.service';

export class UserError extends Error {}

const LINK_HOURS = 72;
export const MIN_PASSWORD_LENGTH = 12;

const roleCodes = Object.keys(ROLES) as [string, ...string[]];
const createSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  fullName: z.string().trim().min(1).max(120),
  roles: z.array(z.enum(roleCodes)).min(1).max(10),
});
const updateSchema = z.object({
  fullName: z.string().trim().min(1).max(120).optional(),
  roles: z.array(z.enum(roleCodes)).min(1).max(10).optional(),
  status: z.enum(['active', 'suspended']).optional(),
});

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new UserError(r.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; '));
  return r.data;
}

/**
 * User accounts. New users get a single-use set-password link that the administrator passes on;
 * VerdFlow never emails or displays a password.
 */
export class UsersService {
  constructor(private readonly pool: Pool) {}

  list() {
    return many(
      this.pool,
      `SELECT u.id, u.email, u.full_name, u.status, u.last_login_at, (u.locked_until > now()) AS locked,
              (u.password_hash IS NOT NULL) AS has_password,
              coalesce((SELECT array_agg(role_code ORDER BY role_code) FROM user_roles WHERE user_id = u.id), '{}') AS roles
         FROM users u ORDER BY u.full_name`,
    );
  }

  async create(input: unknown, actorId: string, ip?: string) {
    const u = parse(createSchema, input);
    return withTransaction(this.pool, async (client) => {
      const exists = await one(client, 'SELECT 1 FROM users WHERE lower(email) = lower($1)', [u.email]);
      if (exists) throw new Conflict('A user with this email already exists');
      const row = await one<{ id: string }>(client, 'INSERT INTO users (email, full_name) VALUES ($1, $2) RETURNING id', [u.email, u.fullName]);
      for (const r of u.roles) await client.query('INSERT INTO user_roles (user_id, role_code) VALUES ($1, $2)', [row!.id, r]);
      const token = await this.issueLink(client, row!.id, actorId);
      await audit(client, { actorType: 'user', actorId, action: 'users.created', entityType: 'user', entityId: row!.id, detail: { email: u.email, roles: u.roles }, ip });
      return { id: row!.id, token };
    });
  }

  async update(id: string, input: unknown, actorId: string, ip?: string) {
    const u = parse(updateSchema, input);
    if (id === actorId && u.status === 'suspended') throw new Conflict('You cannot suspend your own account');
    if (id === actorId && u.roles && !u.roles.includes('admin')) throw new Conflict('You cannot remove your own administrator role');
    return withTransaction(this.pool, async (client) => {
      const before = await one<{ status: string }>(client, 'SELECT status FROM users WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw new NotFound();
      if (u.fullName) await client.query('UPDATE users SET full_name = $2, updated_at = now() WHERE id = $1', [id, u.fullName]);
      if (u.roles) {
        await client.query('DELETE FROM user_roles WHERE user_id = $1', [id]);
        for (const r of u.roles) await client.query('INSERT INTO user_roles (user_id, role_code) VALUES ($1, $2)', [id, r]);
      }
      if (u.status) {
        await client.query('UPDATE users SET status = $2, updated_at = now() WHERE id = $1', [id, u.status]);
        if (u.status === 'suspended') {
          await client.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
          await client.query('UPDATE password_links SET revoked_at = now() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL', [id]);
        }
      }
      if (u.roles || u.status) {
        // A role or status change takes effect at once: other sessions must sign in again.
        await client.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND user_id <> $2', [id, actorId]);
      }
      await audit(client, { actorType: 'user', actorId, action: 'users.updated', entityType: 'user', entityId: id, detail: { ...u, statusBefore: before.status }, ip });
      return { ok: true };
    });
  }

  /** A new set-password link, for a new user or one who has forgotten their password. Older links stop working. */
  async newLink(id: string, actorId: string, ip?: string) {
    return withTransaction(this.pool, async (client) => {
      const u = await one<{ status: string }>(client, 'SELECT status FROM users WHERE id = $1 FOR UPDATE', [id]);
      if (!u) throw new NotFound();
      if (u.status !== 'active') throw new Conflict('Reactivate the account first');
      const token = await this.issueLink(client, id, actorId);
      await audit(client, { actorType: 'user', actorId, action: 'users.password_link_issued', entityType: 'user', entityId: id, ip });
      return { token };
    });
  }

  private async issueLink(client: Parameters<typeof one>[0], userId: string, actorId: string): Promise<string> {
    await client.query('UPDATE password_links SET revoked_at = now() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL', [userId]);
    const token = randomToken(32);
    await client.query(
      `INSERT INTO password_links (user_id, token_hash, expires_at, created_by) VALUES ($1, $2, now() + make_interval(hours => $3), $4)`,
      [userId, sha256(token), LINK_HOURS, actorId],
    );
    return token;
  }

  async checkLink(token: string): Promise<{ email: string; fullName: string } | null> {
    if (!token || token.length > 100) return null;
    return one<{ email: string; fullName: string }>(
      this.pool,
      `SELECT u.email, u.full_name AS "fullName" FROM password_links l JOIN users u ON u.id = l.user_id
        WHERE l.token_hash = $1 AND l.used_at IS NULL AND l.revoked_at IS NULL AND l.expires_at > now() AND u.status = 'active'`,
      [sha256(token)],
    );
  }

  async setPassword(token: string, password: string, ip?: string) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > 200) {
      throw new UserError(`Choose a password of at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const hash = await hashPassword(password);
    return withTransaction(this.pool, async (client) => {
      const link = await one<{ id: string; user_id: string }>(
        client,
        `SELECT l.id, l.user_id FROM password_links l JOIN users u ON u.id = l.user_id
          WHERE l.token_hash = $1 AND l.used_at IS NULL AND l.revoked_at IS NULL AND l.expires_at > now() AND u.status = 'active'
          FOR UPDATE OF l`,
        [sha256(String(token))],
      );
      if (!link) throw new UserError('This link has expired or has already been used. Ask an administrator for a new one.');
      await client.query('UPDATE password_links SET used_at = now() WHERE id = $1', [link.id]);
      await client.query(
        'UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1',
        [link.user_id, hash],
      );
      await client.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [link.user_id]);
      await audit(client, { actorType: 'user', actorId: link.user_id, action: 'users.password_set', entityType: 'user', entityId: link.user_id, ip });
      return { ok: true };
    });
  }
}
