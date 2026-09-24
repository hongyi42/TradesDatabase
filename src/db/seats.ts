import type { Database } from './database.types.js';
import { getClient } from './client.js';
import { getPoolRowByTechnician } from './sandboxPool.js';

export type Seat = Database['public']['Tables']['seats']['Row'];
export type SeatBot = Database['public']['Tables']['seat_bots']['Row'];

// A seat is a person's GLUE assistant (step 4, plan 2026-09-23-step-4-per-seat-
// tokens): which box runs it, which Telegram bot it answers, and the fingerprint
// of its bearer token. OpenClaw seats have no row here until step 5 moves them —
// they live in sandbox_pool + technicians.sandbox_ref, untouched.
//
// "Live" everywhere below = retired_at is null. The partial unique indexes are
// on live rows only, so a retired seat never blocks a person, a ref or a bot.

// The live seat of one person — at most one (seats_live_technician_key).
export async function getSeatByTechnician(technicianId: string): Promise<Seat | null> {
  const { data, error } = await getClient()
    .from('seats')
    .select()
    .eq('technician_id', technicianId)
    .is('retired_at', null)
    .maybeSingle();
  if (error) throw new Error(`getSeatByTechnician failed: ${error.message}`);
  return data;
}

// The live seat a box knows by its ref. Host-scoped because the box's host token
// is the caller's identity: a box may only ever reach its own seats.
export async function getSeatByHostRef(hostId: string, seatRef: string): Promise<Seat | null> {
  const { data, error } = await getClient()
    .from('seats')
    .select()
    .eq('host_id', hostId)
    .eq('seat_ref', seatRef)
    .is('retired_at', null)
    .maybeSingle();
  if (error) throw new Error(`getSeatByHostRef failed: ${error.message}`);
  return data;
}

// Token → identity, for every seat-token request. The person's ref comes from
// an embed, and embeds do NOT inherit tenancy (data-security §1): a seat whose
// person sits in another firm resolves to null, never to a cross-tenant identity.
export async function getSeatIdentityByTokenHash(
  tokenHash: string,
): Promise<{ seat: Seat; technicianRef: string } | null> {
  const { data, error } = await getClient()
    .from('seats')
    .select('*, technicians!inner(ref, tenant_id)')
    .eq('token_hash', tokenHash)
    .is('retired_at', null)
    .maybeSingle();
  if (error) throw new Error(`getSeatIdentityByTokenHash failed: ${error.message}`);
  if (!data) return null;
  const { technicians: person, ...seat } = data;
  if (!person || person.tenant_id !== seat.tenant_id) return null;
  return { seat, technicianRef: person.ref };
}

// The bot a seat answers: its seat_bots row, else the pool row it came from
// (s5 and every seat step 5 moves keep their bot there), else unknown.
export async function getSeatBotUsername(seat: Seat): Promise<string | null> {
  if (seat.bot_ref) {
    const { data, error } = await getClient()
      .from('seat_bots')
      .select('bot_username')
      .eq('id', seat.bot_ref)
      .maybeSingle();
    if (error) throw new Error(`getSeatBotUsername failed: ${error.message}`);
    if (data) return data.bot_username;
  }
  return (await getPoolRowByTechnician(seat.technician_id))?.bot_username ?? null;
}

// Store a freshly minted token's fingerprint. Overwrites any previous one: that
// IS rotation — the old token stops resolving on its very next request.
export async function mintSeatToken(seatId: string, tokenHash: string): Promise<Seat> {
  const { data, error } = await getClient()
    .from('seats')
    .update({ token_hash: tokenHash, token_minted_at: new Date().toISOString() })
    .eq('id', seatId)
    .is('retired_at', null)
    .select()
    .maybeSingle();
  if (error) throw new Error(`mintSeatToken failed: ${error.message}`);
  if (!data) throw new Error('mintSeatToken: no live seat with that id');
  return data;
}

// Insert a glue seat. A 23505 carries the violated index name in `constraint`,
// so a caller can tell "someone else took this bot" (try the next) from "this
// person already has a seat" (reuse it).
export async function createSeat(input: {
  tenantId: string;
  technicianId: string;
  hostId: string;
  seatRef: string;
  botRef: string | null;
}): Promise<Seat> {
  const { data, error } = await getClient()
    .from('seats')
    .insert({
      tenant_id: input.tenantId,
      technician_id: input.technicianId,
      host_id: input.hostId,
      seat_ref: input.seatRef,
      bot_ref: input.botRef,
    })
    .select()
    .single();
  if (error || !data) {
    const constraint = /constraint "([^"]+)"/.exec(error?.message ?? '')?.[1];
    throw Object.assign(new Error(`createSeat failed: ${error?.message ?? 'no row returned'}`), {
      code: error?.code,
      constraint,
    });
  }
  return data;
}

