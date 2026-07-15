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

  // Snapshot the service's price at booking time - mirrors backend's POST
  // /appointments so AI-booked and manually-booked appointments carry revenue the
  // same way (see backend/src/db/schema.sql's comment on appointments.price).
  let price: number | null = null;
  if (serviceName) {
    const priceResult = await query(
      `SELECT (elem->>'price')::numeric AS price
       FROM ai_settings, jsonb_array_elements(services) AS elem
       WHERE business_id = $1 AND elem->>'name' = $2
       LIMIT 1`,
      [businessId, serviceName]
    );
    price = priceResult.rows[0]?.price ?? null;
  }

  const result = await query(
    `INSERT INTO appointments (business_id, customer_id, service_name, price, start_time, end_time, source, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'ai_call', 'confirmed')
     RETURNING *`,
    [businessId, customerId, serviceName || null, price, startTime, endTime]
  );

  await query('UPDATE customers SET last_visit_at = $1 WHERE id = $2', [startTime, customerId]);

  return result.rows[0];
}
