import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { mintBadge, sha256hex } from '../control/badges.js';
import { createHost, getHostByName, getHostByTokenHash } from './hosts.js';

// Integration against the TEST project (pattern: technicians.test.ts). Hosts
// are infrastructure rows (not spine data — seed's truncate leaves them alone),
// so this suite deletes exactly what it creates.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
const HOST_NAME = 'test-host-probe';

beforeAll(async () => {
  await pg.connect();
  await pg.query('delete from hosts where name = $1', [HOST_NAME]);
});

afterAll(async () => {
  await pg.query('delete from hosts where name = $1', [HOST_NAME]);
  await pg.end();
});

describe('hosts registry', () => {
  test('create + lookup by token fingerprint; plaintext token never stored', async () => {
    const token = mintBadge(); // same 256-bit shape as badges
    const host = await createHost(HOST_NAME, token.hash);
    expect(host.token_hash).toBe(token.hash);

    // The pull endpoint's exact path: hash the presented bearer, point-read.
    expect((await getHostByTokenHash(sha256hex(token.badge)))?.id).toBe(host.id);
    expect(await getHostByTokenHash(sha256hex('wrong-token'))).toBeNull();
    expect((await getHostByName(HOST_NAME))?.id).toBe(host.id);

    // No column holds the plaintext: the stored fingerprint differs from it.
    expect(host.token_hash).not.toBe(token.badge);
  });

  test('host names are unique', async () => {
    await expect(createHost(HOST_NAME, sha256hex('another'))).rejects.toThrow(/createHost failed/);
  });
});

describe('badge minting', () => {
  test('mintBadge: 64-hex badge, hash = sha256(badge), unique per call', () => {
    const a = mintBadge();
    const b = mintBadge();
    expect(a.badge).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).toBe(sha256hex(a.badge));
    expect(a.badge).not.toBe(b.badge);
    expect(a.hash).not.toBe(b.hash);
  });
});
