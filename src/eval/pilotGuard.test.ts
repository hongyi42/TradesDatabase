import { describe, expect, it } from 'vitest';
import {
  assertEvalTenant,
  assertTruncationAllowed,
  assessPilotTarget,
  EVAL_CAPTURE_MARKER,
  EVAL_COMPOSIO_SENTINEL,
  EVAL_TENANT_PREFIX,
  evalTenantName,
  isEvalTenantName,
  PILOT_REF,
} from './pilotGuard.js';
import { assessTarget } from './targetGuard.js';

const LOCAL_DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const LOCAL_SUPA = 'http://127.0.0.1:54321';
const PILOT_DB = `postgresql://postgres:pw@db.${PILOT_REF}.supabase.co:5432/postgres`;
const PILOT_SUPA = `https://${PILOT_REF}.supabase.co`;
const YES = { confirmed: true };

describe('assessPilotTarget', () => {
  it('accepts the pilot when both URLs name it AND the caller confirmed', () => {
    const v = assessPilotTarget(PILOT_DB, PILOT_SUPA, YES);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.ref).toBe(PILOT_REF);
    expect(v.host).toBe(`${PILOT_REF}.supabase.co`);
  });

  it('refuses without the explicit confirmation, however right the URLs are', () => {
    // The whole point of the double opt-in: a correctly configured environment
    // must still not be enough on its own.
    const v = assessPilotTarget(PILOT_DB, PILOT_SUPA, { confirmed: false });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toMatch(/--pilot --yes/);
  });

  it('refuses the LOCAL stack — a tier-3 run must never silently be a tier-2 run', () => {
    // This is the failure that would look like a result: gateway numbers from a
    // run that never reached the gateway.
    const v = assessPilotTarget(LOCAL_DB, LOCAL_SUPA, YES);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toMatch(/LOCAL/);
  });

  it('refuses a HALF-retargeted environment in either direction', () => {
    expect(assessPilotTarget(LOCAL_DB, PILOT_SUPA, YES).ok).toBe(false);
    expect(assessPilotTarget(PILOT_DB, LOCAL_SUPA, YES).ok).toBe(false);
  });

  it('refuses some OTHER remote project, even a plausible one', () => {
    const other = 'abcdefghijklmnopqrst';
    expect(assessPilotTarget(`postgresql://u:p@db.${other}.supabase.co:5432/postgres`, `https://${other}.supabase.co`, YES).ok).toBe(false);
    // One leg right, one leg elsewhere.
    expect(assessPilotTarget(PILOT_DB, `https://${other}.supabase.co`, YES).ok).toBe(false);
  });

  it('fails CLOSED on missing or malformed input', () => {
    for (const [db, supa] of [
      ['', ''],
      [PILOT_DB, ''],
      ['', PILOT_SUPA],
      ['not-a-url', 'also-not-a-url'],
    ]) {
      expect(assessPilotTarget(db, supa, YES).ok, `db='${db}' supa='${supa}'`).toBe(false);
    }
  });

  it('reports which leg failed', () => {
    const v = assessPilotTarget(PILOT_DB, `https://elsewhere.supabase.co`, YES);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.detail).toMatch(/DATABASE_URL names it: true/);
    expect(v.detail).toMatch(/SUPABASE_URL names it: false/);
  });
});

describe('the two guards are mirror images, and neither can do the other job', () => {
  // The safety property that justifies pilotGuard.ts being a separate file at
  // all: for any given environment, at most one of the two guards says yes. If a
  // future refactor merges them behind a flag, this test is what breaks.
  it('never both accept the same environment', () => {
    const envs: [string, string][] = [
      [LOCAL_DB, LOCAL_SUPA],
      [PILOT_DB, PILOT_SUPA],
      [LOCAL_DB, PILOT_SUPA],
      [PILOT_DB, LOCAL_SUPA],
      ['', ''],
    ];
    for (const [db, supa] of envs) {
      const local = assessTarget(db, supa).ok;
      const pilot = assessPilotTarget(db, supa, YES).ok;
      expect(local && pilot, `both accepted db='${db}' supa='${supa}'`).toBe(false);
    }
  });

  it('the local guard accepts local and the pilot guard accepts the pilot', () => {
    expect(assessTarget(LOCAL_DB, LOCAL_SUPA).ok).toBe(true);
    expect(assessPilotTarget(PILOT_DB, PILOT_SUPA, YES).ok).toBe(true);
    // ...and each refuses the other's target.
    expect(assessTarget(PILOT_DB, PILOT_SUPA).ok).toBe(false);
    expect(assessPilotTarget(LOCAL_DB, LOCAL_SUPA, YES).ok).toBe(false);
  });
});

