/**
 * Database CLI:  tsx src/db/cli.ts <migrate|seed|reset>
 */
import fs from 'node:fs';
import { loadConfig } from '../config.js';
import { createStorage } from '../storage/index.js';
import { createDb } from './index.js';
import { runMigrations } from './migrate.js';
import { isDatabaseEmpty, seedDemoData } from './seed.js';

async function main() {
  const cmd = process.argv[2];
  const config = loadConfig();

  if (cmd === 'reset') {
    if (config.db.url) {
      console.error('db:reset only resets the embedded development database. It refuses to touch DATABASE_URL.');
      process.exit(1);
    }
    fs.rmSync(config.db.pgliteDataDir, { recursive: true, force: true });
    if (config.storage.driver === 'local') fs.rmSync(config.storage.localDir, { recursive: true, force: true });
    console.log('Embedded database and local document storage removed.');
  }

  const db = await createDb({ url: config.db.url, ssl: config.db.ssl, pgliteDataDir: config.db.pgliteDataDir });
  try {
    const applied = await runMigrations(db);
    console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database schema is up to date.');

    if (cmd === 'seed' || cmd === 'reset') {
      if (!(await isDatabaseEmpty(db))) {
        console.log('Database already contains subawards — skipping demo seed (run db:reset to start over).');
      } else {
        console.log('Seeding fictional demo data for Riverbend Housing Coalition:');
        const n = await seedDemoData(db, createStorage(config), {
          rules: config.rules,
          exportConfig: config.export,
          log: console.log,
        });
        console.log(`Seeded ${n} demo subawards.`);
      }
    } else if (cmd !== 'migrate') {
      console.error('Usage: cli.ts <migrate|seed|reset>');
      process.exitCode = 1;
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
