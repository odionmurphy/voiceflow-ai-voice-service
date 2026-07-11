import { query } from '../config/db';

export interface Business {
  id: string;
  name: string;
  timezone: string;
  business_hours: Record<string, [string, string]>;
}

export interface AISettingsRow {
  greeting: string;
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
