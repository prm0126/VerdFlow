import type { PoolClient } from 'pg';

/** Returns work units to a radiologist. Locks their state row, like every other availability change. */
export async function releaseCapacity(client: PoolClient, radiologistId: string, units: number): Promise<void> {
  await client.query(
    `UPDATE radiologist_state SET active_units = greatest(active_units - $2, 0), version = version + 1, updated_at = now()
      WHERE radiologist_id = $1`,
    [radiologistId, units],
  );
}
