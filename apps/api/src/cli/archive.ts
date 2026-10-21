import { Pool } from 'pg';
import { loadConfig } from '../config';
import { archiveIntake } from '../ops/archive';

/** Usage: pnpm archive [--days 30] [--batch 1000]. See ops/archive.ts. */
async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback: number) => {
    const i = args.indexOf(name);
    const v = i >= 0 ? Number(args[i + 1]) : fallback;
    if (!Number.isInteger(v) || v < 0) throw new Error(`${name} must be a whole number`);
    return v;
  };
  const days = flag('--days', 30);
  const batchSize = Math.min(Math.max(flag('--batch', 1000), 1), 50_000);
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const total = await archiveIntake(pool, config.archiveDir, days, batchSize, console.log);
    console.log(total ? `Done: ${total} payloads archived to ${config.archiveDir}.` : `Nothing older than ${days} days to archive.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
