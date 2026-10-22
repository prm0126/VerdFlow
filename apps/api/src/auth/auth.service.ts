import { ROLES, type Permission } from '@vf/shared';
import type { Pool } from 'pg';
import { audit } from '../audit/audit';
import { randomToken, sha256, verifyPassword } from '../common/crypto';
import type { AppConfig } from '../config';
import { many, one } from '../database/db';

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  roles: string[];
  permissions: Permission[];
  sessionId: string;
}

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

export function permissionsFor(roles: string[]): Permission[] {
  return [...new Set(roles.flatMap((r) => ROLES[r]?.permissions ?? []))];
}

export class AuthService {
  constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
  ) {}

  /** Returns a session token, or null. The same message is shown whatever the reason, to avoid account probing. */
  async login(email: string, password: string, ip?: string, userAgent?: string): Promise<{ token: string } | null> {
    const user = await one<{ id: string; password_hash: string | null; status: string; locked: boolean }>(
      this.pool,
      `SELECT id, password_hash, status, (locked_until IS NOT NULL AND locked_until > now()) AS locked
         FROM users WHERE lower(email) = lower($1)`,
      [email],
    );
    if (!user) {
      await verifyPassword(password, 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '=='); // even out timing
      await audit(this.pool, { actorType: 'system', action: 'auth.login_failed', detail: { reason: 'unknown_email' }, ip });
      return null;
    }
    if (user.status !== 'active' || user.locked) {
      await audit(this.pool, { actorType: 'user', actorId: user.id, action: 'auth.login_failed', detail: { reason: user.locked ? 'locked' : 'suspended' }, ip });
      return null;
    }
    if (!(await verifyPassword(password, user.password_hash))) {
      await this.pool.query(
        `UPDATE users SET failed_login_count = failed_login_count + 1,
                locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
          WHERE id = $1`,
        [user.id, MAX_FAILED_LOGINS, LOCK_MINUTES],
      );
      await audit(this.pool, { actorType: 'user', actorId: user.id, action: 'auth.login_failed', detail: { reason: 'bad_password' }, ip });
      return null;
    }
    const token = randomToken();
    await this.pool.query(
      `INSERT INTO sessions (user_id, token_hash, ip, user_agent, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))`,
      [user.id, sha256(token), ip ?? null, userAgent?.slice(0, 300) ?? null, this.config.sessionHours],
    );
    await this.pool.query(`UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [user.id]);
    // A radiologist signing in to VerdFlow counts as clocking in, unless they already have this session.
    await this.pool.query(
      `UPDATE radiologist_state st SET clocked_in_at = now(), updated_at = now()
         FROM radiologists r
        WHERE r.id = st.radiologist_id AND r.user_id = $1
          AND (st.clocked_in_at IS NULL
               OR st.clocked_in_at < coalesce((SELECT min(starts_at) FROM shifts sh WHERE sh.radiologist_id = r.id AND sh.starts_at <= now() AND sh.ends_at > now()), now()) - interval '1 hour')`,
      [user.id],
    );
    await audit(this.pool, { actorType: 'user', actorId: user.id, action: 'auth.login', ip });
    return { token };
  }

  async resolve(token: string | undefined): Promise<SessionUser | null> {
    if (!token || token.length > 200) return null;
    const row = await one<{ session_id: string; id: string; email: string; full_name: string }>(
      this.pool,
      `UPDATE sessions s SET last_seen_at = now()
         FROM users u
        WHERE s.token_hash = $1 AND s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'
        RETURNING s.id AS session_id, u.id, u.email, u.full_name`,
      [sha256(token)],
    );
    if (!row) return null;
    const roles = (await many<{ role_code: string }>(this.pool, 'SELECT role_code FROM user_roles WHERE user_id = $1', [row.id])).map((r) => r.role_code);
    return { id: row.id, email: row.email, fullName: row.full_name, roles, permissions: permissionsFor(roles), sessionId: row.session_id };
  }

  async logout(sessionId: string, userId: string): Promise<void> {
    await this.pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [sessionId]);
    await audit(this.pool, { actorType: 'user', actorId: userId, action: 'auth.logout' });
  }
}
