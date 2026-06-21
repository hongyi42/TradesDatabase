import type { Database, Json } from './database.types.js';
import { getClient } from './client.js';

export type ScheduleEntry = Database['public']['Tables']['schedule_entries']['Row'];

export interface UpsertScheduleEntryInput {
  tenantId: string;
  technicianRef: string;
  externalRowKey: string; // stable id of the source sheet row
  customerId?: string | null;
  jobId?: string | null;
  customerName?: string | null;
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  phone?: string | null;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  source?: string;
  attributes?: Json;
}

// Idempotent on (tenant_id, external_row_key) — re-syncing a sheet updates the
// matching row in place rather than inserting a duplicate. updated_at is stamped
// by the DB trigger, so we never set it here.
export async function upsertScheduleEntry(input: UpsertScheduleEntryInput): Promise<ScheduleEntry> {
  const { data, error } = await getClient()
    .from('schedule_entries')
    .upsert(
      {
        tenant_id: input.tenantId,
        technician_ref: input.technicianRef,
        external_row_key: input.externalRowKey,
        customer_id: input.customerId ?? null,
        job_id: input.jobId ?? null,
        customer_name: input.customerName ?? null,
        address_line1: input.addressLine1 ?? null,
        city: input.city ?? null,
        state: input.state ?? null,
        postal_code: input.postalCode ?? null,
        phone: input.phone ?? null,
        scheduled_start: input.scheduledStart ?? null,
        scheduled_end: input.scheduledEnd ?? null,
        source: input.source ?? 'google_sheet',
        attributes: input.attributes ?? {},
      },
      { onConflict: 'tenant_id,external_row_key' },
    )
    .select()
    .single();
  if (error || !data) {
    throw new Error(`upsertScheduleEntry failed: ${error?.message ?? 'no row returned'}`);
  }
  return data;
}

// Entries for one technician whose scheduled_start falls on the UTC calendar day
// of isoDate. (UTC day is a deliberate v1 simplification; per-tenant timezones
// are deferred along with multi-tenant work.)
export async function listScheduleForTechnicianOnDate(
  tenantId: string,
  technicianRef: string,
  isoDate: string,
): Promise<ScheduleEntry[]> {
  const day = isoDate.slice(0, 10); // YYYY-MM-DD
  const { data, error } = await getClient()
    .from('schedule_entries')
    .select()
    .eq('tenant_id', tenantId)
    .eq('technician_ref', technicianRef)
    .gte('scheduled_start', `${day}T00:00:00.000Z`)
    .lte('scheduled_start', `${day}T23:59:59.999Z`)
    .order('scheduled_start', { ascending: true });
  if (error) throw new Error(`listScheduleForTechnicianOnDate failed: ${error.message}`);
  return data ?? [];
}
