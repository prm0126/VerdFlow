import { Pool, PoolClient, QueryResultRow, types } from 'pg';

// NUMERIC as numbers; DATE as 'YYYY-MM-DD' strings with no timezone shifting.
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(1082, (v) => v);

export type Queryable = Pick<Pool | PoolClient, 'query'>;

export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function one<T extends QueryResultRow>(db: Queryable, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await db.query<T>(sql, params);
  return r.rows[0] ?? null;
}

export async function many<T extends QueryResultRow>(db: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

/** PostgreSQL errors worth retrying: serialization failure, deadlock, lock timeout. */
export function isTransientDbError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === '40001' || code === '40P01' || code === '55P03';
}
