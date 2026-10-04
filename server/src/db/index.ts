/**
 * Database access layer.
 *
 * One small interface (`Db`) with two interchangeable engines:
 *   - PostgreSQL via `pg` — local Postgres or Amazon RDS (set DATABASE_URL)
 *   - PGlite — real PostgreSQL compiled to WebAssembly, embedded for zero-install
 *     local development and fast, isolated tests.
 *
 * All queries use positional parameters ($1, $2 …); string concatenation of
 * user input into SQL is never used.
 */
import fs from 'node:fs';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';

export interface QueryResult<T> {
  rows: T[];
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Execute a multi-statement SQL script (no parameters). Used only for migrations. */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  readonly engine: 'postgres' | 'pglite';
  /** Run `fn` inside a single transaction; rolls back on any thrown error. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// Return DATE columns as 'YYYY-MM-DD' strings and NUMERIC as strings (no float drift).
pg.types.setTypeParser(1082, (v: string) => v);

class PostgresDb implements Db {
  readonly engine = 'postgres' as const;
  constructor(private readonly pool: pg.Pool) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const r = await this.pool.query(sql, params as unknown[]);
    return { rows: r.rows as T[] };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx: Queryable = {
      async query<R>(sql: string, params: unknown[] = []) {
        const r = await client.query(sql, params as unknown[]);
        return { rows: r.rows as R[] };
      },
      async exec(sql: string) {
        await client.query(sql);
      },
    };
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

/** PGlite returns DATE as JS Date; normalise to match the pg driver. */
function normaliseRow(row: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Date && (k.endsWith('_date') || k === 'date')) {
      row[k] = v.toISOString().slice(0, 10);
    }
  }
  return row;
}

class PgliteDb implements Db {
  readonly engine = 'pglite' as const;
  constructor(private readonly pg: PGlite) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const r = await this.pg.query<Record<string, unknown>>(sql, params as unknown[]);
    return { rows: r.rows.map(normaliseRow) as T[] };
  }

  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (t) => {
      const tx: Queryable = {
        async query<R>(sql: string, params: unknown[] = []) {
          const r = await t.query<Record<string, unknown>>(sql, params as unknown[]);
          return { rows: r.rows.map(normaliseRow) as R[] };
        },
        async exec(sql: string) {
          await t.exec(sql);
        },
      };
      return fn(tx);
    });
  }

  async close() {
    await this.pg.close();
  }
}

export interface DbOptions {
  url?: string;
  ssl?: boolean;
  /** Directory for embedded data; 'memory://' for an in-memory database (tests). */
  pgliteDataDir?: string;
}

export async function createDb(opts: DbOptions): Promise<Db> {
  if (opts.url) {
    const pool = new pg.Pool({
      connectionString: opts.url,
      // RDS: TLS on. Supply the RDS CA bundle via NODE_EXTRA_CA_CERTS in production.
      ssl: opts.ssl ? { rejectUnauthorized: true } : undefined,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
    await pool.query('SELECT 1');
    return new PostgresDb(pool);
  }
  const dir = opts.pgliteDataDir ?? 'memory://';
  if (!dir.startsWith('memory://')) fs.mkdirSync(dir, { recursive: true });
  const db = new PGlite(dir);
  await db.waitReady;
  return new PgliteDb(db);
}
