import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, type SeatConfig } from './config.js';
import { CostLog } from './costLog.js';
import { openSession, startEngine, type EngineClient, type EngineConfig } from './engine.js';
import { ExportError, fileTools, type ExportResult, type FileTool, type FileToolSet } from './fileTools.js';
import { defaultFetch, type FetchLike } from './http.js';
import { seatHeaders } from './identity.js';
import { ManagerSandbox } from './sandbox.js';
import { fetchInbox, reportInbox } from './inbox.js';
import { saveMedia, sweepMedia } from './media.js';
import { Seat, type SeatDeps } from './seat.js';
import { readState, writeState } from './state.js';
import { TelegramClient, TelegramConflictError, type TelegramApi } from './telegram.js';
import { TurnPolicy } from './turnPolicy.js';
import { Transcript } from './transcript.js';
import { transcribe } from './voice.js';
import { answersPrompt, approvesPlan, needsPlan } from './jev.js';
import { fetchWhoami, type SeatWho } from './whoami.js';

// The seat glue's entry point on trades-box-1: `node app/main.js`, run by
// seat-glue@<seat>.service with the seat's env file.
//
// Exit 3 = another process is polling this bot (Telegram 409). The unit has
// RestartPreventExitStatus=3: two pollers make both deaf, so the glue stops and
// says so rather than fighting every 10 seconds.
export const EXIT_CONFLICT = 3;
// Exit 4 = the seat is gone for good: its person was deactivated, or no Telegram
// account is bound any more (step 3, learned from the inbox pull). The unit has
// RestartPreventExitStatus=3 4, so it stays down instead of restarting every
// 10 s into a whoami that refuses it.
export const EXIT_SEAT_GONE = 4;

export function engineConfig(cfg: SeatConfig, who: SeatWho, tools?: FileTool[]): EngineConfig {
  return {
    seatRef: cfg.seatRef,
    stateDir: cfg.stateDir,
    tz: who.tz,
    model: cfg.model,
    openrouterKey: cfg.openrouterKey,
    spineUrl: cfg.spineUrl,
    seatToken: cfg.seatToken,
    tier: who.tier,
    ...(tools?.length ? { tools } : {}),
  };
}

