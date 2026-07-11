import { query } from '../config/db';

export interface BookAppointmentInput {
  businessId: string;
  customerId: string;
  serviceName?: string;
  startTime: string; // ISO
  endTime: string; // ISO
}

export async function hasConflict(
  businessId: string,
  startTime: string,
  endTime: string
): Promise<boolean> {
  const result = await query(
    `SELECT id FROM appointments
     WHERE business_id = $1 AND status != 'cancelled'
       AND start_time < $3 AND end_time > $2`,
    [businessId, startTime, endTime]
  );
  return result.rows.length > 0;
}

export async function bookAppointment(input: BookAppointmentInput) {
  const { businessId, customerId, serviceName, startTime, endTime } = input;

  const result = await query(
    `INSERT INTO appointments (business_id, customer_id, service_name, start_time, end_time, source, status)
     VALUES ($1, $2, $3, $4, $5, 'ai_call', 'confirmed')
     RETURNING *`,
    [businessId, customerId, serviceName || null, startTime, endTime]
  );

  await query('UPDATE customers SET last_visit_at = $1 WHERE id = $2', [startTime, customerId]);

  return result.rows[0];
}
