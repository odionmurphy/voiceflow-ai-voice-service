import { query } from '../config/db';

export interface LogCallInput {
  callSid: string;
  businessId: string;
  customerId: string | null;
  callerNumber: string;
  status: 'completed' | 'missed' | 'failed';
  durationSeconds: number;
  intent: 'book' | 'reschedule' | 'cancel' | 'faq' | 'other';
  transcript: string;
  summary: string | null;
  resultedInAppointmentId: string | null;
  needsFollowup: boolean;
  direction: 'inbound' | 'outbound';
  quotaReserved: boolean;
}

export async function logCall(input: LogCallInput) {
  await query(
    `INSERT INTO calls
       (business_id, customer_id, caller_number, status, duration_seconds, intent, transcript,
        summary, resulted_in_appointment_id, needs_followup, direction, twilio_call_sid, quota_reserved)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (twilio_call_sid)
     DO UPDATE SET customer_id = EXCLUDED.customer_id,
       status = EXCLUDED.status,
       duration_seconds = EXCLUDED.duration_seconds,
       intent = EXCLUDED.intent,
       transcript = EXCLUDED.transcript,
       summary = EXCLUDED.summary,
       resulted_in_appointment_id = EXCLUDED.resulted_in_appointment_id,
       needs_followup = EXCLUDED.needs_followup`,
    [
      input.callSid,
      input.businessId,
      input.customerId,
      input.callerNumber,
      input.status,
      input.durationSeconds,
      input.intent,
      input.transcript,
      input.summary,
      input.resultedInAppointmentId,
      input.needsFollowup,
      input.direction,
      input.quotaReserved,
    ]
  );
}
