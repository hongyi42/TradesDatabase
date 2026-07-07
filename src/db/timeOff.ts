import type { Database } from './database.types.js';
import { getClient } from './client.js';

export type TimeOff = Database['public']['Tables']['technician_time_off']['Row'];

export interface AddTimeOffInput {
  tenantId: string;
  technicianId: string;
  startsOn: string; // YYYY-MM-DD (whole days — user decision)
  endsOn: string; // YYYY-MM-DD, inclusive
  reason?: string | null;
}

// Date-ranged exception (vacation/sick/emergency). The DB check (ends_on >=
// starts_on) is the shape guard; preserve the SQLSTATE so callers can tell a
// check violation from anything else — same idiom as insertTechnician.
export async function addTimeOff(input: AddTimeOffInput): Promise<TimeOff> {
  const { data, error } = await getClient()
    .from('technician_time_off')
    .insert({
      tenant_id: input.tenantId,
      technician_id: input.technicianId,
      starts_on: input.startsOn,
      ends_on: input.endsOn,
      reason: input.reason ?? null,
    })
    .select()
    .single();
  if (error) {
    throw Object.assign(new Error(`addTimeOff failed: ${error.message}`), { code: error.code });
  }
  if (!data) throw new Error('addTimeOff failed: no row returned');
  return data;
}

// Tenant-guarded delete (mirrors resolveReviewItem): a cross-tenant or unknown
// id deletes nothing and returns false — the caller decides how to surface it.
export async function deleteTimeOff(id: string, tenantId: string): Promise<boolean> {
  const { data, error } = await getClient()
    .from('technician_time_off')
    .delete()
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .select()
    .maybeSingle();
  if (error) throw new Error(`deleteTimeOff failed: ${error.message}`);
  return !!data;
}

// Ranges OVERLAPPING the [fromDate, toDate] window (inclusive both ends): a
// vacation straddling either edge still counts — the availability calculator
// needs every range that touches the window, not just those inside it.
export async function listTimeOffForTechnician(
  technicianId: string,
  fromDate: string,
  toDate: string,
): Promise<TimeOff[]> {
  const { data, error } = await getClient()
    .from('technician_time_off')
    .select()
    .eq('technician_id', technicianId)
    .lte('starts_on', toDate)
    .gte('ends_on', fromDate)
    .order('starts_on', { ascending: true });
  if (error) throw new Error(`listTimeOffForTechnician failed: ${error.message}`);
  return data ?? [];
}
