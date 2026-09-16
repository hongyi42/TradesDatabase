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
// insertTechnician. botUsername is the sandbox's Telegram bot handle (@...): the
// only way a technician can open the chat (bots cannot message first), known at
// provisioning time and nowhere later — so it is captured here or never.
// botId is the same story for the machine-readable half: the numeric id from
// the provision phase's getMe, which is what lets this bot's Mini App launches
// be verified WITHOUT its token ever leaving the box (initData.ts).
export async function registerSandbox(input: {
  tenantId: string;
  hostId: string;
  sandboxRef: string;
  botUsername?: string;
  botId?: string;
}): Promise<SandboxPoolRow> {
  const { data, error } = await getClient()
    .from('sandbox_pool')
    .insert({
      tenant_id: input.tenantId,
      host_id: input.hostId,
      sandbox_ref: input.sandboxRef,
      bot_username: input.botUsername ?? null,
      bot_id: input.botId ?? null,
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
// retired_at null is load-bearing: a completed recycle nulls technician_id on
// the DESTROYED row (releasing the unique claim slot), so without this filter
// the dead sandbox would look free and get claimed.
export async function listFreeSandboxes(tenantId: string): Promise<SandboxPoolRow[]> {
  const { data, error } = await getClient()
    .from('sandbox_pool')
    .select()
    .eq('tenant_id', tenantId)
    .is('technician_id', null)
    .is('retired_at', null)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listFreeSandboxes failed: ${error.message}`);
  return data ?? [];
}

// All pool rows for a tenant (free and claimed) — list_team joins these to show
// each person's bot handle, and a manager can re-ask "which bot does X use?"
// long after the bind-time message scrolled away.
export async function listPoolRows(tenantId: string): Promise<SandboxPoolRow[]> {
  const { data, error } = await getClient()
    .from('sandbox_pool')
    .select()
    .eq('tenant_id', tenantId);
  if (error) throw new Error(`listPoolRows failed: ${error.message}`);
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
    // Never claim a destroyed sandbox: retired rows release technician_id but
    // must stay unclaimable forever (same reasoning as listFreeSandboxes).
    .is('retired_at', null)
    .select()
    .maybeSingle();
  if (error) {
    throw Object.assign(new Error(`claimSandbox failed: ${error.message}`), { code: error.code });
  }
  return data;
}

// ── Retirement / recycling (2026-07-12) ─────────────────────────────────────
// A confirmed deactivation REQUESTS retirement of the person's sandbox; the
// box's badge pull serves it (retirements[]) until the box destroys +
// re-provisions and reports back, which COMPLETES it. A grace-period
// reactivation in between CANCELS it. Retired rows are kept forever.

// Mark the person's claimed sandbox for retirement. Write-if-not-yet-requested:
// null = no pool row, or already requested (idempotent — deactivation retries
// and repeat confirms must not error here).
export async function requestSandboxRetirement(
  technicianId: string,
): Promise<SandboxPoolRow | null> {
  const { data, error } = await getClient()
    .from('sandbox_pool')
    .update({ retire_requested_at: new Date().toISOString() })
    .eq('technician_id', technicianId)
    .is('retire_requested_at', null)
    .select()
    .maybeSingle();
  if (error) {
    throw Object.assign(new Error(`requestSandboxRetirement failed: ${error.message}`), {
      code: error.code,
    });
  }
  return data;
}

// Reactivation's undo: clear a PENDING request. Guarded on retired_at null —
// once the box reported completion the sandbox is gone and there is nothing to
// cancel (caller reads null and tells the manager to re-bind for a fresh one).
export async function cancelSandboxRetirement(
  technicianId: string,
): Promise<SandboxPoolRow | null> {
  const { data, error } = await getClient()
    .from('sandbox_pool')
    .update({ retire_requested_at: null })
    .eq('technician_id', technicianId)
    .not('retire_requested_at', 'is', null)
    .is('retired_at', null)
    .select()
    .maybeSingle();
  if (error) {
    throw Object.assign(new Error(`cancelSandboxRetirement failed: ${error.message}`), {
      code: error.code,
    });
  }
  return data;
}

// The badge pull's retirement working set: requested but not yet completed,
// for one host. Served every pull until the box's completion report lands.
export async function listRetirementsForHost(hostId: string): Promise<SandboxPoolRow[]> {
  const { data, error } = await getClient()
    .from('sandbox_pool')
    .select()
    .eq('host_id', hostId)
    .not('retire_requested_at', 'is', null)
    .is('retired_at', null);
  if (error) throw new Error(`listRetirementsForHost failed: ${error.message}`);
  return data ?? [];
}

// The box's completion report: stamp the old row retired (moving its claim to
// retired_technician_id — technician_id is UNIQUE, and releasing it lets a
// reactivated person claim a fresh blank) and register the rebuilt blank as a
// NEW row inheriting the retired row's tenant (the box cannot invent tenants).
// Both halves are idempotent so the box can retry a lost response safely.
export async function completeSandboxRecycle(input: {
  hostId: string;
  retiredSandboxRef: string;
  newSandboxRef: string;
  botUsername: string | null;
}): Promise<{
  retired: boolean;
  registered: boolean;
  tenantId: string;
  retiredTechnicianId: string | null;
}> {
  const client = getClient();
  const { data: row, error: readError } = await client
    .from('sandbox_pool')
    .select()
    .eq('host_id', input.hostId)
    .eq('sandbox_ref', input.retiredSandboxRef)
    .maybeSingle();
  if (readError) {
    throw new Error(`completeSandboxRecycle read failed: ${readError.message}`);
  }
  // Only ever retire what the server itself marked: an unmarked (or unknown)
  // ref means the box is confused — refuse rather than consume a live row.
  // code 'recycle_refused' is the HTTP handler's 409-vs-500 contract: refusals
  // are the box's fault (park + alarm), everything else is a server fault
  // (retry) — keyed on the code, not the message text, so rewording is safe.
  if (!row || (!row.retire_requested_at && !row.retired_at)) {
    throw Object.assign(
      new Error(`sandbox was not marked for retirement: ${input.retiredSandboxRef}`),
      { code: 'recycle_refused' },
    );
  }
  let retired = false;
  let retiredTechnicianId = row.retired_technician_id;
  if (!row.retired_at) {
    // CAS on retired_at-null: a concurrent duplicate report loses cleanly
    // (stamped=null) and returns retired:false with the PRE-stamp read's
    // retiredTechnicianId (null) — acceptable: the recycler is serialized, and
    // the winning call carries the id for the roster-residue clear.
    const { data: stamped, error: stampError } = await client
      .from('sandbox_pool')
      .update({
        retired_at: new Date().toISOString(),
        retired_technician_id: row.technician_id,
        technician_id: null,
      })
      .eq('id', row.id)
      .is('retired_at', null)
      .select()
      .maybeSingle();
    if (stampError) {
      throw new Error(`completeSandboxRecycle stamp failed: ${stampError.message}`);
    }
    if (stamped) {
      retired = true;
      retiredTechnicianId = stamped.retired_technician_id;
    }
  }
  let registered = false;
  try {
    await registerSandbox({
      tenantId: row.tenant_id,
      hostId: input.hostId,
      sandboxRef: input.newSandboxRef,
      botUsername: input.botUsername ?? undefined,
    });
    registered = true;
  } catch (err) {
    if ((err as { code?: string }).code !== '23505') throw err;
    // Duplicate (host, sandbox_ref): only accept it as OUR earlier insert — a
    // free row of the same tenant with the same bot handle. Anything else is a
    // real collision, and swallowing it would silently under-refill the pool.
    const { data: existing, error: existErr } = await client
      .from('sandbox_pool')
      .select()
      .eq('host_id', input.hostId)
      .eq('sandbox_ref', input.newSandboxRef)
      .maybeSingle();
    if (existErr) throw new Error(`completeSandboxRecycle re-read failed: ${existErr.message}`);
    const matchesThisRecycle =
      existing &&
      existing.tenant_id === row.tenant_id &&
      existing.technician_id === null &&
      (existing.bot_username ?? null) === (input.botUsername ?? null);
    if (!matchesThisRecycle) {
      throw Object.assign(
        new Error(
          `new sandbox ref '${input.newSandboxRef}' already exists on this host and does not match this recycle`,
        ),
        { code: 'recycle_refused' },
      );
    }
  }
  return { retired, registered, tenantId: row.tenant_id, retiredTechnicianId };
}

// Backfill for seats registered before bot_id existed, and the repair path when
// a bot is re-inspected. Digits only — the DB check constraint says the same
// thing, but a caller that pastes a whole token deserves a clear error rather
// than a 23514.
//
// PASS hostId. The table's uniqueness is (host_id, sandbox_ref), NOT tenant-
// scoped, so two hosts on one tenant can both own an 's1' — and a caller that
// validated one host's row would otherwise write to both (review finding
// 2026-09-09). Omitting it is allowed for single-host tenants and for tests,
// where maybeSingle() turns any collision into a loud failure rather than a
// silent cross-write.
export async function setSandboxBotId(input: {
  tenantId: string;
  hostId?: string;
  sandboxRef: string;
  botId: string;
  botUsername?: string;
}): Promise<SandboxPoolRow> {
  if (!/^[0-9]{1,20}$/.test(input.botId)) {
    throw new Error('setSandboxBotId: botId must be the numeric id, not the token');
  }
  let q = getClient()
    .from('sandbox_pool')
    .update({
      bot_id: input.botId,
      ...(input.botUsername ? { bot_username: input.botUsername } : {}),
    })
    .eq('tenant_id', input.tenantId)
    .eq('sandbox_ref', input.sandboxRef);
  if (input.hostId) q = q.eq('host_id', input.hostId);
  const { data, error } = await q.select().maybeSingle();
  if (error) throw new Error(`setSandboxBotId failed: ${error.message}`);
  if (!data) throw new Error(`setSandboxBotId: no sandbox ${input.sandboxRef} for this tenant`);
  return data;
}

// Every pool row on one host, across tenants — the shape the box's own report
// needs, because a box knows its seats by sandbox_ref and has no idea which
// tenant each belongs to (nor should it). Retired rows are included: the caller
// must be able to tell "unknown seat" from "retired seat" and refuse the second
// loudly rather than silently doing nothing.
export async function listPoolRowsForHost(hostId: string): Promise<SandboxPoolRow[]> {
  const { data, error } = await getClient()
    .from('sandbox_pool')
    .select()
    .eq('host_id', hostId);
  if (error) throw new Error(`listPoolRowsForHost failed: ${error.message}`);
  return data ?? [];
}

// THE ALLOWLIST behind Mini App signature checks: the numeric ids of every bot
// we own that can currently open the app. Cross-tenant on purpose — the same
// reasoning as findRosterByTelegramUserIdGlobal, because a launch slip proves
// which ACCOUNT and which BOT, never which firm; the roster decides the firm
// afterwards. Membership here is not authorisation, only "this came through a
// door we control".
//
// RETIRED SEATS ARE EXCLUDED. A recycled sandbox's bot is reassigned to the
// next hire, and until it is re-registered its id must not admit anyone.
export async function listLiveBotIds(): Promise<string[]> {
  const { data, error } = await getClient()
    .from('sandbox_pool')
    .select('bot_id')
    .not('bot_id', 'is', null)
    .is('retired_at', null);
  if (error) {
    // SCHEMA-BEHIND-CODE is a normal deploy order, not a fault: the column
    // arrives with a migration, and a service that shipped first would
    // otherwise fail this query behind every launch. "No column" means "no
    // bot has been wired yet", which is an empty allowlist — the caller still
    // has the board bot and the HMAC fallback, so the board keeps working and
    // nothing is let in. Any OTHER error is real and propagates.
    if (error.code === '42703' || /column .*bot_id.* does not exist/i.test(error.message)) {
      return [];
    }
    throw new Error(`listLiveBotIds failed: ${error.message}`);
  }
  return [...new Set((data ?? []).map((r) => r.bot_id).filter((id): id is string => !!id))];
}
