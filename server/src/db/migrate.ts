/**
 * Minimal, dependency-free SQL migration runner.
 * Applies database/migrations/*.sql in filename order, once each, recording a
 * checksum so edits to an already-applied migration are detected.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../config.js';
import type { Db } from './index.js';

export const MIGRATIONS_DIR = path.join(PROJECT_ROOT, 'database', 'migrations');

export async function runMigrations(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      checksum   char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();

  const { rows } = await db.query<{ filename: string; checksum: string }>(
    'SELECT filename, checksum FROM schema_migrations',
  );
  const applied = new Map(rows.map((r) => [r.filename, r.checksum]));
  const newlyApplied: string[] = [];

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    const previous = applied.get(file);
    if (previous) {
      if (previous !== checksum) {
        throw new Error(`Migration ${file} was modified after being applied. Create a new migration instead.`);
      }
      continue;
    }
    await db.transaction(async (tx) => {
      // Multi-statement SQL: no parameters, executed as a script.
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [file, checksum]);
    });
    newlyApplied.push(file);
  }
  return newlyApplied;
}
