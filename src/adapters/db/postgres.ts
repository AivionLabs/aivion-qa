import { Pool } from "pg";
import type { DbAdapter } from "../../types.js";

export class PostgresAdapter implements DbAdapter {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
    const result = await this.pool.query(sql, params);
    return result.rows as T[];
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export async function pollUntil<T>(
  fn: () => Promise<T[]>,
  check: (rows: T[]) => boolean,
  timeoutMs: number,
  intervalMs = 500,
): Promise<T[]> {
  const deadline = Date.now() + timeoutMs;
  let lastRows: T[] = [];

  while (Date.now() < deadline) {
    lastRows = await fn();
    if (check(lastRows)) return lastRows;
    await sleep(Math.min(intervalMs, deadline - Date.now()));
  }

  return lastRows; // caller checks the result
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

export function createPostgresAdapter(connectionStringEnv: string): PostgresAdapter {
  const url = process.env[connectionStringEnv];
  if (!url) throw new Error(`Env var ${connectionStringEnv} is not set (required for Postgres adapter)`);
  return new PostgresAdapter(url);
}
