import { Pool } from 'pg';
import { loadConfig } from './config';
import { DeliveryWorker } from './outbound/delivery';
import { Processor } from './processing/processor';
import { TimerWorker } from './workflow/timers';

/**
 * Background worker: processes intake messages, delivers outbound HL7 and runs turnaround timers and
 * escalations every 15 seconds. Several copies can run at
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

  const timers = new TimerWorker(pool);
  const leaseTimer = setInterval(() => {
    delivery.recoverExpiredLeases().catch((err) => console.error('[leases]', err.message));
    timers.tick().catch((err) => console.error('[timers]', err.message));
  }, 15_000);

  console.log(`VerdFlow worker started (${config.workerIntakeConcurrency} intake, ${config.workerDeliveryConcurrency} delivery loops)`);
  // Several loops per kind; each claims its own row with SKIP LOCKED, so they never take the same message.
  await Promise.all([
    ...Array.from({ length: config.workerIntakeConcurrency }, (_, i) => loop(`intake-${i}`, () => processor.processNext())),
    ...Array.from({ length: config.workerDeliveryConcurrency }, (_, i) => loop(`delivery-${i}`, () => delivery.deliverNext())),
  ]);
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
