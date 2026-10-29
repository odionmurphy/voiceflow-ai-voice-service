import { query } from "../config/db";

export interface BookAppointmentInput {
  businessId: string;
  customerId: string;
  serviceName?: string;
  startTime: string; // ISO
  endTime: string; // ISO
}

export interface AppointmentRecord {
  id: string;
  business_id: string;
  customer_id: string;
  service_name: string | null;
  start_time: string;
  end_time: string;
  status: string;
}

export class SlotTakenError extends Error {
  constructor() {
    super("Time slot overlaps an existing appointment");
    this.name = "SlotTakenError";
  }
}

function isOverlapError(err: unknown): boolean {
  return (err as { code?: string })?.code === "23P01";
}

export async function hasConflict(
  businessId: string,
  startTime: string,
  endTime: string,
): Promise<boolean> {
  const result = await query(
    `SELECT id FROM appointments
     WHERE business_id = $1 AND status != 'cancelled'
       AND start_time < $3 AND end_time > $2`,
    [businessId, startTime, endTime],
  );
  return result.rows.length > 0;
}

export async function hasConflictExcludingAppointment(
  businessId: string,
  startTime: string,
  endTime: string,
  excludeAppointmentId: string,
): Promise<boolean> {
  const result = await query(
    `SELECT id FROM appointments
     WHERE business_id = $1
       AND id != $4
       AND status != 'cancelled'
       AND start_time < $3 AND end_time > $2`,
    [businessId, startTime, endTime, excludeAppointmentId],
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
      [businessId, serviceName],
    );
    price = priceResult.rows[0]?.price ?? null;
  }

  let result;
  try {
    result = await query(
      `INSERT INTO appointments (business_id, customer_id, service_name, price, start_time, end_time, source, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'ai_call', 'confirmed')
       RETURNING *`,
      [businessId, customerId, serviceName || null, price, startTime, endTime],
    );
  } catch (err) {
    if (isOverlapError(err)) throw new SlotTakenError();
    throw err;
  }

  await query("UPDATE customers SET last_visit_at = $1 WHERE id = $2", [
    startTime,
    customerId,
  ]);

  return result.rows[0];
}

export async function getUpcomingAppointmentsForCustomer(
  businessId: string,
  customerId: string,
): Promise<AppointmentRecord[]> {
  const result = await query(
    `SELECT id, business_id, customer_id, service_name, start_time, end_time, status
     FROM appointments
     WHERE business_id = $1 AND customer_id = $2 AND status = 'confirmed' AND start_time > now()
     ORDER BY start_time ASC`,
    [businessId, customerId],
  );
  return result.rows;
}

export async function rescheduleAppointment(
  appointmentId: string,
  startTime: string,
  endTime: string,
) {
  try {
    return await query(
      `UPDATE appointments
       SET start_time = $2, end_time = $3, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [appointmentId, startTime, endTime],
    );
  } catch (err) {
    if (isOverlapError(err)) throw new SlotTakenError();
    throw err;
  }
}

export async function cancelAppointment(appointmentId: string) {
  return query(
    `UPDATE appointments
     SET status = 'cancelled', updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [appointmentId],
  );
}
