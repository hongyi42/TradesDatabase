import { describe, expect, it, vi } from 'vitest';
import type { SeatConfig } from './config.js';
import { ExportError } from './fileTools.js';
import type { FetchLike, HttpInit } from './http.js';
import { exportRows, managerTools } from './main.js';
import type { TelegramApi } from './telegram.js';
import type { SeatWho } from './whoami.js';

// Step 2b wiring in main.ts: Render's /seat/export, and who gets file tools.
const cfg: SeatConfig = {
  botToken: 'b',
  seatRef: 's2',
  seatToken: `st_${'c'.repeat(64)}`,
  spineUrl: 'https://spine.example/mcp',
  openrouterKey: 'k',
  model: 'm',
  stateDir: '/tmp/seat-glue-test-never-written',
  mediaRetentionDays: 7,
  e2bTemplate: 'trades-manager',
};
const who = (tier: 'manager' | 'technician'): SeatWho => ({
  seatRef: 's2',
  tenantId: 't',
  technicianRef: 'manager-sam',
  telegramUserId: 42,
  tz: 'UTC',
  tier,
  shareConversation: tier !== 'manager',
});
const reply = (status: number, body: unknown): FetchLike => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  arrayBuffer: async () => new ArrayBuffer(0),
});

describe('exportRows', () => {
  it('posts the SQL to /seat/export with the seat token only in the header', async () => {
    let seen: { url?: string; init?: HttpInit } = {};
    const f: FetchLike = async (url, init) => {
      seen = { url, init };
      return reply(200, { csv: 'a\r\n1\r\n', columns: ['a'], rowCount: 1, truncated: false })(url, init);
    };
    expect(await exportRows(cfg, 'select a from v_jobs', f)).toMatchObject({ rowCount: 1 });
    expect(seen.url).toBe('https://spine.example/seat/export');
    expect(seen.init?.headers).toMatchObject({ authorization: `Bearer ${cfg.seatToken}` });
    expect(JSON.parse(seen.init?.body as string)).toEqual({ sql: 'select a from v_jobs' });
  });

  it("a 400 carries Render's words and its status; an empty 500 is still an ExportError with 500", async () => {
    const bad = await exportRows(cfg, 'x', reply(400, { error: 'column "x" does not exist' })).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(ExportError);
    expect(bad).toMatchObject({ message: 'column "x" does not exist', status: 400 });
    const down = await exportRows(cfg, 'x', reply(500, null)).catch((e: unknown) => e);
    expect(down).toMatchObject({ status: 500, message: 'Render answered HTTP 500' });
  });
});

describe('managerTools', () => {
  const tg = {} as TelegramApi;
  it('a technician never gets file tools, key or not', () => {
    expect(managerTools({ ...cfg, e2bApiKey: 'e2b_k' }, who('technician'), tg)).toBeUndefined();
  });
  it('a manager without a key gets none, and the journal says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(managerTools(cfg, who('manager'), tg)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no E2B_API_KEY/));
  });
  it('a manager with a key gets the five tools', () => {
    expect(managerTools({ ...cfg, e2bApiKey: 'e2b_k' }, who('manager'), tg)?.tools.map((t) => t.name)).toEqual([
      'run_command',
      'read_file',
      'write_file',
      'share_file',
      'export_query',
    ]);
  });
});