/** Render's POST /seat/export: a query's every row as CSV (step 2b). */
export async function exportRows(cfg: SeatConfig, sql: string, fetchFn: FetchLike = defaultFetch): Promise<ExportResult> {
  const res = await fetchFn(new URL('/seat/export', cfg.spineUrl).toString(), {
    method: 'POST',
    headers: { ...seatHeaders(cfg.seatToken), 'content-type': 'application/json' },
    body: JSON.stringify({ sql }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json().catch(() => null)) as (ExportResult & { error?: string }) | null;
  if (!res.ok || !body || typeof body.csv !== 'string') {
    throw new ExportError(body?.error ?? `Render answered HTTP ${res.status}`, res.status);
  }
  return body;
}

/**
 * A manager's file tools (step 2b), or none. Built here, not in main(), because
 * the local driver builds its seat through seatDeps too.
 */
export function managerTools(cfg: SeatConfig, who: SeatWho, telegram: TelegramApi): FileToolSet | undefined {
  if (who.tier !== 'manager') return undefined;
  if (!cfg.e2bApiKey) {
    console.warn('seat-glue: no E2B_API_KEY — this manager seat has no file tools');
    return undefined;
  }
  const sandbox = new ManagerSandbox({
    apiKey: cfg.e2bApiKey,
    template: cfg.e2bTemplate,
    stateDir: cfg.stateDir,
    meta: { seat: cfg.seatRef, tenantId: who.tenantId, technicianRef: who.technicianRef },
  });
  return fileTools({
    sandbox,
    exportRows: (sql) => exportRows(cfg, sql),
    sendDocument: (name, bytes, caption) => telegram.sendDocument(who.telegramUserId, name, bytes, caption),
  });
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
  // office:false leaves the office out (inbox, disclosure): the local driver runs
  // the REAL seat token against a scripted Telegram, and must never drain the
  // person's real inbox or tell a fake that the office reads the chat.
  opts: { office?: boolean; onSeatChanged?: (code: 0 | 1 | 4) => void } = {},
): SeatDeps & { costLog: CostLog; transcript?: Transcript } {
  const costLog = new CostLog({
    seat: cfg.seatRef,
    tenantId: who.tenantId,
    technicianRef: who.technicianRef,
    stateDir: cfg.stateDir,
    openrouterKey: cfg.openrouterKey,
  });
  const files = managerTools(cfg, who, telegram);
  return {
    telegram,
    openSession: (id, hooks) => openSession(client, engineConfig(cfg, who, files?.tools), policy, id, hooks),
    ...(files ? { onAbort: () => files.stopRunning() } : {}),
    policy,
    costLog,
    transcribe: (buf, mime) => transcribe(buf, mime, { openrouterKey: cfg.openrouterKey }),
    saveMedia: (buf, ext) => saveMedia(cfg.stateDir, buf, ext),
    sweepMedia: () => sweepMedia(cfg.stateDir, cfg.mediaRetentionDays),
    readState: () => readState(cfg.stateDir),
    writeState: (s) => writeState(cfg.stateDir, s),
    allowedUserId: who.telegramUserId,
    // Step 2a: a manager seat asks with buttons and shows plans (Seat hooks),
    // and Jev decides per message whether to plan first. Technicians get neither.
    manager: who.tier === 'manager',
    ...(who.tier === 'manager'
      ? {
          planChooser: (message: string, previous: { user: string; assistant: string } | null) =>
            needsPlan({ openrouterKey: cfg.openrouterKey, log: (m) => console.log(`seat-glue: ${m}`) }, message, previous),
          approvesPlan: (reply: string, summary: string) =>
            approvesPlan({ openrouterKey: cfg.openrouterKey, log: (m) => console.log(`seat-glue: ${m}`) }, reply, summary),
          answersPrompt: (reply: string, question: string, choices: string[]) =>
            answersPrompt({ openrouterKey: cfg.openrouterKey, log: (m) => console.log(`seat-glue: ${m}`) }, reply, question, choices),
        }
      : {}),
    ...(opts.office === false
      ? {}
      : {
          inbox: {
            fetch: () => fetchInbox(cfg.spineUrl, cfg.seatToken),
            report: (r) => reportInbox(cfg.spineUrl, cfg.seatToken, r),
          },
          who: { telegramUserId: who.telegramUserId, tz: who.tz, shareConversation: who.shareConversation },
          onSeatChanged: opts.onSeatChanged,
          // A manager's conversation is private (operator, 2026-09-24): no
          // recorder at all, so nothing of it can leave the box.
          ...(who.shareConversation
            ? { transcript: new Transcript({ spineUrl: cfg.spineUrl, seatToken: cfg.seatToken, stateDir: cfg.stateDir }) }
            : {}),
        }),
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
  // shutdown is declared below and needs the seat; the seat needs to call it.
  let onSeatChanged: (code: 0 | 1 | 4) => void = () => {};
  const deps = seatDeps(cfg, who, client, new TelegramClient(cfg.botToken), new TurnPolicy(), {
    onSeatChanged: (code) => onSeatChanged(code),
  });
  // Turns a previous run could not upload go first.
  await deps.transcript?.load();
  const seat = new Seat(deps);

  // A restart (an upgrade, systemd) must not drop the last reply's cost lines:
  // each waits up to ~2 min for OpenRouter's generation record. Bounded well
  // inside systemd's default 90 s stop timeout.
  let stopping = false;
  const shutdown = async (code: number) => {
    if (stopping) return;
    stopping = true;
    seat.stop();
    // The office item in hand first (step 3): a text that went out must have its
    // id saved, or the restarted glue texts it again. Bounded above one Telegram
    // send (20 s timeout) plus the outbox ahead of it; with the flush below this
    // stays inside systemd's 90 s stop timeout.
    await Promise.race([seat.settle(), new Promise((r) => setTimeout(r, 30_000))]);
    await Promise.race([deps.costLog.flush(), new Promise((r) => setTimeout(r, 20_000))]);
    // The last reply's turns: one more upload try, then the outbox on disk
    // (whatever did not upload goes on the next start).
    if (deps.transcript) {
      const transcript = deps.transcript;
      transcript.settleOpenTools();
      await Promise.race([transcript.flush(), new Promise((r) => setTimeout(r, 5_000))]);
      await transcript.saved();
    }
    await client.stop().catch(() => []);
    process.exit(code);
  };
  onSeatChanged = (code) => void shutdown(code);
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
