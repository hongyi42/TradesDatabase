#!/usr/bin/env node
// sandbox-token-medic — re-mint expired OpenShell sandbox tokens at boot.
//
// WHY (discovered 2026-07-05, trades-box-1 outage after a Lightsail reboot):
// the gateway mints each sandbox's JWT ONCE at create (gateway_jwt.ttl_secs),
// writes it to the host-side token file, and the running supervisor refreshes
// it IN MEMORY ONLY — the file is never rewritten. Any box reboot later than
// ttl_secs after sandbox creation brings the container up with an expired
// token it cannot refresh ("static token sources cannot rebootstrap
// automatically") and it crash-loops until a full `nemoclaw <agent> rebuild`.
// This script is the cheap fix: mint a fresh token from the gateway's own
// signing key (same claims, new iat/exp), write it back, restart the
// container. Runs as a oneshot systemd unit before nemoclaw-boot.
//
// COUPLING WARNING: mints the vendor's token format (EdDSA JWT; claims sub/
// iss/aud/iat/exp/sandbox_id — captured from a real gateway-minted token,
// OpenShell supervisor 0.0.71). If a vendor upgrade changes the format this
// medic's tokens will be REJECTED (policy fetch keeps failing) — fall back to
// `nemoclaw <agent> rebuild --yes` and re-capture the format.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const HOME = '/home/ubuntu';
const TOKENS_ROOT = `${HOME}/.local/state/openshell/docker-sandbox-tokens`;
const GW_STATE = `${HOME}/.local/state/nemoclaw/openshell-docker-gateway`;
// Overrides for manual runs: RENEW_AHEAD_SECS to force early re-mint,
// NO_RESTART=1 to heal the file without touching a (healthy) container.
const RENEW_AHEAD_SECS = Number(process.env.RENEW_AHEAD_SECS || 600);
const NO_RESTART = process.env.NO_RESTART === '1';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// TTL: single source of truth is the gateway config; fall back to 30 days.
let ttlSecs = 30 * 24 * 3600;
try {
  const toml = fs.readFileSync(`${GW_STATE}/openshell-gateway.toml`, 'utf8');
  const m = toml.match(/^\s*ttl_secs\s*=\s*(\d+)/m);
  if (m) ttlSecs = Number(m[1]);
} catch {
  /* keep fallback */
}

const signingKey = crypto.createPrivateKey(fs.readFileSync(`${GW_STATE}/jwt/signing.pem`));
const kid = fs.readFileSync(`${GW_STATE}/jwt/kid`, 'utf8').trim();

let checked = 0;
let minted = 0;
for (const pool of fs.readdirSync(TOKENS_ROOT)) {
  const poolDir = path.join(TOKENS_ROOT, pool);
  if (!fs.statSync(poolDir).isDirectory()) continue;
  for (const sandboxId of fs.readdirSync(poolDir)) {
    const tokenFile = path.join(poolDir, sandboxId, 'sandbox.jwt');
    if (!fs.existsSync(tokenFile)) continue;
    checked++;

    const old = fs.readFileSync(tokenFile, 'utf8').trim();
    let claims;
    try {
      claims = JSON.parse(Buffer.from(old.split('.')[1], 'base64url').toString());
    } catch (err) {
      console.error(`SKIP ${sandboxId}: unreadable token (${err.message})`);
      continue;
    }
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp && claims.exp > now + RENEW_AHEAD_SECS) {
      console.log(`ok   ${sandboxId}: valid until ${new Date(claims.exp * 1000).toISOString()}`);
      continue;
    }

    // Same claims the gateway minted, fresh window.
    const header = { typ: 'JWT', alg: 'EdDSA', kid };
    const payload = { ...claims, iat: now, exp: now + ttlSecs };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const sig = crypto.sign(null, Buffer.from(signingInput), signingKey);
    const jwt = `${signingInput}.${b64url(sig)}`;

    const { uid, gid, mode } = fs.statSync(tokenFile);
    fs.writeFileSync(tokenFile, jwt, { mode: mode & 0o777 });
    fs.chownSync(tokenFile, uid, gid);
    minted++;
    console.log(`MINT ${sandboxId}: expired ${claims.exp ? new Date(claims.exp * 1000).toISOString() : '(none)'} -> +${ttlSecs}s`);

    // Restart the sandbox's container so PID1 re-reads the healed file.
    if (NO_RESTART) {
      console.log(`     NO_RESTART set — file healed only (picked up on next container start)`);
      continue;
    }
    try {
      const cid = execFileSync('docker', ['ps', '-aq', '--filter', `name=${sandboxId}`], {
        encoding: 'utf8',
      }).trim();
      if (cid) {
        execFileSync('docker', ['restart', cid.split('\n')[0]], { stdio: 'inherit' });
        console.log(`     restarted container for ${sandboxId}`);
      } else {
        console.log(`     no container found for ${sandboxId} (token healed for next start)`);
      }
    } catch (err) {
      console.error(`     container restart failed for ${sandboxId}: ${err.message}`);
    }
  }
}
console.log(`token-medic: ${checked} checked, ${minted} re-minted`);
