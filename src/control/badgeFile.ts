import {
  claimBadgeHash,
  isInactiveState,
  listRetirementsForHost,
  listTechniciansForHost,
  type Technician,
} from '../db/index.js';
import { mintBadge } from './badges.js';

// One entry in the badges.json the host's doorman reads. Keys are badge
// FINGERPRINTS (sha256 hex) — the doorman hashes the presented badge before
// lookup, so the shipped file contains nothing that can authenticate.
export interface BadgeFileEntry {
  tenantId: string;
  technicianRef: string;
  revoked: boolean;
}

export interface BadgeResponse {
  // Verbatim /etc/doorman/badges.json content for this host.
  badgesFile: Record<string, BadgeFileEntry>;
  // Badges minted DURING this pull — the only moment the plaintext exists.
  // The host installs each as its sandbox's provider credential; the server
  // keeps only the hash. Lost before install → operator clears badge_hash
  // and the next pull re-mints.
  newBadges: Array<{ ref: string; tenantId: string; sandboxRef: string | null; badge: string }>;
  // Desired Telegram sender bindings for this host's sandboxes — one per active
  // row that has BOTH a sandbox and a bound Telegram id. The host reconciles
  // these into each sandbox's allowlist (additive; unbind is out of scope).
  // Independent of badge state: a binding ships even if this pull didn't mint.
  bindings: Array<{ ref: string; sandboxRef: string; telegramUserId: string }>;
  // Sandboxes the server wants destroyed + re-provisioned (a confirmed
  // deactivation marked them). Served on EVERY pull until the box reports
  // completion via POST /control/sandboxes — a lost tick self-heals. Old boxes
  // ignore the key (`.retirements // []` on the host).
  retirements: Array<{ sandboxRef: string }>;
  // What every seat bot on this host should be showing as its menu button.
  // Only the bot's OWN token can set it, and that token lives on the box — so
  // the server states the intent and the box applies it. Sent on every pull so
  // a change (a renamed label, a moved console) reaches the fleet on the next
  // tick instead of one SSH session per bot. null when BOARD_PUBLIC_URL is
  // unset: say nothing rather than point every bot at a guess. Old boxes ignore
  // the key, the same contract as `retirements`.
  menuButton: { text: string; url: string } | null;
}

// One label, one path, decided here rather than on twenty boxes.
const MENU_BUTTON_TEXT = 'Schedule';

function menuButtonFor(): BadgeResponse['menuButton'] {
  const base = process.env.BOARD_PUBLIC_URL;
  if (!base) return null;
  return { text: MENU_BUTTON_TEXT, url: `${base.replace(/\/+$/, '')}/console` };
}

// Build the pull response for one host: mint-on-first-pull for assigned rows
// that participate, revoked entries for inactive rows that once had a badge.
// Never-minted inactive rows are SKIPPED — they have no hash to key an entry
// with (a literal "null" key would be malformed) and nothing to revoke.
// Deps injectable so tests supply rows without touching the DB (sheetSync pattern).
export async function buildBadgeResponse(
  hostId: string,
  deps: {
    list?: typeof listTechniciansForHost;
    claim?: typeof claimBadgeHash;
    listRetirements?: typeof listRetirementsForHost;
  } = {},
): Promise<BadgeResponse> {
  const list = deps.list ?? listTechniciansForHost;
  const claim = deps.claim ?? claimBadgeHash;
  const listRetirements = deps.listRetirements ?? listRetirementsForHost;
  // Retirements are fetched BEFORE the mint loop: a throw here 500s the pull
  // while nothing has been minted yet (retried next tick, nothing lost). After
  // the loop it would kill the response carrying freshly minted plaintexts —
  // their badge_hash is already claimed, so they would never re-mint (the
  // delivered-once guarantee the per-row isolation below exists to protect).
  const retirements = (await listRetirements(hostId)).map((r) => ({
    sandboxRef: r.sandbox_ref,
  }));
  const rows = await list(hostId);
  const badgesFile: BadgeResponse['badgesFile'] = {};
  const newBadges: BadgeResponse['newBadges'] = [];
  const bindings: BadgeResponse['bindings'] = [];

  for (const row of rows) {
    // Bindings are independent of the badge flow below (which may `continue`
    // past a mint race/failure): an assigned, active, Telegram-bound row always
    // ships its desired binding. Inactive or unassigned rows ship nothing.
    if (row.sandbox_ref && row.telegram_user_id && !isInactiveState(row.state)) {
      bindings.push({
        ref: row.ref,
        sandboxRef: row.sandbox_ref,
        telegramUserId: row.telegram_user_id,
      });
    }
    let current: Technician = row;
    if (!current.badge_hash && !isInactiveState(current.state)) {
      // Per-row isolation: one row's failed write must not abort the pull —
      // earlier rows' plaintexts (the only copy) would die with the 500
      // (review finding). A skipped row simply mints on the next pull.
      try {
        const minted = mintBadge();
        // claim = write-if-still-null: two overlapping pulls can't each mint
        // and overwrite the other's hash, which would hand one installer a
        // dead credential (review finding). The loser ships nothing this
        // round and returns the winner's entry on its next pull.
        const claimed = await claim(current.id, minted.hash);
        if (!claimed) continue;
        current = claimed;
        newBadges.push({
          ref: current.ref,
          tenantId: current.tenant_id,
          sandboxRef: current.sandbox_ref,
          badge: minted.badge,
        });
      } catch {
        continue;
      }
    }
    if (!current.badge_hash) continue; // never-minted inactive row — nothing to ship
    badgesFile[current.badge_hash] = {
      tenantId: current.tenant_id,
      technicianRef: current.ref,
      revoked: isInactiveState(current.state),
    };
  }
  return { badgesFile, newBadges, bindings, retirements, menuButton: menuButtonFor() };
}
