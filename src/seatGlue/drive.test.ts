import { describe, expect, it } from 'vitest';
import { ScriptedTelegram } from './drive.js';

describe('ScriptedTelegram', () => {
  it('numbers updates from the seat offset, so a restarted driver is not skipped', async () => {
    const tg = new ScriptedTelegram(900000001, 9);
    tg.push({ text: 'what did I tell you about the fan?' });
    const got = await tg.getUpdates(9);
    expect(got).toHaveLength(1);
    expect(got[0].update_id).toBe(9);
  });

  it('starts at 1 on a fresh state dir', async () => {
    const tg = new ScriptedTelegram(900000001, 0);
    tg.push({ text: 'hi' });
    expect((await tg.getUpdates(0))[0].update_id).toBe(1);
  });
});

// Step 3: the driver runs the REAL seat token against a scripted Telegram, so
// the office must stay unwired — no real inbox drained, no notice to a fake.
import { seatDeps } from './main.js';
import { TurnPolicy } from './turnPolicy.js';
import type { SeatConfig } from './config.js';
import type { EngineClient } from './engine.js';

describe('seatDeps office wiring', () => {
  const cfg: SeatConfig = {
    botToken: 'x',
    seatRef: 's5',
    seatToken: `st_${'a'.repeat(64)}`,
    spineUrl: 'https://spine.example/mcp',
    openrouterKey: 'k',
    model: 'm',
    stateDir: '/tmp/seat-glue-test-never-written',
    mediaRetentionDays: 7,
    e2bTemplate: 'trades-manager',
    skillsDir: '/tmp/seat-glue-test-no-skills',
  };
  const who = { seatRef: 's5', tenantId: 't', technicianRef: 'ben', telegramUserId: 5801703167, tz: 'UTC', tier: 'technician' as const, shareConversation: true };
  const client = {} as EngineClient;

  it('the office is wired by default', () => {
    const deps = seatDeps(cfg, who, client, new ScriptedTelegram(1), new TurnPolicy());
    expect(deps.inbox).toBeDefined();
    expect(deps.who).toEqual({ telegramUserId: 5801703167, tz: 'UTC', shareConversation: true });
    expect(deps.transcript).toBeDefined();
  });

  it("a manager's seat gets the inbox but never a recorder (their chat is private)", () => {
    const deps = seatDeps(cfg, { ...who, shareConversation: false }, client, new ScriptedTelegram(1), new TurnPolicy());
    expect(deps.inbox).toBeDefined();
    expect(deps.transcript).toBeUndefined();
  });

  it('office:false leaves it out entirely', () => {
    const deps = seatDeps(cfg, who, client, new ScriptedTelegram(1), new TurnPolicy(), { office: false });
    expect(deps.inbox).toBeUndefined();
    expect(deps.who).toBeUndefined();
    expect(deps.onSeatChanged).toBeUndefined();
    expect(deps.transcript).toBeUndefined();
  });
});
