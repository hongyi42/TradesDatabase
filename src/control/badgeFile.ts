import {
  isInactiveState,
  listTechniciansForHost,
  updateTechnician,
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
    update?: typeof updateTechnician;
  } = {},
): Promise<BadgeResponse> {
  const list = deps.list ?? listTechniciansForHost;
  const update = deps.update ?? updateTechnician;
  const rows = await list(hostId);
  const badgesFile: BadgeResponse['badgesFile'] = {};
  const newBadges: BadgeResponse['newBadges'] = [];

  for (const row of rows) {
    let current: Technician = row;
    if (!current.badge_hash && !isInactiveState(current.state)) {
      const minted = mintBadge();
      current = await update(current.id, { badge_hash: minted.hash });
      newBadges.push({
        ref: current.ref,
        tenantId: current.tenant_id,
        sandboxRef: current.sandbox_ref,
        badge: minted.badge,
      });
    }
    if (!current.badge_hash) continue; // never-minted inactive row — nothing to ship
    badgesFile[current.badge_hash] = {
      tenantId: current.tenant_id,
      technicianRef: current.ref,
      revoked: isInactiveState(current.state),
    };
  }
  return { badgesFile, newBadges };
}
