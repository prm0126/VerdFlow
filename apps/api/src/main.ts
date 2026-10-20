import { createApp } from './bootstrap';
import { loadConfig } from './config';

async function main() {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.port, 'localhost');
  console.log(`VerdFlow API listening on http://localhost:${config.port}/api`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
