import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { startEngine } from './engine.js';
import { seatDeps, whoAmI } from './main.js';
import { Seat } from './seat.js';
import { readState } from './state.js';
import { STOP_TEXT, type ButtonRow, type TelegramApi, type TgMessage, type TgUpdate } from './telegram.js';
import { TurnPolicy } from './turnPolicy.js';

// The local driver: the real seat loop and the real engine, with a script
// playing the technician instead of Telegram. Used for phase 2's live checks
// against the LOCAL stack — never the pilot.
//
//   node app/drive.js <script.json> [--state <dir>]
//
// Script steps, run in order:
//   {"text": "…"}            a text message
//   {"photo": "path.jpg", "caption"?: "…"}
//   {"voice": "path.wav"}     mime type from the extension (.wav → audio/wav, else audio/ogg)
//   {"stop": true} | {"new": true}
//   {"waitMs": 1500}          pause before the next step (a double text mid-answer)
//   {"waitIdle": true}        wait until the seat is idle and its replies went out
//   {"waitPrompt": true}      wait until the seat posts a question or plan with buttons (120 s)
//   {"tap": 0}                tap button n of the open prompt (a callback_query update)
// The driver waits for idle and for the cost log before it exits.
export type Step =
  | { text: string }
  | { photo: string; caption?: string }
  | { voice: string }
  | { stop: true }
  | { new: true }
  | { waitMs: number }
  | { waitIdle: true }
  | { waitPrompt: true }
  | { tap: number };

export class ScriptedTelegram implements TelegramApi {
  private queue: TgUpdate[] = [];
  private nextId: number;
  private waiters: Array<() => void> = [];
  readonly sent: string[] = [];
  /** The last prompt the seat posted with buttons: its callback data, in order. */
  lastPrompt: { data: string[] } | null = null;

  // Numbering starts at the seat's saved offset: a driver restarted on the same
  // state dir must hand out ids the seat has not already moved past.
  constructor(
    private readonly userId: number,
    firstUpdateId = 1,
  ) {
    this.nextId = Math.max(1, firstUpdateId);
  }

  push(message: Partial<TgMessage>): void {
    this.queue.push({
      update_id: this.nextId++,
      message: { message_id: this.nextId, chat: { id: this.userId, type: 'private' }, from: { id: this.userId }, ...message },
    });
    for (const w of this.waiters.splice(0)) w();
  }

  /** A tap on a button, as Telegram delivers it. */
  pushTap(data: string, messageId: number): void {
    this.queue.push({
      update_id: this.nextId++,
      callback_query: { id: `cb${this.nextId}`, from: { id: this.userId }, data, message: { message_id: messageId, chat: { id: this.userId, type: 'private' } } },
    });
    for (const w of this.waiters.splice(0)) w();
  }

  async sendButtons(_chatId: number, text: string, rows: ButtonRow[]): Promise<number> {
    const data = rows.flat().map((b) => b.data);
    console.log(`\n<< SEAT: ${text}\n   [${rows.flat().map((b, i) => `${i}:${b.text}`).join('] [')}]\n`);
    this.sent.push(text);
    this.lastPrompt = { data };
    return this.nextMessageId++;
  }

  async clearButtons(): Promise<void> {}

  async getUpdates(offset: number): Promise<TgUpdate[]> {
    const ready = () => this.queue.filter((u) => u.update_id >= offset);
    if (!ready().length) await new Promise<void>((r) => this.waiters.push(r));
    const out = ready();
    this.queue = [];
    return out;
  }

  async send(_chatId: number, text: string): Promise<void> {
    this.sent.push(text);
    console.log(`\n<< SEAT: ${text}\n`);
  }

  async typing(): Promise<void> {}

  private nextMessageId = 1;

  async sendWorking(): Promise<number> {
    console.log('   (Working… ⏹ Stop)');
    return this.nextMessageId++;
  }

  async deleteMessage(): Promise<void> {}

  async answerCallback(): Promise<void> {}

  /** In the driver a file id IS a local path. */
  async download(fileId: string): Promise<Buffer> {
    return readFile(fileId);
  }
}

export async function drive(steps: Step[], seat: Seat, tg: ScriptedTelegram): Promise<void> {
  let promptsSeen = 0;
  for (const step of steps) {
    if ('waitPrompt' in step) {
      // Any prompt, with or without buttons ("What should change?" has none).
      const deadline = Date.now() + 120_000;
      while (seat.promptsPosted <= promptsSeen) {
        if (Date.now() > deadline) throw new Error('no prompt within 120000 ms');
        await new Promise((r) => setTimeout(r, 200));
      }
      promptsSeen = seat.promptsPosted;
      continue;
    }
    if ('tap' in step) {
      const data = tg.lastPrompt?.data[step.tap];
      if (!data) throw new Error(`tap ${step.tap}: no such button on the last prompt`);
      console.log(`>> TAP: ${step.tap}`);
      tg.pushTap(data, 0);
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }
    if ('waitMs' in step) await new Promise((r) => setTimeout(r, step.waitMs));
    else if ('waitIdle' in step) await seat.whenIdle();
    else if ('text' in step) {
      console.log(`>> TECH: ${step.text}`);
      tg.push({ text: step.text });
    } else if ('photo' in step) {
      console.log(`>> TECH: [photo ${step.photo}] ${step.caption ?? ''}`);
      tg.push({ photo: [{ file_id: step.photo, width: 1280, height: 960 }], caption: step.caption });
    } else if ('voice' in step) {
      console.log(`>> TECH: [voice ${step.voice}]`);
      tg.push({ voice: { file_id: step.voice, mime_type: extname(step.voice) === '.wav' ? 'audio/wav' : 'audio/ogg' } });
    } else if ('stop' in step) {
      console.log('>> TECH: [Stop]');
      tg.push({ text: STOP_TEXT });
    } else if ('new' in step) {
      console.log('>> TECH: /new');
      tg.push({ text: '/new' });
    }
    // Give the seat's loop a moment to pick the update up before the next step.
    await new Promise((r) => setTimeout(r, 200));
  }
  await seat.whenIdle();
}

async function main(argv: string[]): Promise<void> {
  const [scriptPath] = argv;
  if (!scriptPath) throw new Error('usage: drive <script.json> [--state <dir>]');
  const s = argv.indexOf('--state');
  if (s >= 0) process.env.SEAT_STATE_DIR = argv[s + 1];
  // A driver run needs no bot: the token is a placeholder the fake never uses.
  process.env.TELEGRAM_BOT_TOKEN ||= 'driver-no-telegram';
  const cfg = loadConfig(process.env);
  const steps = JSON.parse(await readFile(scriptPath, 'utf8')) as Step[];

  const who = await whoAmI(cfg);
  const client = await startEngine({ baseDirectory: join(cfg.stateDir, 'engine'), tz: who.tz });
  const tg = new ScriptedTelegram(who.telegramUserId, (await readState(cfg.stateDir)).offset);
  const deps = seatDeps(cfg, who, client, tg, new TurnPolicy());
  const seat = new Seat(deps);
  const loop = seat.run().catch((err: unknown) => {
    console.error(`seat loop failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1); // a seat that never started would leave the driver waiting forever
  });
  // Steps only start once the conversation is open — otherwise the first
  // waitIdle passes at once and the opening texts pile up (live, 2026-09-22).
  await seat.ready;
  await drive(steps, seat, tg);
  console.log(`driver: session ${seat.sessionId}; waiting for cost lines…`);
  await deps.costLog.flush();
  seat.stop();
  await client.stop().catch(() => []);
  void loop;
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`driver: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
