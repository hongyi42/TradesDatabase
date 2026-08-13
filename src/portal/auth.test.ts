import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { getClient } from '../db/client.js';
import { createTenant } from '../db/tenants.js';
import { inviteAccount } from '../db/portalAccounts.js';
import {
  hashToken,
  mintToken,
  needsRenewal,
  purgeExpiredSessions,
  resolveSession,
  revokeAllForAccount,
  SESSION_TTL_MS,
} from '../db/portalSessions.js';
import {
  completeMagicLink,
  currentSession,
  readSessionCookie,
  requestMagicLink,
  setMailer,
  signOut,
  type Mailer,
} from './auth.js';

// Integration against the LOCAL stack. Everything here is a security property,
// so it is asserted directly rather than inferred from the happy path.
//
// Plan: thoughts/shared/plans/2026-08-12-portal-real-data.md (D1, D3a).

const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantA: string;
let tenantB: string;
let accountA: string;
const sent: Array<{ to: string; url: string }> = [];

const fakeMailer: Mailer = {
  sendMagicLink: async (p) => {
    sent.push(p);
  },
};

/** Minimal stand-in for an http.IncomingMessage carrying a cookie. */
function reqWithCookie(token: string | null): Parameters<typeof currentSession>[0] {
  return {
    headers: token ? { cookie: `td_portal_session=${encodeURIComponent(token)}` } : {},
  } as Parameters<typeof currentSession>[0];
}

/** Pull the token out of the emailed callback URL, as a real browser would. */
function tokenFromUrl(url: string): string {
  return new URL(url).searchParams.get('token') ?? '';
}

beforeAll(async () => {
  await pg.connect();
  await pg.query('truncate table portal_sessions, portal_accounts cascade');
  const { data } = await getClient().from('tenants').select('id').eq('name', 'Default Tenant').single();
  tenantA = data!.id;
  tenantB = (await createTenant(`auth-other-${randomBytes(4).toString('hex')}`)).id;
  accountA = (await inviteAccount({ tenantId: tenantA, email: 'ray@harrowbros.co.uk' })).accountId;
  await inviteAccount({ tenantId: tenantB, email: 'bravo@example.com' });
});

afterEach(() => {
  sent.length = 0;
  setMailer(null);
});

afterAll(async () => {
  await pg.query('truncate table portal_sessions cascade');
  await pg.end();
});

