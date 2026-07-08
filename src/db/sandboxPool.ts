import type { Database } from './database.types.js';
import { getClient } from './client.js';

export type SandboxPoolRow = Database['public']['Tables']['sandbox_pool']['Row'];

// The rack of pre-built, identity-empty agent sandboxes on a host. The operator
// registers them once at box setup (allowed by the Telegram-only principle:
// operators appear only at initial setup); bind_telegram claims the next free
// one for a new hire. technician_id null = free/cold. Seats are reusable, refs
// never — a claim is a point-in-time assignment and is never reassigned to a
// different person.

// Register one cold sandbox into a host's pool. Surfaces the SQLSTATE so callers
// can distinguish 23505 (this host already has that sandbox_ref) — same idiom as
// insertTechnician.
export async function registerSandbox(input: {
  tenantId: string;
  hostId: string;
  sandboxRef: string;
}): Promise<SandboxPoolRow> {
  const { data, error } = await getClient()
    .from('sandbox_pool')
    .insert({
      tenant_id: input.tenantId,
      host_id: input.hostId,
      sandbox_ref: input.sandboxRef,
    })
    .select()
    .single();
  if (error || !data) {
    throw Object.assign(
      new Error(`registerSandbox failed: ${error?.message ?? 'no row returned'}`),
      { code: error?.code },
    );
  }
  return data;
}

// Idempotent-recovery read: if a prior bind claimed a sandbox but its roster
// patch failed mid-flight, the next bind finds the already-claimed row here and
// reuses it instead of claiming a second one. Safe as maybeSingle — technician_id
// is UNIQUE, so at most one pool row points at a person.
export async function getPoolRowByTechnician(
  technicianId: string,
): Promise<SandboxPoolRow | null> {
  const { data, error } = await getClient()
    .from('sandbox_pool')
    .select()
    .eq('technician_id', technicianId)
    .maybeSingle();
  if (error) throw new Error(`getPoolRowByTechnician failed: ${error.message}`);
  return data;
}

// Free (cold) sandboxes for the tenant, oldest-built first — bind_telegram
// claims the head. FIFO by created_at keeps allocation deterministic.
export async function listFreeSandboxes(tenantId: string): Promise<SandboxPoolRow[]> {
  const { data, error } = await getClient()
    .from('sandbox_pool')
    .select()
    .eq('tenant_id', tenantId)
    .is('technician_id', null)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listFreeSandboxes failed: ${error.message}`);
  return data ?? [];
}

// Claim-if-still-free: writes technician_id ONLY if the row is still unclaimed
// (the claimBadgeHash write-if-null pattern), so two concurrent binds cannot
// take the same sandbox — the loser gets null and tries the next free one.
export async function claimSandbox(
  id: string,
  technicianId: string,
): Promise<SandboxPoolRow | null> {
  const { data, error } = await getClient()
    .from('sandbox_pool')
    .update({ technician_id: technicianId })
    .eq('id', id)
    .is('technician_id', null)
    .select()
    .maybeSingle();
  if (error) {
    throw Object.assign(new Error(`claimSandbox failed: ${error.message}`), { code: error.code });
  }
  return data;
}
