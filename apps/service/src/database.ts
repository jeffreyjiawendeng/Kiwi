import { Pool, type PoolClient, type QueryResultRow } from "pg";

export interface SqlResult {
  rows: readonly Readonly<Record<string, unknown>>[];
}

export interface SqlExecutor {
  query(text: string, values?: readonly unknown[]): Promise<SqlResult>;
}

export interface ServiceDatabase {
  transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T>;
  probe(): Promise<void>;
  close(): Promise<void>;
}

function wrapExecutor(client: PoolClient): SqlExecutor {
  return {
    async query(text, values = []): Promise<SqlResult> {
      const result = await client.query<QueryResultRow>(text, [...values]);
      return { rows: result.rows };
    },
  };
}

export function createPostgresDatabase(connectionString: string): ServiceDatabase {
  const pool = new Pool({
    connectionString,
    application_name: "kiwi-account-service",
    max: 5,
    connectionTimeoutMillis: 2_500,
    idleTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  });

  pool.on("error", () => {
    console.error("The Kiwi database pool lost an idle connection.");
  });

  return {
    async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(wrapExecutor(client));
        await client.query("COMMIT");
        return result;
      } catch (cause) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw cause;
      } finally {
        client.release();
      }
    },

    async probe(): Promise<void> {
      await pool.query("SELECT 1");
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
