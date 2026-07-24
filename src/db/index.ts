import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import type { Database, Queryable, QueryResult } from "./types.js";

function normalizeResult<Row extends Record<string, unknown>>(result: { rows: Row[]; rowCount?: number | null }): QueryResult<Row> {
  return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
}

// DATE has no timezone. Returning it as a JS Date can shift the calendar day in Asia/Shanghai.
pg.types.setTypeParser(1082, (value: string) => value);

export function isPostgresConnectionString(value: string): boolean {
  return /^postgres(?:ql)?:\/\//i.test(value);
}

export async function createPgliteDatabase(dataDir?: string): Promise<Database> {
  if (dataDir && dataDir !== ":memory:") {
    const absolute = resolve(dataDir);
    await mkdir(dirname(absolute), { recursive: true });
  }
  const client = new PGlite(dataDir === ":memory:" || !dataDir ? undefined : resolve(dataDir));
  await client.waitReady;

  return {
    async query<Row extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      return normalizeResult(await client.query<Row>(sql, params));
    },
    async exec(sql: string) {
      await client.exec(sql);
    },
    async transaction<T>(callback: (tx: Queryable) => Promise<T>): Promise<T> {
      return client.transaction(async (transaction) => callback({
        async query<Row extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
          return normalizeResult(await transaction.query<Row>(sql, params));
        },
        async exec(sql: string) {
          await transaction.exec(sql);
        },
      }));
    },
    async close() {
      await client.close();
    },
  };
}

export async function createPostgresDatabase(connectionString: string): Promise<Database> {
  const pool = new pg.Pool({ connectionString });
  await pool.query("SELECT 1");
  return {
    async query<Row extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      return normalizeResult(await pool.query<Row>(sql, params));
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async transaction<T>(callback: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await callback({
          async query<Row extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
            return normalizeResult(await client.query<Row>(sql, params));
          },
          async exec(sql: string) {
            await client.query(sql);
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

export async function createDatabase(options: {
  databaseUrl?: string;
  pgliteDataDir?: string;
  isProduction?: boolean;
} = {}): Promise<Database> {
  if (options.isProduction && (!options.databaseUrl || !isPostgresConnectionString(options.databaseUrl))) {
    throw new Error("Production database must use a postgres:// or postgresql:// DATABASE_URL");
  }
  if (options.databaseUrl) {
    if (!isPostgresConnectionString(options.databaseUrl)) {
      throw new Error("DATABASE_URL must use the postgres:// or postgresql:// scheme");
    }
    return createPostgresDatabase(options.databaseUrl);
  }
  return createPgliteDatabase(options.pgliteDataDir);
}

export type { Database, Queryable, QueryResult } from "./types.js";
