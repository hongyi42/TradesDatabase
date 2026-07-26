import { afterEach, describe, expect, test, vi } from 'vitest';
import { optimizeTours } from './roiClient.js';

const KEY = 'GOOGLE_ROUTES_SA_KEY_JSON';
const savedKey = process.env[KEY];

afterEach(() => {
  if (savedKey === undefined) delete process.env[KEY];
  else process.env[KEY] = savedKey;
  vi.unstubAllGlobals();
});

// Fake mint + fake transport (the geocode/googleRoutes idiom): no key, no
// network — the seams ARE the test surface.

describe('optimizeTours', () => {
  test('mints a token, builds the project URL, posts the body verbatim', async () => {
    const calls: { url: string; token: string; body: unknown }[] = [];
    const result = await optimizeTours(
      { model: { shipments: [] } },
      {
        mintToken: async () => ({ token: 'tok-123', projectId: 'proj-abc' }),
        transport: async (url, token, body) => {
          calls.push({ url, token, body });
          return { routes: [] };
        },
      },
    );
    expect(result).toEqual({ routes: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      'https://routeoptimization.googleapis.com/v1/projects/proj-abc:optimizeTours',
    );
    expect(calls[0].token).toBe('tok-123');
    expect(calls[0].body).toEqual({ model: { shipments: [] } });
  });

  test('transport and mint errors PROPAGATE — an outage is never an empty plan', async () => {
    await expect(
      optimizeTours(
        {},
        {
          mintToken: async () => ({ token: 't', projectId: 'p' }),
          transport: async () => {
            throw new Error('optimizeTours failed: HTTP 403 PERMISSION_DENIED');
          },
        },
      ),
    ).rejects.toThrow(/HTTP 403/);
    await expect(
      optimizeTours(
        {},
        {
          mintToken: async () => {
            throw new Error('GOOGLE_ROUTES_SA_KEY_JSON is not set');
          },
          transport: async () => ({}),
        },
      ),
    ).rejects.toThrow(/GOOGLE_ROUTES_SA_KEY_JSON/);
  });

  test('LIVE mint seam: missing / garbage / project_id-less key each refuse loudly (no network)', async () => {
    const transport = async (): Promise<never> => {
      throw new Error('transport must not be reached');
    };
    delete process.env[KEY];
    await expect(optimizeTours({}, { transport })).rejects.toThrow(/is not set/);
    process.env[KEY] = '{not json';
    await expect(optimizeTours({}, { transport })).rejects.toThrow(/not valid JSON/);
    process.env[KEY] = JSON.stringify({ type: 'service_account' });
    await expect(optimizeTours({}, { transport })).rejects.toThrow(/no project_id/);
  });

  test('LIVE transport seam: Bearer auth header + JSON body on the wire; non-OK throws with status', async () => {
    const fetchCalls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      fetchCalls.push({ url, init });
      return new Response(JSON.stringify({ routes: [] }), { status: 200 });
    });
    const mintToken = async () => ({ token: 'tok-live', projectId: 'proj-live' });
    await optimizeTours({ model: { vehicles: [] } }, { mintToken });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(
      'https://routeoptimization.googleapis.com/v1/projects/proj-live:optimizeTours',
    );
    const headers = fetchCalls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok-live');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(fetchCalls[0].init.body as string)).toEqual({ model: { vehicles: [] } });

    vi.stubGlobal('fetch', async () => new Response('PERMISSION_DENIED', { status: 403 }));
    await expect(optimizeTours({}, { mintToken })).rejects.toThrow(/HTTP 403 PERMISSION_DENIED/);
  });
});
