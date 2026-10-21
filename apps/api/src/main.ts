import { createApp } from './bootstrap';
import { loadConfig } from './config';

async function main() {
  const config = loadConfig();
  const app = await createApp(config);
  // Containers set API_HOST=0.0.0.0; locally the API only listens on this machine.
  await app.listen(config.port, process.env.API_HOST || 'localhost');
  console.log(`VerdFlow API listening on http://localhost:${config.port}/api`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