describe('request-link: account enumeration resistance', () => {
  test('an invited address is sent a link', async () => {
    setMailer(fakeMailer);
    const r = await requestMagicLink({ email: 'ray@harrowbros.co.uk', origin: 'https://x.test' });
    expect(r).toEqual({ ok: true, sent: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('ray@harrowbros.co.uk');
    expect(sent[0].url).toMatch(/^https:\/\/x\.test\/portal\/api\/auth\/callback\?token=/);
  });

  test('an UNINVITED address gets the same result shape and NO mail', async () => {
    setMailer(fakeMailer);
    const r = await requestMagicLink({ email: 'stranger@example.com', origin: 'https://x.test' });
    // Same `ok: true` as the invited case — the caller answers 204 either way, so
    // an outsider cannot ask "is this firm your customer?".
    expect(r.ok).toBe(true);
    expect(sent).toHaveLength(0);
  });

  test('casing does not change the outcome', async () => {
    setMailer(fakeMailer);
    const r = await requestMagicLink({ email: 'RAY@HarrowBros.co.uk', origin: 'https://x.test' });
    expect(r).toEqual({ ok: true, sent: true });
  });

  test('no mailer configured fails CLOSED with 503, never silently', async () => {
    setMailer(null);
    const r = await requestMagicLink({ email: 'ray@harrowbros.co.uk', origin: 'https://x.test' });
    expect(r).toEqual({ ok: false, code: 503 });
  });

  test('an uninvited address never creates a Supabase auth user', async () => {
    setMailer(fakeMailer);
    await requestMagicLink({ email: 'never-a-user@example.com', origin: 'https://x.test' });
    // generateLink CREATES an auth user as a side effect, so gating on our own
    // table first is what stops an outsider minting users for arbitrary addresses.
    const { rows } = await pg.query(`select id from auth.users where email = $1`, [
      'never-a-user@example.com',
    ]);
    expect(rows).toHaveLength(0);
  });
});

describe('callback: redeeming a link', () => {
  test('a valid link signs the invited account in', async () => {
    setMailer(fakeMailer);
    await requestMagicLink({ email: 'ray@harrowbros.co.uk', origin: 'https://x.test' });
    const result = await completeMagicLink({ token: tokenFromUrl(sent[0].url) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const owner = await resolveSession(result.token);
    expect(owner?.tenantId).toBe(tenantA);
    expect(owner?.email).toBe('ray@harrowbros.co.uk');
    expect(owner?.role).toBe('owner');
    // 30 days, sliding (owner decision 2026-08-12).
    const ttl = new Date(owner!.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(SESSION_TTL_MS - 60_000);
  });

  test('the magic link is SINGLE USE — a replay is refused', async () => {
    setMailer(fakeMailer);
    await requestMagicLink({ email: 'ray@harrowbros.co.uk', origin: 'https://x.test' });
    const token = tokenFromUrl(sent[0].url);
    expect((await completeMagicLink({ token })).ok).toBe(true);
    expect(await completeMagicLink({ token })).toEqual({ ok: false, reason: 'invalid' });
  });

  test('forged and malformed tokens are refused identically', async () => {
    for (const token of ['', 'x', 'f'.repeat(64), '../../etc/passwd', 'zz'.repeat(32)]) {
      expect(await completeMagicLink({ token })).toEqual({ ok: false, reason: 'invalid' });
    }
  });

  test('an account revoked between request and redemption cannot complete', async () => {
    setMailer(fakeMailer);
    const acct = await inviteAccount({ tenantId: tenantB, email: 'transient@example.com' });
    await requestMagicLink({ email: 'transient@example.com', origin: 'https://x.test' });
    const token = tokenFromUrl(sent[0].url);
    // They lose access while the mail is in flight.
    await pg.query('delete from portal_accounts where id = $1', [acct.accountId]);
    expect(await completeMagicLink({ token })).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('sessions', () => {
  async function signIn(email: string): Promise<string> {
    setMailer(fakeMailer);
    sent.length = 0;
    await requestMagicLink({ email, origin: 'https://x.test' });
    const r = await completeMagicLink({ token: tokenFromUrl(sent[0].url) });
    if (!r.ok) throw new Error('sign-in failed');
    return r.token;
  }

  test('the plaintext token is never stored — only its sha256', async () => {
    const token = await signIn('ray@harrowbros.co.uk');
    const { rows } = await pg.query<{ token_hash: string }>(
      'select token_hash from portal_sessions order by created_at desc limit 1',
    );
    expect(rows[0].token_hash).toBe(hashToken(token));
    expect(rows[0].token_hash).not.toBe(token);
    // Nothing anywhere in the row may equal the token itself.
    const { rows: all } = await pg.query('select * from portal_sessions');
    expect(JSON.stringify(all)).not.toContain(token);
  });

  test('an unknown, malformed, or empty token resolves to null', async () => {
    expect(await resolveSession('')).toBeNull();
    expect(await resolveSession('not-hex')).toBeNull();
    expect(await resolveSession(mintToken())).toBeNull();
  });

  test('a revoked session stops working immediately', async () => {
    const token = await signIn('ray@harrowbros.co.uk');
    expect(await resolveSession(token)).not.toBeNull();
    await signOut(reqWithCookie(token));
    expect(await resolveSession(token)).toBeNull();
  });

  test('an expired session is refused even though the row still exists', async () => {
    const token = await signIn('ray@harrowbros.co.uk');
    await pg.query(
      `update portal_sessions set expires_at = now() - interval '1 minute'
        where token_hash = $1`,
      [hashToken(token)],
    );
    expect(await resolveSession(token)).toBeNull();
  });

  test('revokeAllForAccount kills every live session (lost-device lever)', async () => {
    const t1 = await signIn('ray@harrowbros.co.uk');
    const t2 = await signIn('ray@harrowbros.co.uk');
    expect(await resolveSession(t1)).not.toBeNull();
    expect(await resolveSession(t2)).not.toBeNull();
    const killed = await revokeAllForAccount(accountA);
    expect(killed).toBeGreaterThanOrEqual(2);
    expect(await resolveSession(t1)).toBeNull();
    expect(await resolveSession(t2)).toBeNull();
  });

  test('currentSession reads the cookie and returns the owner', async () => {
    const token = await signIn('ray@harrowbros.co.uk');
    const owner = await currentSession(reqWithCookie(token));
    expect(owner?.tenantId).toBe(tenantA);
    expect(await currentSession(reqWithCookie(null))).toBeNull();
  });

  test('two accounts get sessions scoped to their own tenant', async () => {
    const a = await signIn('ray@harrowbros.co.uk');
    const b = await signIn('bravo@example.com');
    expect((await resolveSession(a))?.tenantId).toBe(tenantA);
    expect((await resolveSession(b))?.tenantId).toBe(tenantB);
    expect((await resolveSession(a))?.tenantId).not.toBe((await resolveSession(b))?.tenantId);
  });

  test('renewal is throttled rather than a write per request', () => {
    expect(needsRenewal(new Date().toISOString())).toBe(false);
    expect(needsRenewal(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())).toBe(true);
  });

  test('purge removes long-expired rows only', async () => {
    const token = await signIn('ray@harrowbros.co.uk');
    await pg.query(
      `update portal_sessions set expires_at = now() - interval '60 days' where token_hash = $1`,
      [hashToken(token)],
    );
    const live = await signIn('ray@harrowbros.co.uk');
    const purged = await purgeExpiredSessions(30);
    expect(purged).toBeGreaterThanOrEqual(1);
    // The live one survives.
    expect(await resolveSession(live)).not.toBeNull();
  });
});

describe('the shared data client must never be downgraded by a sign-in', () => {
  // REGRESSION GUARD for a real bug found 2026-08-12. `verifyOtp` sets the
  // session on whatever client instance it is called on. Calling it on the
  // process-wide client from src/db/client.ts made every LATER query in the
  // whole server run as the customer who signed in most recently, instead of
  // service_role. It surfaced only because portal_accounts revokes
  // `authenticated`; on technicians/customers/tenants the downgraded client
  // still returns rows, so nothing would have looked wrong.
  test('service_role access still works after a completed sign-in', async () => {
    setMailer(fakeMailer);
    sent.length = 0;
    await requestMagicLink({ email: 'ray@harrowbros.co.uk', origin: 'https://x.test' });
    const r = await completeMagicLink({ token: tokenFromUrl(sent[0].url) });
    expect(r.ok).toBe(true);

    // The shared client must be untouched — this read is denied to
    // `authenticated` and allowed to `service_role`, so it fails loudly if the
    // singleton was downgraded.
    const { error } = await getClient().from('portal_accounts').select('id').limit(1);
    expect(error).toBeNull();
  });

  test('a sign-in does not leave a session on the shared client', async () => {
    setMailer(fakeMailer);
    sent.length = 0;
    await requestMagicLink({ email: 'bravo@example.com', origin: 'https://x.test' });
    await completeMagicLink({ token: tokenFromUrl(sent[0].url) });
    const { data } = await getClient().auth.getSession();
    expect(data.session).toBeNull();
  });
});

describe('cookie parsing', () => {
  test('reads the session cookie out of a crowded header', () => {
    const req = {
      headers: { cookie: 'other=1; td_portal_session=abc123; another=2' },
    } as Parameters<typeof readSessionCookie>[0];
    expect(readSessionCookie(req)).toBe('abc123');
  });

  test('returns null when absent, and is not fooled by a similar name', () => {
    expect(readSessionCookie({ headers: {} } as Parameters<typeof readSessionCookie>[0])).toBeNull();
    const decoy = {
      headers: { cookie: 'xtd_portal_session=nope; td_portal_session_other=nope2' },
    } as Parameters<typeof readSessionCookie>[0];
    expect(readSessionCookie(decoy)).toBeNull();
  });
});