// Bots a new hire of this firm may take: live, the firm's own or any-firm, and
// not already answering a live seat. Oldest first (the pool's FIFO rule).
export async function listFreeSeatBots(tenantId: string): Promise<SeatBot[]> {
  const client = getClient();
  const { data: bots, error } = await client
    .from('seat_bots')
    .select()
    .or(`tenant_id.eq.${tenantId},tenant_id.is.null`)
    .is('retired_at', null)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listFreeSeatBots failed: ${error.message}`);
  if (!bots?.length) return [];
  const { data: taken, error: takenError } = await client
    .from('seats')
    .select('bot_ref')
    .in('bot_ref', bots.map((b) => b.id))
    .is('retired_at', null);
  if (takenError) throw new Error(`listFreeSeatBots failed: ${takenError.message}`);
  const busy = new Set((taken ?? []).map((s) => s.bot_ref));
  return bots.filter((b) => !busy.has(b.id));
}

// technician_id → bot handle for this firm's live glue seats (list_team).
export async function listSeatBotHandles(tenantId: string): Promise<Map<string, string>> {
  const { data, error } = await getClient()
    .from('seats')
    .select('technician_id, seat_bots(bot_username)')
    .eq('tenant_id', tenantId)
    .is('retired_at', null)
    .not('bot_ref', 'is', null);
  if (error) throw new Error(`listSeatBotHandles failed: ${error.message}`);
  const out = new Map<string, string>();
  for (const row of data ?? []) {
    if (row.seat_bots?.bot_username) out.set(row.technician_id, row.seat_bots.bot_username);
  }
  return out;
}

// The seat bots' half of the Mini App allowlist (src/telegram/botIds.ts unions
// it with the pool's listLiveBotIds). SCHEMA-BEHIND-CODE is a normal deploy order: until this table is
// migrated in, it contributes nothing — it must never throw the whole union and
// leave every assistant launch refused once the stale list ages out.
export async function listLiveSeatBotIds(): Promise<string[]> {
  const { data, error } = await getClient()
    .from('seat_bots')
    .select('bot_id')
    .not('bot_id', 'is', null)
    .is('retired_at', null);
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205') return [];
    throw new Error(`listLiveSeatBotIds failed: ${error.message}`);
  }
  return [...new Set((data ?? []).map((r) => r.bot_id).filter((id): id is string => !!id))];
}

// Live glue seat refs on a host that have NO live pool sandbox behind them. The
// badge file skips exactly these: a seat still backed by a pool sandbox (s5, and
// every seat step 5 installs before its cutover) keeps its badge, so rolling
// back to OpenClaw still reaches the spine.
export async function listPoollessSeatRefs(hostId: string): Promise<string[]> {
  const client = getClient();
  const { data: seats, error } = await client
    .from('seats')
    .select('seat_ref')
    .eq('host_id', hostId)
    .is('retired_at', null);
  if (error) throw new Error(`listPoollessSeatRefs failed: ${error.message}`);
  if (!seats?.length) return [];
  const { data: pool, error: poolError } = await client
    .from('sandbox_pool')
    .select('sandbox_ref')
    .eq('host_id', hostId)
    .is('retired_at', null);
  if (poolError) throw new Error(`listPoollessSeatRefs failed: ${poolError.message}`);
  const backed = new Set((pool ?? []).map((p) => p.sandbox_ref));
  return seats.map((s) => s.seat_ref).filter((ref) => !backed.has(ref));
}

// Register a bot the operator made with BotFather. The token never comes here.
export async function registerSeatBot(input: {
  hostId: string;
  tenantId: string | null;
  botId: string | null;
  botUsername: string;
}): Promise<SeatBot> {
  if (input.botId !== null && !/^[0-9]{1,20}$/.test(input.botId)) {
    throw new Error('registerSeatBot: botId must be the numeric id, not the token');
  }
  // A bot an OpenClaw pool sandbox still answers must never become a seat bot:
  // the next glue bind would put a second person on it (Telegram allows ONE
  // poller per bot). Checked by id and by handle — a pool row may have either.
  let owned = getClient()
    .from('sandbox_pool')
    .select('sandbox_ref')
    .is('retired_at', null)
    .eq('bot_username', input.botUsername);
  if (input.botId !== null) {
    owned = getClient()
      .from('sandbox_pool')
      .select('sandbox_ref')
      .is('retired_at', null)
      .or(`bot_id.eq.${input.botId},bot_username.eq.${input.botUsername}`);
  }
  const { data: pool, error: poolError } = await owned.limit(1);
  if (poolError) throw new Error(`registerSeatBot failed: ${poolError.message}`);
  if (pool?.length) {
    throw new Error(
      `registerSeatBot: ${input.botUsername} is pool sandbox ${pool[0].sandbox_ref}'s bot — a seat bot needs a bot of its own`,
    );
  }
  const { data, error } = await getClient()
    .from('seat_bots')
    .insert({
      host_id: input.hostId,
      tenant_id: input.tenantId,
      bot_id: input.botId,
      bot_username: input.botUsername,
    })
    .select()
    .single();
  if (error || !data) {
    throw Object.assign(
      new Error(`registerSeatBot failed: ${error?.message ?? 'no row returned'}`),
      { code: error?.code },
    );
  }
  return data;
}
