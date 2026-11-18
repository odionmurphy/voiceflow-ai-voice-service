import { query, withTransaction } from '../config/db';

export interface Business {
  id: string;
  name: string;
  timezone: string;
  business_hours: Record<string, [string, string]>;
}

export interface AISettingsRow {
  greeting: string;
  voice_id: string;
  services: { name: string; durationMinutes: number; price: number }[];
  faq: { question: string; answer: string }[];
  booking_rules: {
    minNoticeHours?: number;
    bufferMinutes?: number;
    maxPerDay?: number;
    assistantName?: string;
    forwardingNumber?: string;
    notifyEmail?: string;
    privacyPolicyUrl?: string;
    language?: string;
    websiteDomains?: string[];
  };
}

export async function getBusinessByPhoneNumber(phoneNumber: string): Promise<Business | null> {
  const result = await query('SELECT * FROM businesses WHERE phone_number = $1', [phoneNumber]);
  return result.rows[0] || null;
}

export async function getBusinessById(id: string): Promise<Business | null> {
  const result = await query('SELECT * FROM businesses WHERE id = $1', [id]);
  return result.rows[0] || null;
}

export async function getAISettingsForBusiness(businessId: string): Promise<AISettingsRow | null> {
  const result = await query('SELECT * FROM ai_settings WHERE business_id = $1', [businessId]);
  return result.rows[0] || null;
}

export async function admitInboundCall(
  callSid: string,
  businessId: string,
  callerNumber: string
): Promise<boolean> {
  return withTransaction(async (client) => {
    const existing = await client.query(
      'SELECT business_id FROM calls WHERE twilio_call_sid = $1',
      [callSid]
    );
    if (existing.rows[0]) return existing.rows[0].business_id === businessId;

    const subscription = await client.query(
      `SELECT status, calls_included, calls_used_this_period
       FROM subscriptions WHERE business_id = $1 FOR UPDATE`,
      [businessId]
    );
    const duplicate = await client.query(
      'SELECT business_id FROM calls WHERE twilio_call_sid = $1',
      [callSid]
    );
    if (duplicate.rows[0]) return duplicate.rows[0].business_id === businessId;

    const current = subscription.rows[0];
    if (
      !current ||
      !['active', 'trialing'].includes(current.status) ||
      current.calls_used_this_period >= current.calls_included
    ) {
      return false;
    }

    await client.query(
      `UPDATE subscriptions
       SET calls_used_this_period = calls_used_this_period + 1
       WHERE business_id = $1`,
      [businessId]
    );
    await client.query(
      `INSERT INTO calls
         (business_id, caller_number, status, direction, twilio_call_sid, quota_reserved)
       VALUES ($1, $2, 'in_progress', 'inbound', $3, true)`,
      [businessId, callerNumber, callSid]
    );
    return true;
  });
}
