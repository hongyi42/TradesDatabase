import { mkdtemp, readFile, readdir, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveMedia, sweepMedia } from './media.js';

describe('media store', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'seat-media-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('saves private files under a dated folder', async () => {
    const p = await saveMedia(dir, Buffer.from('jpegbytes'), 'jpg', new Date('2026-09-22T12:00:00Z'));
    expect(p.startsWith(join(dir, 'media', '2026-09-22'))).toBe(true);
    expect(p.endsWith('.jpg')).toBe(true);
    expect(await readFile(p, 'utf8')).toBe('jpegbytes');
    expect((await stat(p)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(p))).mode & 0o777).toBe(0o700);
  });

  it('sanitises the extension', async () => {
    const p = await saveMedia(dir, Buffer.from('x'), '../../etc');
    expect(p.startsWith(join(dir, 'media'))).toBe(true);
  });

  it('deletes only files older than the retention, and empty day folders', async () => {
    const now = Date.parse('2026-09-30T00:00:00Z');
    const old = await saveMedia(dir, Buffer.from('old'), 'ogg', new Date('2026-09-20T00:00:00Z'));
    const fresh = await saveMedia(dir, Buffer.from('new'), 'ogg', new Date('2026-09-29T00:00:00Z'));
    await utimes(old, new Date('2026-09-20T00:00:00Z'), new Date('2026-09-20T00:00:00Z'));
    await utimes(fresh, new Date('2026-09-29T00:00:00Z'), new Date('2026-09-29T00:00:00Z'));

    expect(await sweepMedia(dir, 7, now)).toBe(1);
    expect(await readdir(join(dir, 'media'))).toEqual(['2026-09-29']);
    expect(await readFile(fresh, 'utf8')).toBe('new');
  });

  it('is a no-op when nothing was ever stored', async () => {
    expect(await sweepMedia(dir, 7)).toBe(0);
  });
});
