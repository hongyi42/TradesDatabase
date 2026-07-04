import { describe, expect, it } from 'vitest';
import { assertLocalTestEnv, isLocalDbUrl } from './testEnvGuard.js';

const LOCAL = {
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test_key',
};

describe('isLocalDbUrl', () => {
  it('accepts 127.0.0.1 and localhost hosts', () => {
    expect(isLocalDbUrl(LOCAL.DATABASE_URL)).toBe(true);
    expect(isLocalDbUrl('http://localhost:54321')).toBe(true);
    expect(isLocalDbUrl('postgresql://postgres:postgres@localhost:54322/postgres')).toBe(true);
  });

  it('rejects hosted URLs', () => {
    expect(isLocalDbUrl('https://daqapdlkgxfrhquacprv.supabase.co')).toBe(false);
    expect(isLocalDbUrl('postgresql://postgres:x@db.example.supabase.co:5432/postgres')).toBe(false);
  });

  it('is host-based, not substring-based', () => {
    // username literally "localhost" pointing at a hosted DB — the finder-flagged hole
    expect(isLocalDbUrl('postgresql://localhost:pw@db.example.supabase.co:5432/postgres')).toBe(
      false,
    );
    // "localhost"/"127.0.0.1" in password, path, or query must not count
    expect(isLocalDbUrl('postgresql://user:localhostpw@db.example.com:5432/postgres')).toBe(false);
    expect(isLocalDbUrl('https://evil.example.com/127.0.0.1/')).toBe(false);
    expect(isLocalDbUrl('https://evil.example.com/?redirect=localhost:80')).toBe(false);
  });

  it('fails closed on unparseable or empty input', () => {
    expect(isLocalDbUrl('')).toBe(false);
    expect(isLocalDbUrl('not a url')).toBe(false);
  });
});

describe('assertLocalTestEnv', () => {
  it('accepts the local stack env', () => {
    expect(() => assertLocalTestEnv(LOCAL)).not.toThrow();
  });

  it('rejects the hosted test project ref and names the offending var', () => {
    expect(() =>
      assertLocalTestEnv({ ...LOCAL, SUPABASE_URL: 'https://daqapdlkgxfrhquacprv.supabase.co' }),
    ).toThrow(/SUPABASE_URL/);
    expect(() =>
      assertLocalTestEnv({
        ...LOCAL,
        DATABASE_URL: 'postgresql://postgres:x@db.example.supabase.co:5432/postgres',
      }),
    ).toThrow(/DATABASE_URL/);
  });

  it('rejects a missing/empty URL var', () => {
    expect(() => assertLocalTestEnv({ ...LOCAL, DATABASE_URL: undefined })).toThrow(
      /DATABASE_URL/,
    );
    expect(() => assertLocalTestEnv({ ...LOCAL, SUPABASE_URL: '' })).toThrow(/SUPABASE_URL/);
  });

  it('rejects an empty service-role key (the copied-but-unfilled .env.test case)', () => {
    expect(() => assertLocalTestEnv({ ...LOCAL, SUPABASE_SERVICE_ROLE_KEY: '' })).toThrow(
      /SUPABASE_SERVICE_ROLE_KEY/,
    );
    expect(() => assertLocalTestEnv({ ...LOCAL, SUPABASE_SERVICE_ROLE_KEY: undefined })).toThrow(
      /SUPABASE_SERVICE_ROLE_KEY/,
    );
  });
});
