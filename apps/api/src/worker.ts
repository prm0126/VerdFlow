import { Pool } from 'pg';
import { loadConfig } from './config';
import { DeliveryWorker } from './outbound/delivery';
import { Processor } from './processing/processor';

/**
 * Background worker: processes intake messages and delivers outbound HL7. Several copies can run at
 * once; rows are claimed with FOR UPDATE SKIP LOCKED.
 */
async function main() {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  const processor = new Processor(pool, config);
  const delivery = new DeliveryWorker(pool, config);
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const loop = async (name: string, step: () => Promise<unknown | null>) => {
    while (!stopping) {
      try {
        const did = await step();
        if (!did) await sleep(500);
      } catch (err) {
        console.error(`[${name}]`, err instanceof Error ? err.message : err);
        await sleep(2000);
      }
    }
  };

  const leaseTimer = setInterval(() => {
    delivery.recoverExpiredLeases().catch((err) => console.error('[leases]', err.message));
  }, 15_000);

  console.log('VerdFlow worker started');
  await Promise.all([loop('intake', () => processor.processNext()), loop('delivery', () => delivery.deliverNext())]);
  clearInterval(leaseTimer);
  await pool.end();
  console.log('VerdFlow worker stopped');
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
