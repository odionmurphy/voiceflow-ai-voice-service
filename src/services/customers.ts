import { query } from '../config/db';

export interface Customer {
  id: string;
  business_id: string;
  full_name: string;
  phone_number: string;
}

export async function findOrCreateCustomer(
  businessId: string,
  phoneNumber: string,
  fullName?: string
): Promise<Customer> {
  const existing = await query(
    'SELECT * FROM customers WHERE business_id = $1 AND phone_number = $2',
    [businessId, phoneNumber]
  );
  if (existing.rows[0]) {
    // If we now have a name and didn't before, update it.
    if (fullName && existing.rows[0].full_name !== fullName) {
      const updated = await query(
        'UPDATE customers SET full_name = $1 WHERE id = $2 RETURNING *',
        [fullName, existing.rows[0].id]
      );
      return updated.rows[0];
    }
    return existing.rows[0];
  }

  const created = await query(
    `INSERT INTO customers (business_id, full_name, phone_number)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [businessId, fullName || 'Unknown caller', phoneNumber]
  );
  return created.rows[0];
}
