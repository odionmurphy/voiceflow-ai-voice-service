import { query } from '../config/db';

export interface LogCallInput {
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
}

export async function logCall(input: LogCallInput) {
  await query(
    `INSERT INTO calls (business_id, customer_id, caller_number, status, duration_seconds, intent, transcript, summary, resulted_in_appointment_id, needs_followup, direction)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
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
    ]
  );
}
