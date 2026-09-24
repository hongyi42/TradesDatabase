import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const FULL = {
  TELEGRAM_BOT_TOKEN: 'tok',
  SEAT_REF: 's5',
  SEAT_TOKEN: `st_${'5e'.repeat(32)}`,
  SPINE_MCP_URL: 'https://example.onrender.com/',
  OPENROUTER_API_KEY: 'sk-or',
};

describe('loadConfig', () => {
  it('reads a full env with defaults', () => {
    const c = loadConfig({ ...FULL });
    expect(c.seatToken).toBe(FULL.SEAT_TOKEN);
    expect(c.model).toBe('@preset/trades-seats');
    expect(c.stateDir).toBe('/var/lib/seat-glue');
    expect(c.mediaRetentionDays).toBe(7);
  });

  it.each(Object.keys(FULL))('fails closed when %s is missing, naming it without any value', (key) => {
    const env: Record<string, string> = { ...FULL, [key]: '' };
    expect(() => loadConfig(env)).toThrow(key);
    try {
      loadConfig(env);
    } catch (e) {
      expect(String(e)).not.toContain('5e5e');
      expect(String(e)).not.toContain('sk-or');
    }
  });

  it('rejects a malformed seat token without echoing it, and a plaintext remote spine URL', () => {
    expect(() => loadConfig({ ...FULL, SEAT_TOKEN: 'a-badge-not-a-seat-token' })).toThrow('SEAT_TOKEN');
    try {
      loadConfig({ ...FULL, SEAT_TOKEN: 'a-badge-not-a-seat-token' });
    } catch (e) {
      expect(String(e)).not.toContain('a-badge-not-a-seat-token');
    }
    expect(() => loadConfig({ ...FULL, SPINE_MCP_URL: 'http://example.com/' })).toThrow('https');
  });

  it('no longer needs (or reads) the identity secret or hand-typed identity', () => {
    const c = loadConfig({ ...FULL });
    expect(Object.keys(c)).not.toContain('secret');
    expect(Object.keys(c)).not.toContain('tz');
    expect(Object.keys(c)).not.toContain('tenantId');
  });

  it('allows plain http to loopback only (the local E2E)', () => {
    expect(loadConfig({ ...FULL, SPINE_MCP_URL: 'http://127.0.0.1:8123/' }).spineUrl).toBe(
      'http://127.0.0.1:8123/',
    );
  });

  it('rejects a non-positive retention', () => {
    expect(() => loadConfig({ ...FULL, MEDIA_RETENTION_DAYS: '0' })).toThrow('MEDIA_RETENTION_DAYS');
  });
});
