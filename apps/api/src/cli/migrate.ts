import { loadConfig } from '../config';
import { migrate } from '../database/migrator';
import { migrations } from '../database/migrations';

async function main() {
  const config = loadConfig();
  const version = await migrate(config.databaseUrl, migrations);
  console.log(`Database is at schema version ${version}.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
