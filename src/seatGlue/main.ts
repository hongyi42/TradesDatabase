import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, type SeatConfig } from './config.js';
import { CostLog } from './costLog.js';
import { openSession, startEngine, type EngineClient, type EngineConfig } from './engine.js';
import { saveMedia, sweepMedia } from './media.js';
import { Seat, type SeatDeps } from './seat.js';
import { readState, writeState } from './state.js';
import { TelegramClient, TelegramConflictError, type TelegramApi } from './telegram.js';
import { TurnPolicy } from './turnPolicy.js';
import { transcribe } from './voice.js';
import { fetchWhoami, type SeatWho } from './whoami.js';

// The seat glue's entry point on trades-box-1: `node app/main.js`, run by
// seat-glue@<seat>.service with the seat's env file.
//
// Exit 3 = another process is polling this bot (Telegram 409). The unit has
// RestartPreventExitStatus=3: two pollers make both deaf, so the glue stops and
// says so rather than fighting every 10 seconds.
export const EXIT_CONFLICT = 3;

export function engineConfig(cfg: SeatConfig, who: SeatWho): EngineConfig {
  return {
    seatRef: cfg.seatRef,
    stateDir: cfg.stateDir,
    tz: who.tz,
    model: cfg.model,
    openrouterKey: cfg.openrouterKey,
    spineUrl: cfg.spineUrl,
    seatToken: cfg.seatToken,
    tier: who.tier,
  };
}

/**
 * Who this seat is, from Render (step 4). Refuses a token that names a
 * DIFFERENT seat than the unit it runs in — an env file copied between seats
 * would otherwise answer one person's Telegram with another person's identity.
 */
export async function whoAmI(cfg: SeatConfig): Promise<SeatWho> {
  const who = await fetchWhoami(cfg.spineUrl, cfg.seatToken);
  if (who.seatRef !== cfg.seatRef) {
    throw new Error(`seat-glue: this token belongs to seat ${who.seatRef}, not ${cfg.seatRef}`);
  }
  return who;
}

/** Everything a Seat needs, wired to the real engine and the given Telegram. */
export function seatDeps(
  cfg: SeatConfig,
  who: SeatWho,
  client: EngineClient,
  telegram: TelegramApi,
  policy: TurnPolicy,
): SeatDeps & { costLog: CostLog } {
  const costLog = new CostLog({
    seat: cfg.seatRef,
    tenantId: who.tenantId,
    technicianRef: who.technicianRef,
    stateDir: cfg.stateDir,
    openrouterKey: cfg.openrouterKey,
  });
  return {
    telegram,
    openSession: (id, hooks) => openSession(client, engineConfig(cfg, who), policy, id, hooks),
    policy,
    costLog,
    transcribe: (buf, mime) => transcribe(buf, mime, { openrouterKey: cfg.openrouterKey }),
    saveMedia: (buf, ext) => saveMedia(cfg.stateDir, buf, ext),
    sweepMedia: () => sweepMedia(cfg.stateDir, cfg.mediaRetentionDays),
    readState: () => readState(cfg.stateDir),
    writeState: (s) => writeState(cfg.stateDir, s),
    allowedUserId: who.telegramUserId,
  };
}

/** Start the engine on a throwaway directory, ping it, stop it. Needs no seat settings. */
export async function selfcheck(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'seat-glue-selfcheck-'));
  try {
    const client = await startEngine({ baseDirectory: dir, tz: 'UTC' });
    await client.ping('selfcheck');
    const errors = await client.stop();
    if (errors.length) throw new Error(`engine stop reported ${errors.length} error(s): ${errors[0].message}`);
    console.log('seat-glue: selfcheck ok (engine started, answered a ping, stopped)');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes('--selfcheck')) return selfcheck();

  const cfg = loadConfig(process.env);
  // Before Telegram and before the engine: a seat that cannot say who it is
  // exits non-zero and systemd retries — it never runs on a guessed identity.
  const who = await whoAmI(cfg);
  const client = await startEngine({ baseDirectory: join(cfg.stateDir, 'engine'), tz: who.tz });
  const deps = seatDeps(cfg, who, client, new TelegramClient(cfg.botToken), new TurnPolicy());
  const seat = new Seat(deps);

  // A restart (an upgrade, systemd) must not drop the last reply's cost lines:
  // each waits up to ~2 min for OpenRouter's generation record. Bounded well
  // inside systemd's default 90 s stop timeout.
  let stopping = false;
  const shutdown = async (code: number) => {
    if (stopping) return;
    stopping = true;
    seat.stop();
    await Promise.race([deps.costLog.flush(), new Promise((r) => setTimeout(r, 20_000))]);
    await client.stop().catch(() => []);
    process.exit(code);
  };
  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGINT', () => void shutdown(0));

  console.log(`seat-glue: ${cfg.seatRef} polling Telegram (model ${cfg.model}, tz ${who.tz})`);
  try {
    await seat.run();
  } catch (err) {
    if (err instanceof TelegramConflictError) {
      console.error('seat-glue: ANOTHER POLLER IS USING THIS BOT — stopping (exit 3). Is the old openclaw seat still running?');
      await shutdown(EXIT_CONFLICT);
    }
    throw err;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`seat-glue: fatal — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
