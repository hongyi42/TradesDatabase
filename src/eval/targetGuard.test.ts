import { describe, expect, it } from 'vitest';
import { assessTarget, PILOT_REF } from './targetGuard.js';

const LOCAL_DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const LOCAL_SUPA = 'http://127.0.0.1:54321';
const PILOT_DB = `postgresql://postgres:pw@db.${PILOT_REF}.supabase.co:5432/postgres`;
const PILOT_SUPA = `https://${PILOT_REF}.supabase.co`;

describe('assessTarget', () => {
  it('accepts the local stack', () => {
    expect(assessTarget(LOCAL_DB, LOCAL_SUPA)).toEqual({ ok: true, host: '127.0.0.1:54321' });
    expect(assessTarget('postgresql://postgres@localhost:54322/postgres', 'http://localhost:54321').ok).toBe(true);
  });

  it('accepts a shifted-port second stack (the worktree workflow)', () => {
    // scripts/second-stack.sh shifts 543xx -> 54(3+N)xx; the guard is host-based
    // and must stay port-agnostic or a concurrent feature session cannot run it.
    expect(assessTarget('postgresql://postgres@127.0.0.1:54422/postgres', 'http://127.0.0.1:54421').ok).toBe(true);
  });

  it('refuses the pilot, and says so by name', () => {
    const v = assessTarget(PILOT_DB, PILOT_SUPA);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain(PILOT_REF);
    expect(v.reason).toMatch(/PILOT/);
  });

  it('refuses a HALF-retargeted environment in either direction', () => {
    // The dangerous case: one leg local, the other the pilot. Reads and writes
    // would land in different databases and the hosted one is production.
    expect(assessTarget(LOCAL_DB, PILOT_SUPA).ok).toBe(false);
    expect(assessTarget(PILOT_DB, LOCAL_SUPA).ok).toBe(false);
  });

  it('refuses any other remote host', () => {
    expect(assessTarget('postgresql://u:p@db.example.com:5432/postgres', 'https://example.supabase.co').ok).toBe(false);
    // Prod is read-only by policy; the guard still refuses it structurally.
    expect(assessTarget('postgresql://u:p@db.prodref.supabase.co:5432/x', LOCAL_SUPA).ok).toBe(false);
  });

  it('fails CLOSED on missing or malformed input', () => {
    // Absence of evidence is not evidence of localness.
    for (const [db, supa] of [
      ['', ''],
      [LOCAL_DB, ''],
      ['', LOCAL_SUPA],
      ['not-a-url', 'also-not-a-url'],
      [LOCAL_DB, 'not-a-url'],
      ['127.0.0.1:54322', LOCAL_SUPA], // no scheme -> unparseable
    ]) {
      const v = assessTarget(db, supa);
      expect(v.ok, `db='${db}' supa='${supa}'`).toBe(false);
    }
  });

  it('is not fooled by the pilot ref appearing in a local-looking URL', () => {
    // A local host with the pilot ref in the path still names the pilot; refuse
    // and say which reason applied.
    const v = assessTarget(`postgresql://postgres@127.0.0.1:54322/${PILOT_REF}`, LOCAL_SUPA);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain(PILOT_REF);
  });

  it('reports which leg failed, for a message that can be acted on', () => {
    const v = assessTarget(LOCAL_DB, 'https://somewhere.else.co');
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.dbLocal).toBe(true);
    expect(v.supaLocal).toBe(false);
  });
});
