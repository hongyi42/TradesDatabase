import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { createHttpServer } from '../mcp/httpServer.js';
import { getClient } from '../db/client.js';
import { createTenant, setTenantSeats } from '../db/tenants.js';
import { insertTechnician } from '../db/technicians.js';
import { inviteAccount } from '../db/portalAccounts.js';
import { setMailer, type Mailer } from './auth.js';

// Integration: the real /portal/api/* routes over real HTTP on an ephemeral
// port (pattern: httpServer.test.ts). These assert the HTTP contract — status
// codes, cookies, and above all that an unauthenticated or wrong-tenant caller
// gets nothing.
//
// Plan: thoughts/shared/plans/2026-08-12-portal-real-data.md (Phase 2).

const pg = new Client({ connectionString: process.env.DATABASE_URL });
let server: http.Server;
let base: string;
let tenantA: string;
let tenantB: string;
const sent: Array<{ to: string; url: string }> = [];
const fakeMailer: Mailer = { sendMagicLink: async (p) => void sent.push(p) };

/** Sign in end-to-end and return the raw Cookie header a browser would send. */
async function signIn(email: string): Promise<string> {
  sent.length = 0;
  const r = await fetch(`${base}/portal/api/auth/request-link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  expect(r.status).toBe(204);
  expect(sent).toHaveLength(1);
  // Follow the emailed link exactly as a browser would, without auto-redirect.
  const cb = await fetch(sent[0].url, { redirect: 'manual' });
  expect(cb.status).toBe(303);
  const setCookie = cb.headers.get('set-cookie');
  if (!setCookie) throw new Error('no session cookie issued');
  return setCookie.split(';')[0];
}

beforeAll(async () => {
  await pg.connect();
  await pg.query('truncate table portal_sessions, portal_accounts cascade');
  await pg.query('truncate table technicians cascade');

  const { data } = await getClient().from('tenants').select('id').eq('name', 'Default Tenant').single();
  tenantA = data!.id;
  // Other suites leave the seed tenant's caps at whatever they needed, and the
  // enforce_seat_cap trigger refuses an insert over the cap — so set them here
  // rather than inheriting a number that makes this suite fail for an unrelated
  // reason.
  await setTenantSeats(tenantA, { managerSeats: 2, technicianSeats: 2 });
  tenantB = (await createTenant(`portalapi-b-${randomBytes(4).toString('hex')}`, {
    managerSeats: 2,
    technicianSeats: 2,
  })).id;

  await inviteAccount({ tenantId: tenantA, email: 'ray@harrowbros.co.uk' });
  await inviteAccount({ tenantId: tenantB, email: 'bravo@example.com' });

  await insertTechnician({ tenantId: tenantA, ref: 'a-pete', displayName: 'Pete Rowan' });
  await insertTechnician({ tenantId: tenantB, ref: 'b-secret', displayName: 'Bravo Secret' });

  // The magic link points at whatever origin the request carries, so the
  // callback URL resolves back to this ephemeral server.
  setMailer(fakeMailer);
  process.env.PORTAL_INSECURE_COOKIES = '1';

  server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.PORTAL_PUBLIC_ORIGIN = base;
});

afterAll(async () => {
  setMailer(null);
  delete process.env.PORTAL_PUBLIC_ORIGIN;
  delete process.env.PORTAL_INSECURE_COOKIES;
  // Guarded: if beforeAll threw, `server` is undefined and an unguarded
  // close() here would mask the real failure with a TypeError.
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pg.query('truncate table portal_sessions cascade');
  await pg.end();
});

describe('unauthenticated access', () => {
  test('every data endpoint is 401 without a session', async () => {
    for (const path of ['/portal/api/me', '/portal/api/summary', '/portal/api/seats', '/portal/api/seats/a-pete']) {
      const r = await fetch(`${base}${path}`);
      expect(r.status, path).toBe(401);
      expect(await r.json()).toEqual({ error: 'unauthenticated' });
    }
  });

  test('a forged or junk cookie is 401, not a 500', async () => {
    for (const cookie of ['td_portal_session=' + 'f'.repeat(64), 'td_portal_session=nonsense', 'td_portal_session=']) {
      const r = await fetch(`${base}/portal/api/summary`, { headers: { cookie } });
      expect(r.status).toBe(401);
    }
  });

  test('JSON bodies are never cached', async () => {
    const r = await fetch(`${base}/portal/api/summary`);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });
});

describe('sign-in over HTTP', () => {
  test('request-link answers 204 for an invited AND an uninvited address', async () => {
    sent.length = 0;
    const known = await fetch(`${base}/portal/api/auth/request-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ray@harrowbros.co.uk' }),
    });
    const unknown = await fetch(`${base}/portal/api/auth/request-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'stranger@nowhere.test' }),
    });
    // Identical status AND identical (empty) body — the whole point.
    expect(known.status).toBe(204);
    expect(unknown.status).toBe(204);
    expect(await known.text()).toBe(await unknown.text());
    // Only the invited address produced mail.
    expect(sent.map((s) => s.to)).toEqual(['ray@harrowbros.co.uk']);
  });

  test('a malformed body is still 204 and leaks nothing', async () => {
    const r = await fetch(`${base}/portal/api/auth/request-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(r.status).toBe(204);
  });

  test('GET on request-link is 405', async () => {
    expect((await fetch(`${base}/portal/api/auth/request-link`)).status).toBe(405);
  });

  test('the callback sets an HttpOnly, SameSite=Lax, path-scoped cookie', async () => {
    sent.length = 0;
    await fetch(`${base}/portal/api/auth/request-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ray@harrowbros.co.uk' }),
    });
    const cb = await fetch(sent[0].url, { redirect: 'manual' });
    expect(cb.status).toBe(303);
    expect(cb.headers.get('location')).toBe('/portal');
    const cookie = cb.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/portal/i);
  });

  test('an invalid token redirects to the signed-out page and sets no cookie', async () => {
    const r = await fetch(`${base}/portal/api/auth/callback?token=${'f'.repeat(64)}`, {
      redirect: 'manual',
    });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/portal?signin=invalid');
    expect(r.headers.get('set-cookie')).toBeNull();
  });
});

describe('authenticated reads are scoped to the session tenant', () => {
  test('/me returns the signed-in identity and NOT the tenant id', async () => {
    const cookie = await signIn('ray@harrowbros.co.uk');
    const r = await fetch(`${base}/portal/api/me`, { headers: { cookie } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({ email: 'ray@harrowbros.co.uk', role: 'owner' });
    // The client never needs it, and shipping it would invite a future handler
    // to accept it back as a parameter.
    expect(body).not.toHaveProperty('tenantId');
  });

  test('/seats returns only the session tenant roster', async () => {
    const cookie = await signIn('ray@harrowbros.co.uk');
    const r = await fetch(`${base}/portal/api/seats`, { headers: { cookie } });
    const body = await r.json();
    expect(body.seats.map((s: { ref: string }) => s.ref)).toEqual(['a-pete']);
    expect(JSON.stringify(body)).not.toContain('Bravo Secret');
  });

  test("another tenant's seat ref is 404, indistinguishable from missing", async () => {
    const cookie = await signIn('ray@harrowbros.co.uk');
    const real = await fetch(`${base}/portal/api/seats/b-secret`, { headers: { cookie } });
    const absent = await fetch(`${base}/portal/api/seats/does-not-exist`, { headers: { cookie } });
    expect(real.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(await real.json()).toEqual(await absent.json());
  });

  test('two sessions see two different rosters', async () => {
    const a = await signIn('ray@harrowbros.co.uk');
    const b = await signIn('bravo@example.com');
    const seatsA = await (await fetch(`${base}/portal/api/seats`, { headers: { cookie: a } })).json();
    const seatsB = await (await fetch(`${base}/portal/api/seats`, { headers: { cookie: b } })).json();
    expect(seatsA.seats.map((s: { ref: string }) => s.ref)).toEqual(['a-pete']);
    expect(seatsB.seats.map((s: { ref: string }) => s.ref)).toEqual(['b-secret']);
  });

  test('/summary counts only the session tenant', async () => {
    const cookie = await signIn('ray@harrowbros.co.uk');
    const s = await (await fetch(`${base}/portal/api/summary`, { headers: { cookie } })).json();
    expect(s.tenantId).toBe(tenantA);
    expect(s.technician.used).toBe(1);
  });
});

describe('sign-out', () => {
  test('revokes the session so the same cookie stops working', async () => {
    const cookie = await signIn('ray@harrowbros.co.uk');
    expect((await fetch(`${base}/portal/api/me`, { headers: { cookie } })).status).toBe(200);
    const out = await fetch(`${base}/portal/api/auth/signout`, { method: 'POST', headers: { cookie } });
    expect(out.status).toBe(204);
    expect((await fetch(`${base}/portal/api/me`, { headers: { cookie } })).status).toBe(401);
  });

  test('signing out without a session is still 204', async () => {
    expect((await fetch(`${base}/portal/api/auth/signout`, { method: 'POST' })).status).toBe(204);
  });
});

describe('unknown api routes', () => {
  test('are 404 once authenticated, not a crash', async () => {
    const cookie = await signIn('ray@harrowbros.co.uk');
    const r = await fetch(`${base}/portal/api/nope`, { headers: { cookie } });
    expect(r.status).toBe(404);
  });
});
