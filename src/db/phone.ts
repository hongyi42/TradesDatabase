// The TypeScript twin of the generated column customers.phone_key
// (20260916130100_customers_phone_key.sql): the digits of a phone number, a
// leading US country code dropped, or null when fewer than 7 digits remain.
// The column is the stored key; this computes the key for a value being LOOKED
// UP, so the two must agree exactly — src/db/phone.test.ts runs every case
// through both. `[^0-9]` on both sides, never `\D`, which Postgres widens to
// non-ASCII digits.
export function phoneKey(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/[^0-9]/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits.length >= 7 ? digits : null;
}
