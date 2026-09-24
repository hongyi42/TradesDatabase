import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readState, writeState } from './state.js';

describe('seat state', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'seat-state-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('starts empty when there is no file', async () => {
    expect(await readState(dir)).toEqual({ sessionId: null, offset: 0, pending: [], handledIds: [], disclosed: false });
  });

  it('round-trips, privately, leaving no temp file behind', async () => {
    await writeState(dir, { sessionId: 's5-1', offset: 42 });
    expect(await readState(dir)).toEqual({ ...{ sessionId: null, offset: 0, pending: [], handledIds: [], disclosed: false }, sessionId: 's5-1', offset: 42 });
    expect(await readdir(dir)).toEqual(['state.json']);
    expect((await stat(join(dir, 'state.json'))).mode & 0o777).toBe(0o600);
  });

  it('treats a corrupt file as empty', async () => {
    await writeFile(join(dir, 'state.json'), '{not json');
    expect(await readState(dir)).toEqual({ sessionId: null, offset: 0, pending: [], handledIds: [], disclosed: false });
  });

  // Step 3: a state.json written before the office fields existed still reads.
  it('reads an old-shape file with the office fields defaulted', async () => {
    await writeFile(join(dir, 'state.json'), JSON.stringify({ sessionId: 's5-9', offset: 7 }));
    expect(await readState(dir)).toEqual({ ...{ sessionId: null, offset: 0, pending: [], handledIds: [], disclosed: false }, sessionId: 's5-9', offset: 7 });
  });

  it('keeps well-formed waiting items and drops malformed ones', async () => {
    const good = { id: 'a', leg: 'phone', text: 'hi', at: '2026-09-24T10:00:00.000Z' };
    await writeFile(
      join(dir, 'state.json'),
      JSON.stringify({ sessionId: null, offset: 0, pending: [good, { id: 'b', leg: 'sms' }], handledIds: ['a', 3], disclosed: true }),
    );
    expect(await readState(dir)).toMatchObject({ pending: [good], handledIds: ['a'], disclosed: true });
  });

  it('two writes at once never tear the file or leave a temp file', async () => {
    await Promise.all([
      writeState(dir, { sessionId: 'x', offset: 1 }),
      writeState(dir, { sessionId: 'y', offset: 2 }),
    ]);
    const got = await readState(dir);
    expect(['x', 'y']).toContain(got.sessionId);
    expect(await readdir(dir)).toEqual(['state.json']);
  });
});
