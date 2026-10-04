import { createApp } from './app.js';
import { createExtractor } from './ai/index.js';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { isDatabaseEmpty, seedDemoData, seedUsers } from './db/seed.js';
import { createStorage } from './storage/index.js';

async function main() {
  const config = loadConfig();
  const db = await createDb({ url: config.db.url, ssl: config.db.ssl, pgliteDataDir: config.db.pgliteDataDir });
  await runMigrations(db);

  const storage = createStorage(config);
  if (config.auth.mode === 'dev') await seedUsers(db);
  if (config.db.autoSeed && (await isDatabaseEmpty(db))) {
    console.log('Empty database — seeding fictional demo data…');
    const n = await seedDemoData(db, storage, { rules: config.rules, exportConfig: config.export });
    console.log(`Seeded ${n} demo subawards.`);
  }

  const { app } = createApp({ config, db, storage, extractor: createExtractor(config) });
  const server = app.listen(config.port, () => {
    const banner = [
      '',
      '  GrantTrail AI — Subaward Reporting Assistant',
      `  API:        http://localhost:${config.port}/api/health`,
      `  AI mode:    ${config.ai.mode === 'demo' ? 'DEMO MODE (simulated extraction — no Claude API key configured)' : `Claude (${config.ai.model})`}`,
      `  Database:   ${db.engine === 'pglite' ? `embedded PostgreSQL (PGlite) at ${config.db.pgliteDataDir}` : 'PostgreSQL (DATABASE_URL)'}`,
      `  Storage:    ${config.storage.driver}`,
      `  Auth:       ${config.auth.mode === 'dev' ? 'development demo users' : 'Amazon Cognito'}`,
      '',
    ];
    console.log(banner.join('\n'));
  });

  const shutdown = async () => {
    server.close();
    await db.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start GrantTrail AI server:', err instanceof Error ? err.message : err);
  process.exit(1);
});
