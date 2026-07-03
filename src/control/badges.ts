import { createHash, randomBytes } from 'node:crypto';

// Badge minting for the control plane. A badge is a 256-bit bearer token the
// sandbox presents to the host doorman; ONLY its sha256 fingerprint is stored
// (technicians.badge_hash) and shipped in badges.json — the plaintext exists
// exactly once, in the pull response that mints it. The doorman hashes the
// presented badge before lookup, so nothing at rest can authenticate.

export function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface MintedBadge {
  badge: string; // plaintext — return to the caller once, never persist
  hash: string; // sha256 hex — the only stored/shipped representation
}

export function mintBadge(): MintedBadge {
  const badge = randomBytes(32).toString('hex');
  return { badge, hash: sha256hex(badge) };
}
