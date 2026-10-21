import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Pool } from 'pg';
import { many, withTransaction } from '../database/db';

/**
 * Moves raw HL7 payloads of processed messages older than `days` out of PostgreSQL into compressed,
 * checksummed batch files, keeping each row's metadata and a pointer to its batch. Each file is written
 * and verified before any payload is removed. Quarantined messages are kept. Returns how many were moved.
 *
 * Local development writes to a directory. Production must use encrypted object storage with retention
 * controls instead of local files.
 */
export async function archiveIntake(pool: Pool, archiveDir: string, days: number, batchSize: number, log: (line: string) => void = () => undefined): Promise<number> {
  mkdirSync(archiveDir, { recursive: true });
  let total = 0;
  for (;;) {
    const archived = await withTransaction(pool, async (client) => {
      const rows = await many<{ id: string; partner_id: string; control_id: string; received_at: Date; payload: string }>(
        client,
        `SELECT id, partner_id, control_id, received_at, payload FROM intake_messages
          WHERE payload IS NOT NULL AND status IN ('processed', 'ignored') AND received_at < now() - make_interval(days => $1)
          ORDER BY received_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [days, batchSize],
      );
      if (!rows.length) return 0;
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
      const fileName = `intake-${stamp}-${rows[0].id.slice(0, 8)}.ndjson.gz`;
      const body = gzipSync(rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      const sha256 = createHash('sha256').update(body).digest('hex');
      const path = join(archiveDir, fileName);
      writeFileSync(`${path}.tmp`, body, { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
      if (createHash('sha256').update(readFileSync(path)).digest('hex') !== sha256) throw new Error(`Archive ${fileName} did not verify`);
      await client.query(
        `INSERT INTO archive_batches (file_name, sha256, message_count, first_received_at, last_received_at) VALUES ($1, $2, $3, $4, $5)`,
        [fileName, sha256, rows.length, rows[0].received_at, rows[rows.length - 1].received_at],
      );
      await client.query(`UPDATE intake_messages SET payload = NULL, archived_at = now(), archive_ref = $2 WHERE id = ANY($1)`, [
        rows.map((r) => r.id),
        fileName,
      ]);
      log(`Archived ${rows.length} messages to ${fileName} (sha256 ${sha256.slice(0, 16)}…)`);
      return rows.length;
    });
    total += archived;
    if (archived < batchSize) break;
  }
  return total;
}