describe('assertTruncationAllowed', () => {
  it('permits truncation locally', () => {
    expect(() => assertTruncationAllowed('local')).not.toThrow();
  });

  it('THROWS in pilot mode, and names the incident', () => {
    // Not a boolean: a forgotten boolean check truncates the pilot.
    expect(() => assertTruncationAllowed('pilot')).toThrow(/REFUSING/);
    expect(() => assertTruncationAllowed('pilot')).toThrow(/2026-07-03/);
  });
});

describe('eval tenant naming', () => {
  it('recognises only prefixed names', () => {
    expect(isEvalTenantName(`${EVAL_TENANT_PREFIX}-gateway`)).toBe(true);
    expect(isEvalTenantName('acme-plumbing')).toBe(false);
    // The prefix alone is not a tenant — the hyphen and a suffix are required, so
    // a bare prefix cannot be written to by accident.
    expect(isEvalTenantName(EVAL_TENANT_PREFIX)).toBe(false);
    // A name that merely CONTAINS the prefix is not prefixed BY it.
    expect(isEvalTenantName(`acme-${EVAL_TENANT_PREFIX}-gateway`)).toBe(false);
  });

  it('fails closed on absent names', () => {
    expect(isEvalTenantName(undefined)).toBe(false);
    expect(isEvalTenantName(null)).toBe(false);
    expect(isEvalTenantName('')).toBe(false);
  });

  it('assertEvalTenant names what it refused', () => {
    expect(() => assertEvalTenant(`${EVAL_TENANT_PREFIX}-gateway`)).not.toThrow();
    expect(() => assertEvalTenant('acme-plumbing')).toThrow(/'acme-plumbing'/);
    expect(() => assertEvalTenant(undefined)).toThrow(/undefined/);
    expect(() => assertEvalTenant(null)).toThrow(/null/);
  });

  it('evalTenantName produces a guard-passing name from arbitrary input', () => {
    // The round trip is the property that matters: anything this mints must be
    // something the guard then accepts.
    for (const suffix of ['gateway', 'Gateway Run', 'hooks/3a', '  spaces  ', 'a--b']) {
      const name = evalTenantName(suffix);
      expect(isEvalTenantName(name), `suffix='${suffix}' -> '${name}'`).toBe(true);
      expect(name).toMatch(/^[a-z0-9-]+$/);
    }
    expect(evalTenantName('Gateway Run')).toBe(`${EVAL_TENANT_PREFIX}-gateway-run`);
  });

  it('refuses a suffix that reduces to nothing', () => {
    // '///' would otherwise mint the bare prefix, which the guard rejects — better
    // to fail at the mint than to produce a name that cannot be used.
    for (const bad of ['', '   ', '///', '---']) {
      expect(() => evalTenantName(bad), `suffix='${bad}'`).toThrow(/non-empty/);
    }
  });
});

describe('L1 capture marker', () => {
  it('is a stable, findable string', () => {
    // raw_captures has no delete path, so this value is effectively permanent
    // once a run has happened: changing it later strands the earlier rows under a
    // marker nothing searches for. Pinned deliberately.
    expect(EVAL_CAPTURE_MARKER).toBe('spineEvalTier3');
  });
});

describe('Composio session sentinel', () => {
  it('is obviously not a real session id', () => {
    // The pilot's lifecycle cron mints a Composio session for every ACTIVE
    // technician; eval people must be active, so this sentinel pre-claims the
    // slot and makes the sweep a no-op. It must NOT look like a real id — anything
    // that tried to use it should fail loudly rather than half-work against the
    // production Composio account.
    expect(EVAL_COMPOSIO_SENTINEL).toBe('eval-no-composio-session');
    expect(EVAL_COMPOSIO_SENTINEL).toMatch(/eval/);
    // Composio ids are opaque tokens; a value with spaces or an obvious English
    // phrase can never collide with one.
    expect(EVAL_COMPOSIO_SENTINEL).toMatch(/-/);
  });
});
