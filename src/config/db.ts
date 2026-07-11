import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[db] Unexpected error on idle client', err);
});

export async function query<T = any>(text: string, params?: any[]) {
  const res = await pool.query(text, params);
  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.log('[db]', { text: text.slice(0, 80), rows: res.rowCount });
  }
  return res;
}
