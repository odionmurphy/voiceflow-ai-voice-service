import { Pool, PoolClient } from "pg";
import dotenv from "dotenv";

dotenv.config();

function getSslConfig(connectionString?: string) {
  if (!connectionString) return false;

  try {
    const { hostname } = new URL(connectionString);
    const isLocalHost =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1";
    return isLocalHost ? false : { rejectUnauthorized: false };
  } catch {
    return false;
  }
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: getSslConfig(process.env.DATABASE_URL),
});

pool.on("error", (err) => {
  // eslint-disable-next-line no-console
  console.error("[db] Unexpected error on idle client", err);
});

export async function query<T = any>(text: string, params?: any[]) {
  const res = await pool.query(text, params);
  if (process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.log("[db]", { text: text.slice(0, 80), rows: res.rowCount });
  }
  return res;
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
