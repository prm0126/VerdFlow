import { createHash } from 'node:crypto';
import { Client } from 'pg';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const LOCK_ID = 917_301; // arbitrary advisory-lock key for VerdFlow migrations

/**
 * Applies pending migrations to one database. Each migration runs in its own transaction and its
 * checksum is recorded, so an edited, already-applied migration is detected instead of silently skipped.
 * Returns the resulting schema version.
 */
export async function migrate(connectionString: string, migrations: Migration[]): Promise<number> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const applied = new Map(
      (await client.query<{ version: number; checksum: string }>('SELECT version, checksum FROM schema_migrations')).rows.map(
        (r) => [r.version, r.checksum],
      ),
    );
    let current = 0;
    for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
      const checksum = createHash('sha256').update(m.sql).digest('hex');
      const existing = applied.get(m.version);
      if (existing) {
        if (existing !== checksum) {
          throw new Error(`Migration ${m.version}_${m.name} was modified after being applied. Add a new migration instead.`);
        }
        current = m.version;
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
          m.version,
          m.name,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.version}_${m.name} failed: ${(err as Error).message}`);
      }
      current = m.version;
    }
    return current;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    await client.end();
  }
}

export function latestVersion(migrations: Migration[]): number {
  return Math.max(0, ...migrations.map((m) => m.version));
}
