import { query } from '../config/db';

interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

// Mirrors backend/src/services/push.ts - duplicated rather than shared, since this
// service already writes directly to the shared Postgres DB instead of calling the
// backend's API (see services/appointments.ts). Best-effort: never throws.
export async function sendPushToBusinessMembers(
  businessId: string,
  title: string,
  body: string,
  data?: Record<string, unknown>
): Promise<void> {
  const result = await query(
    `SELECT pt.token FROM push_tokens pt
     JOIN business_members bm ON bm.user_id = pt.user_id
     WHERE bm.business_id = $1`,
    [businessId]
  );
  if (result.rows.length === 0) return;

  const messages: PushMessage[] = result.rows.map((r) => ({ to: r.token, title, body, data }));

  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    });
    if (!res.ok) {
      console.error('[push] Expo push API error:', res.status, await res.text());
    }
  } catch (err: any) {
    console.error('[push] send failed:', err.message);
  }
}
