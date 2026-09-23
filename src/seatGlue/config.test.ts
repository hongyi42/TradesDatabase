import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const FULL = {
  TELEGRAM_BOT_TOKEN: 'tok',
  SEAT_REF: 's5',
  SEAT_TENANT_ID: 'tenant-1',
  SEAT_TECHNICIAN_REF: 'ben-shelton',
  SEAT_TELEGRAM_USER_ID: '8991633730',
  SEAT_TZ: 'America/Los_Angeles',
  GATEWAY_IDENTITY_SECRET: 'secret',
  SPINE_MCP_URL: 'https://example.onrender.com/',
  OPENROUTER_API_KEY: 'sk-or',
};

describe('loadConfig', () => {
  it('reads a full env with defaults', () => {
    const c = loadConfig({ ...FULL });
    expect(c.telegramUserId).toBe(8991633730);
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
      expect(String(e)).not.toContain('secret');
      expect(String(e)).not.toContain('sk-or');
    }
  });

  it('rejects a bad Telegram id, a bad timezone and a plaintext remote spine URL', () => {
    expect(() => loadConfig({ ...FULL, SEAT_TELEGRAM_USER_ID: 'ben' })).toThrow('SEAT_TELEGRAM_USER_ID');
    expect(() => loadConfig({ ...FULL, SEAT_TZ: 'Mars/Olympus' })).toThrow('SEAT_TZ');
    expect(() => loadConfig({ ...FULL, SPINE_MCP_URL: 'http://example.com/' })).toThrow('https');
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
