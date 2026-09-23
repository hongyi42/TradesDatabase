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
    expect(await readState(dir)).toEqual({ sessionId: null, offset: 0 });
  });

  it('round-trips, privately, leaving no temp file behind', async () => {
    await writeState(dir, { sessionId: 's5-1', offset: 42 });
    expect(await readState(dir)).toEqual({ sessionId: 's5-1', offset: 42 });
    expect(await readdir(dir)).toEqual(['state.json']);
    expect((await stat(join(dir, 'state.json'))).mode & 0o777).toBe(0o600);
  });

  it('treats a corrupt file as empty', async () => {
    await writeFile(join(dir, 'state.json'), '{not json');
    expect(await readState(dir)).toEqual({ sessionId: null, offset: 0 });
  });
});
