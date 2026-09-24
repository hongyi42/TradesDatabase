import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CostLog, type CallRef } from './costLog.js';
import type { BlobAttachment, EngineEvent, EngineSession } from './engine.js';
import { InboxRefused, type InboxItem, type InboxResult } from './inbox.js';
import { Seat, TEXT, type SeatDeps } from './seat.js';
import type { SeatState } from './state.js';
import { TelegramConflictError, type TelegramApi, type TgMessage, type TgUpdate } from './telegram.js';
import { TurnPolicy } from './turnPolicy.js';

const BEN = 8991633730;
const STATE_DIR = '/state-dir-that-must-never-reach-the-model';

type Sent = { prompt: string; mode?: string; attachments?: BlobAttachment[] };

class FakeSession implements EngineSession {
  readonly sends: Sent[] = [];
  aborts = 0;
  disconnected = false;
  /** When true, abort() answers with an aborted idle (the engine's normal behaviour). */
  idleOnAbort = true;
  private handler: ((e: EngineEvent) => void) | null = null;
  constructor(readonly sessionId: string) {}
  async send(o: Sent): Promise<string> {
    this.sends.push(o);
    return `m${this.sends.length}`;
  }
  async abort(): Promise<void> {
    this.aborts += 1;
    if (this.idleOnAbort) setTimeout(() => this.emit('session.idle', { aborted: true }), 0);
  }
  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
  on(h: (e: EngineEvent) => void): () => void {
    this.handler = h;
    return () => {
      this.handler = null;
    };
  }
  emit(type: string, data: Record<string, unknown> = {}): void {
    this.handler?.({ type, data });
  }
}

class FakeTelegram implements TelegramApi {
  readonly sent: string[] = [];
  typingCalls = 0;
  files = new Map<string, Buffer>();
  async getUpdates(): Promise<TgUpdate[]> {
    return [];
  }
  async send(_chat: number, text: string): Promise<void> {
    this.sent.push(text);
  }
  async typing(): Promise<void> {
    this.typingCalls += 1;
  }
  async download(fileId: string): Promise<Buffer> {
    return this.files.get(fileId) ?? Buffer.from('bytes');
  }
  /** "Working…" lines currently on screen, by message id. */
  readonly working = new Set<number>();
  readonly callbacks: Array<{ id: string; text?: string }> = [];
  private nextId = 100;
  async sendWorking(): Promise<number> {
    const id = this.nextId++;
    this.working.add(id);
    return id;
  }
  async deleteMessage(_chat: number, id: number): Promise<void> {
    this.working.delete(id);
  }
  async answerCallback(id: string, text?: string): Promise<void> {
    this.callbacks.push({ id, text });
  }
}

let n = 0;
const upd = (message: Partial<TgMessage>, from = BEN): TgUpdate => ({
  update_id: ++n,
  message: { message_id: n, chat: { id: from, type: 'private' }, from: { id: from }, ...message },
});
const tick = () => new Promise((r) => setTimeout(r, 5));

function setup(over: Partial<SeatDeps> = {}) {
  const sessions: FakeSession[] = [];
  const telegram = new FakeTelegram();
  const policy = new TurnPolicy();
  const records: CallRef[] = [];
  const states: SeatState[] = [];
  const deps: SeatDeps = {
    telegram,
    openSession: async (id) => {
      const s = new FakeSession(id ?? `s5-${sessions.length + 1}`);
      sessions.push(s);
      return s;
    },
    policy,
    costLog: { record: async (r) => void records.push(r) },
    transcribe: async () => ({ text: 'fan swapped, parts 180', generationId: 'gen-voice' }),
    saveMedia: async (_b, ext) => `${STATE_DIR}/media/2026-09-22/x.${ext}`,
    sweepMedia: async () => 0,
    readState: async () => ({ sessionId: null, offset: 0 }),
    writeState: async (s) => void states.push(s),
    allowedUserId: BEN,
    log: () => {},
    abortWaitMs: 500,
    typingEveryMs: 60_000,
    ...over,
  };
  const seat = new Seat(deps);
  const session = () => sessions[sessions.length - 1];
  return { seat, deps, telegram, policy, records, states, sessions, session };
}

describe('Seat', () => {
  it('sends a text straight to the engine, with no wait, and shows typing', async () => {
    const t = setup();
    await t.seat.start();
    await t.seat.handleUpdate(upd({ text: 'what is on tomorrow?' }));
    expect(t.session().sends).toEqual([{ prompt: 'what is on tomorrow?' }]);
    expect(t.telegram.typingCalls).toBe(1);
    expect(t.states.at(-1)?.offset).toBe(n + 1);
  });

  it('steers a double text into the reply when a tool is pending — no abort', async () => {
    const t = setup();
    await t.seat.start();
    await t.seat.handleUpdate(upd({ text: 'finished the Hendricks job' }));
    t.policy.onToolPending('call-1'); // the permission handler approved record_field_note
    await t.seat.handleUpdate(upd({ text: 'parts were $180' }));
    expect(t.session().aborts).toBe(0);
    expect(t.session().sends[1]).toEqual({ prompt: 'parts were $180', mode: 'immediate' });
  });

  it('aborts a plain answer on a double text and sends ONLY the new text', async () => {
    const t = setup();
    await t.seat.start();
    await t.seat.handleUpdate(upd({ text: 'finished the Hendricks job' }));
    await t.seat.handleUpdate(upd({ text: 'parts were $180' }));
    expect(t.session().aborts).toBe(1);
    expect(t.session().sends).toEqual([{ prompt: 'finished the Hendricks job' }, { prompt: 'parts were $180' }]);
    // Still one reply in progress: the abort's idle did not free it.
    expect(t.policy.isBusy).toBe(true);
  });

  it('sends each non-empty assistant message as its own text and drops empty ones', async () => {
    const t = setup();
    await t.seat.start();
    await t.seat.handleUpdate(upd({ text: 'hi' }));
    t.session().emit('assistant.message', { content: 'Got that recorded.' });
    t.session().emit('assistant.message', { content: 'What did the parts cost?' });
    t.session().emit('assistant.message', { content: '   ' });
    t.session().emit('session.idle', {});
    await t.seat.whenIdle(1);
    expect(t.telegram.sent).toEqual(['Got that recorded.', 'What did the parts cost?']);
  });

  it("never sends a model call's narration before a tool call — only the answer", async () => {
    const t = setup();
    await t.seat.start();
    await t.seat.handleUpdate(upd({ text: "what's on tomorrow?" }));
    const s = t.session();
    s.emit('assistant.turn_start', { turnId: '0' });
    s.emit('assistant.message', { content: "**Checking Tomorrow's Schedule**\n\nI'm currently focused on…" });
    s.emit('assistant.message', { content: '', toolRequests: [{ toolCallId: 'c1', name: 'spine-get_schedule' }] });
    s.emit('tool.execution_complete', { toolCallId: 'c1' });
    s.emit('assistant.turn_end', { turnId: '0' });
    s.emit('assistant.turn_start', { turnId: '1' });
    s.emit('assistant.message', { content: 'For Wednesday 2026-09-23 you have one stop: Tom Becker.' });
    s.emit('assistant.turn_end', { turnId: '1' });
    s.emit('session.idle', {});
    await t.seat.whenIdle(1);
    expect(t.telegram.sent).toEqual(['For Wednesday 2026-09-23 you have one stop: Tom Becker.']);
  });

  it('Stop aborts the reply and says so', async () => {
    const t = setup();
    await t.seat.start();
    await t.seat.handleUpdate(upd({ text: 'write me a long answer' }));
    await t.seat.handleUpdate(upd({ text: 'Stop' }));
    expect(t.session().aborts).toBe(1);
    expect(t.policy.isBusy).toBe(false);
    await t.seat.whenIdle(1);
    expect(t.telegram.sent).toEqual([TEXT.stopped]);
  });

  it('Stop waits for a pending tool to finish before aborting', async () => {
    const t = setup();
    await t.seat.start();
    await t.seat.handleUpdate(upd({ text: 'finished the Hendricks job' }));
    t.policy.onToolPending('call-1');
    const stopping = t.seat.handleUpdate(upd({ text: 'Stop' }));
    await tick();
    expect(t.session().aborts).toBe(0); // waiting for the note to land
    t.session().emit('tool.execution_complete', { toolCallId: 'call-1' });
    await stopping;
    expect(t.session().aborts).toBe(1);
    await t.seat.whenIdle(1);
    expect(t.telegram.sent).toEqual([TEXT.stopped]);
  });

  it('Stop cuts off ask_team_lead at once — the office stops when the seat hangs up', async () => {
    const t = setup();
    await t.seat.start();
    await t.seat.handleUpdate(upd({ text: 'is the office waiting on anything from me?' }));
    t.policy.onToolPending('office-1', 'spine-ask_team_lead');
    await t.seat.handleUpdate(upd({ text: 'Stop' }));
    expect(t.session().aborts).toBe(1);
    await t.seat.whenIdle(1);
    expect(t.telegram.sent).toEqual([TEXT.stopped]);
  });

  it('/new disconnects, opens a fresh conversation and records it', async () => {
    const t = setup();
    await t.seat.start();
    const first = t.session();
    await t.seat.handleUpdate(upd({ text: '/new' }));
    expect(first.disconnected).toBe(true);
    expect(t.sessions).toHaveLength(2);
    expect(t.states.some((s) => s.sessionId === t.session().sessionId)).toBe(true);
    await t.seat.whenIdle(1);
    expect(t.telegram.sent).toEqual([TEXT.fresh]);
  });

  it('sends a photo as bytes with its caption — the saved path never reaches the model', async () => {
    const t = setup();
    await t.seat.start();
    t.telegram.files.set('ph1', Buffer.from('JPEGDATA'));
    await t.seat.handleUpdate(upd({ photo: [{ file_id: 'ph1', width: 800, height: 600 }], caption: 'before' }));
    const sent = t.session().sends[0];
    expect(sent.prompt).toBe('before');
    expect(sent.attachments).toEqual([
      { type: 'blob', data: Buffer.from('JPEGDATA').toString('base64'), mimeType: 'image/jpeg', displayName: 'photo.jpg' },
    ]);
    expect(JSON.stringify(t.session().sends)).not.toContain(STATE_DIR);
  });

  it('sends a voice note as its transcript and counts the transcription toward that reply', async () => {
    const t = setup();
    await t.seat.start();
    await t.seat.handleUpdate(upd({ voice: { file_id: 'v1', mime_type: 'audio/ogg' } }));
    expect(t.session().sends[0].prompt).toBe('[voice note] fan swapped, parts 180');
    t.session().emit('assistant.usage', { apiCallId: 'gen-seat' });
    const [transcribe, seatCall] = t.records;
    expect(transcribe).toMatchObject({ generationId: 'gen-voice', kind: 'transcribe' });
    expect(seatCall).toMatchObject({ generationId: 'gen-seat', kind: 'seat' });
    expect(transcribe.replyId).toBe(seatCall.replyId);
  });

  it('asks for a typed message when a voice note cannot be transcribed', async () => {
    const t = setup({
      transcribe: async () => {
        throw new Error('HTTP 400');
      },
    });
    await t.seat.start();
    await t.seat.handleUpdate(upd({ voice: { file_id: 'v1' } }));
    await t.seat.whenIdle(1);
    expect(t.session().sends).toEqual([]);
    expect(t.telegram.sent).toEqual([TEXT.voiceFailed]);
  });

  it('answers a session error mid-reply once, not with silence', async () => {
    const t = setup();
    await t.seat.start();
    await t.seat.handleUpdate(upd({ text: 'hi' }));
    t.session().emit('session.error', { errorType: 'rate_limit', message: '429' });
    t.session().emit('session.error', { errorType: 'rate_limit', message: '429' });
    t.session().emit('session.idle', {});
    await t.seat.whenIdle(1);
    expect(t.telegram.sent).toEqual([TEXT.replyFailed]);
  });

  it('logs a failed call once even when two events carry its id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'seat-cost-'));
    try {
      const costLog = new CostLog(
        { seat: 's5', tenantId: 't', technicianRef: 'r', stateDir: dir, openrouterKey: 'k' },
        {
          sleep: async () => {},
          delaysMs: [1],
          now: () => new Date('2026-09-22T00:00:00Z'),
          fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: { model: 'google/gemini-3.8-flash', total_cost: 0.001 } }), arrayBuffer: async () => new ArrayBuffer(0) }),
        },
      );
      const t = setup({ costLog });
      await t.seat.start();
      await t.seat.handleUpdate(upd({ text: 'hi' }));
      t.session().emit('model.call_failure', { apiCallId: 'gen-x', statusCode: 400 });
      t.session().emit('assistant.usage', { apiCallId: 'gen-x' });
      await costLog.flush();
      const lines = (await readFile(join(dir, 'costs', '2026-09.jsonl'), 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('carries the reply id into every cost call of that reply', async () => {
    const t = setup();
    await t.seat.start();
    await t.seat.handleUpdate(upd({ text: 'hi' }));
    t.session().emit('assistant.usage', { apiCallId: 'g1' });
    t.session().emit('assistant.usage', { apiCallId: 'g2' });
    t.session().emit('session.idle', {});
    await t.seat.handleUpdate(upd({ text: 'again' }));
    t.session().emit('assistant.usage', { apiCallId: 'g3' });
    const [a, b, c] = t.records;
    expect(a.replyId).toBeTruthy();
    expect(b.replyId).toBe(a.replyId);
    expect(c.replyId).not.toBe(a.replyId);
  });

  it('ignores anyone but the seat person, and answers unsupported messages', async () => {
    const t = setup();
    await t.seat.start();
    await t.seat.handleUpdate(upd({ text: 'hello' }, 123456789));
    await t.seat.handleUpdate(upd({ sticker: { file_id: 's' } }));
    await t.seat.whenIdle(1);
    expect(t.session().sends).toEqual([]);
    expect(t.telegram.sent).toEqual([TEXT.unsupported]);
  });

  it('resumes the recorded conversation on start', async () => {
    const opened: Array<string | null> = [];
    const t = setup({ readState: async () => ({ sessionId: 's5-old', offset: 9 }) });
    const open = t.deps.openSession;
    t.deps.openSession = async (id) => {
      opened.push(id);
      return open(id);
    };
    await t.seat.start();
    expect(opened).toEqual(['s5-old']);
  });

  it('recovers when an abort never produces an idle — the next reply still ends', async () => {
    const t = setup({ abortWaitMs: 20 });
    await t.seat.start();
    t.session().idleOnAbort = false;
    await t.seat.handleUpdate(upd({ text: 'first' }));
    await t.seat.handleUpdate(upd({ text: 'second' })); // abort; no idle; times out
    expect(t.session().sends.map((s) => s.prompt)).toEqual(['first', 'second']);
    t.session().emit('session.idle', {}); // the reply's real end
    expect(t.policy.isBusy).toBe(false);
  });

  it('still sends when the abort call itself fails', async () => {
    const t = setup();
    await t.seat.start();
    t.session().abort = async () => {
      throw new Error('engine gone');
    };
    await t.seat.handleUpdate(upd({ text: 'first' }));
    await t.seat.handleUpdate(upd({ text: 'second' }));
    expect(t.session().sends.map((s) => s.prompt)).toEqual(['first', 'second']);
    t.session().emit('session.idle', {});
    expect(t.policy.isBusy).toBe(false);
  });

  it('ends the reply after a session error that no idle follows', async () => {
    const t = setup({ errorIdleWaitMs: 10 });
    await t.seat.start();
    await t.seat.handleUpdate(upd({ text: 'hi' }));
    t.session().emit('session.error', { errorType: 'quota', message: 'monthly cap' });
    await new Promise((r) => setTimeout(r, 30));
    expect(t.policy.isBusy).toBe(false);
    await t.seat.whenIdle(1);
    expect(t.telegram.sent).toEqual([TEXT.replyFailed]);
  });

  it('/new waits for a pending tool before dropping the conversation', async () => {
    const t = setup();
    await t.seat.start();
    const first = t.session();
    await t.seat.handleUpdate(upd({ text: 'finished the Hendricks job' }));
    t.policy.onToolPending('call-1');
    const fresh = t.seat.handleUpdate(upd({ text: '/new' }));
    await tick();
    expect(first.disconnected).toBe(false);
    expect(first.aborts).toBe(0);
    first.emit('tool.execution_complete', { toolCallId: 'call-1' });
    await fresh;
    expect(first.disconnected).toBe(true);
    expect(t.sessions).toHaveLength(2);
    await t.seat.whenIdle(1);
    expect(t.telegram.sent).toEqual([TEXT.fresh]);
  });

  it('a text sent after /new goes to the NEW conversation, never lost in the old one', async () => {
    const t = setup();
    await t.seat.start();
    const first = t.session();
    await t.seat.handleUpdate(upd({ text: 'file a note for the Hendricks job' }));
    t.policy.onToolPending('call-1');
    // The run loop handles updates one at a time: /new, then the next text.
    const sequence = (async () => {
      await t.seat.handleUpdate(upd({ text: '/new' }));
      await t.seat.handleUpdate(upd({ text: "what's on tomorrow?" }));
    })();
    await tick();
    first.emit('tool.execution_complete', { toolCallId: 'call-1' });
    await sequence;
    expect(first.sends.map((s) => s.prompt)).toEqual(['file a note for the Hendricks job']);
    expect(t.session()).not.toBe(first);
    expect(t.session().sends).toEqual([{ prompt: "what's on tomorrow?" }]);
  });

  it('an idle releases a waiting /new even when no completion named the tool', async () => {
    const t = setup();
    await t.seat.start();
    const first = t.session();
    await t.seat.handleUpdate(upd({ text: 'hi' }));
    t.policy.onToolPending(); // an id-less permission request
    const fresh = t.seat.handleUpdate(upd({ text: '/new' }));
    await tick();
    first.emit('tool.execution_complete', { toolCallId: 'x' }); // does not settle an id-less tool
    await tick();
    expect(first.disconnected).toBe(false);
    first.emit('session.idle', {});
    await fresh;
    expect(first.disconnected).toBe(true);
  });

  it('leaves a reply alone when the loop shows signs of life after an error', async () => {
    const t = setup({ errorIdleWaitMs: 10 });
    await t.seat.start();
    await t.seat.handleUpdate(upd({ text: 'hi' }));
    t.session().emit('session.error', { errorType: 'rate_limit', message: 'retrying' });
    t.session().emit('assistant.turn_start', {});
    await new Promise((r) => setTimeout(r, 30));
    expect(t.policy.isBusy).toBe(true);
  });

  it('says so when /new cannot open a conversation, and recovers on the next text', async () => {
    const t = setup();
    await t.seat.start();
    const open = t.deps.openSession;
    let failNext = true;
    t.deps.openSession = async (id) => {
      if (failNext) {
        failNext = false;
        throw new Error('engine down');
      }
      return open(id);
    };
    await t.seat.handleUpdate(upd({ text: '/new' }));
    await t.seat.whenIdle(1);
    expect(t.telegram.sent).toEqual([TEXT.replyFailed]);
    await t.seat.handleUpdate(upd({ text: 'hello again' }));
    expect(t.session().sends).toEqual([{ prompt: 'hello again' }]);
  });

  it('moves the offset past an update BEFORE handing it to the engine — never twice after a crash', async () => {
    const order: string[] = [];
    const t = setup({ writeState: async (s) => void order.push(`state:${s.offset}`) });
    await t.seat.start();
    const s = t.session();
    const send = s.send.bind(s);
    s.send = async (o) => {
      order.push('send');
      return send(o);
    };
    const u = upd({ text: 'file a note: replaced the capacitor' });
    await t.seat.handleUpdate(u);
    expect(order.slice(-2)).toEqual([`state:${u.update_id + 1}`, 'send']);
  });

  it('answers when a photo cannot be downloaded, instead of going silent', async () => {
    const t = setup();
    await t.seat.start();
    t.telegram.download = async () => {
      throw new Error('telegram: file over 20 MB');
    };
    await t.seat.handleUpdate(upd({ photo: [{ file_id: 'big', width: 1, height: 1 }] }));
    await t.seat.whenIdle(1);
    expect(t.telegram.sent).toEqual([TEXT.replyFailed]);
  });

  it('still delivers a photo when the box copy cannot be kept', async () => {
    const t = setup({
      saveMedia: async () => {
        throw new Error('ENOSPC');
      },
    });
    await t.seat.start();
    await t.seat.handleUpdate(upd({ photo: [{ file_id: 'p', width: 1, height: 1 }], caption: 'after' }));
    expect(t.session().sends[0].prompt).toBe('after');
  });

  it('frees the seat when the send after an abort fails', async () => {
    const t = setup();
    await t.seat.start();
    await t.seat.handleUpdate(upd({ text: 'first' }));
    const s = t.session();
    const send = s.send.bind(s);
    s.send = async (o) => {
      if (o.prompt === 'second') throw new Error('engine rpc blip');
      return send(o);
    };
    await t.seat.handleUpdate(upd({ text: 'second' })); // abort, then the send fails
    expect(t.policy.isBusy).toBe(false);
    await t.seat.whenIdle(1);
    expect(t.telegram.sent).toEqual([TEXT.replyFailed]);
  });

  it('shows a Working line with a Stop button while replying, and removes it when the answer arrives', async () => {
    const t = setup();
    await t.seat.start();
    await t.seat.handleUpdate(upd({ text: "what's on tomorrow?" }));
    expect(t.telegram.working.size).toBe(1);
    const s = t.session();
    s.emit('assistant.turn_start', {});
    s.emit('assistant.message', { content: 'One stop: Tom Becker at 16:00.' });
    s.emit('assistant.turn_end', {});
    s.emit('session.idle', {});
    await t.seat.whenIdle(1);
    expect(t.telegram.working.size).toBe(0);
    expect(t.telegram.sent).toEqual(['One stop: Tom Becker at 16:00.']);
  });

  it('a tap on the Stop button stops the reply, answers the tap and clears the line', async () => {
    const t = setup();
    await t.seat.start();
    await t.seat.handleUpdate(upd({ text: 'write me something long' }));
    const [line] = [...t.telegram.working];
    await t.seat.handleUpdate({
      update_id: ++n,
      callback_query: { id: 'cb1', from: { id: BEN }, data: 'stop', message: { message_id: line, chat: { id: BEN, type: 'private' } } },
    });
    await t.seat.whenIdle(1);
    expect(t.session().aborts).toBe(1);
    expect(t.telegram.callbacks).toEqual([{ id: 'cb1', text: 'Stopping…' }]);
    expect(t.telegram.working.size).toBe(0);
    expect(t.telegram.sent).toEqual([TEXT.stopped]);
  });

  it('a tap on a leftover Working line is answered quietly — nothing to stop', async () => {
    const t = setup();
    await t.seat.start();
    t.telegram.working.add(7);
    await t.seat.handleUpdate({
      update_id: ++n,
      callback_query: { id: 'cb2', from: { id: BEN }, data: 'stop', message: { message_id: 7, chat: { id: BEN, type: 'private' } } },
    });
    await t.seat.whenIdle(1);
    expect(t.telegram.callbacks).toEqual([{ id: 'cb2', text: 'Nothing to stop' }]);
    expect(t.telegram.working.has(7)).toBe(false);
    expect(t.telegram.sent).toEqual([]);
  });

  it('stops polling on a 409 — another poller owns the bot', async () => {
    const t = setup();
    t.telegram.getUpdates = async () => {
      throw new TelegramConflictError();
    };
    await expect(t.seat.run()).rejects.toBeInstanceOf(TelegramConflictError);
  });
});

// ── STEP 3: the office's items (plan 2026-09-23-step-3-office-reaches-glue-seats) ──

const TZ = 'America/Vancouver';
const OID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

class FlakyTelegram extends FakeTelegram {
  failNext = 0;
  async send(chat: number, text: string): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('telegram: sendMessage failed (HTTP 400)');
    }
    return super.send(chat, text);
  }
}

function office(over: Partial<SeatDeps> = {}) {
  let next: InboxResult | Error = { seat: { telegramUserId: String(BEN), timezone: TZ }, items: [] };
  const reports: Array<{ id: string; leg: string; outcome: string; detail?: string }> = [];
  const changed: number[] = [];
  const telegram = new FlakyTelegram();
  let stored: SeatState = { sessionId: null, offset: 0 };
  const t = setup({
    telegram,
    inbox: {
      fetch: async () => {
        if (next instanceof Error) throw next;
        return next;
      },
      report: async (r) => void reports.push(r),
    },
    who: { telegramUserId: BEN, tz: TZ },
    onSeatChanged: (c) => void changed.push(c),
    pollInboxMs: 3_600_000,
    readState: async () => stored,
    writeState: async (st) => {
      stored = JSON.parse(JSON.stringify(st)) as SeatState;
    },
    ...over,
  });
  const serve = (items: InboxItem[], seat = { telegramUserId: String(BEN) as string | null, timezone: TZ }) => {
    next = { seat, items };
  };
  const refuse = (e: Error) => {
    next = e;
  };
  return { ...t, telegram, reports, changed, serve, refuse, stored: () => stored };
}

const phone = (n: number, text: string): InboxItem => ({ id: OID(n), leg: 'phone', text });
const note = (n: number, text: string): InboxItem => ({ id: OID(n), leg: 'note', text });

describe('Seat — office items (step 3)', () => {
  it('texts a phone item once, reports it delivered, and re-acks a second serve without re-sending', async () => {
    const t = office();
    await t.seat.start();
    await tick();
    t.serve([phone(1, 'How did the Smith visit go?')]);
    await t.seat.pollInbox();
    await t.seat.pollInbox(); // Render re-served it: the report was lost
    expect(t.telegram.sent.filter((x) => x === 'How did the Smith visit go?')).toHaveLength(1);
    expect(t.reports).toEqual([
      { id: OID(1), leg: 'phone', outcome: 'delivered' },
      { id: OID(1), leg: 'phone', outcome: 'delivered' },
    ]);
    expect(t.stored().handledIds).toEqual([OID(1)]);
  });

  it('a note is never texted and never starts a model turn', async () => {
    const t = office();
    await t.seat.start();
    await tick();
    t.serve([note(2, 'OFFICE NOTE (from the office record system, not a person): the Smith job is open')]);
    await t.seat.pollInbox();
    expect(t.telegram.sent).toEqual([TEXT.disclosure]);
    expect(t.session().sends).toEqual([]);
    expect(t.reports).toEqual([{ id: OID(2), leg: 'note', outcome: 'delivered' }]);
  });

  it("the person's next message carries both items on top, once, and the list empties", async () => {
    const t = office();
    await t.seat.start();
    await tick();
    t.serve([phone(3, 'What did the parts cost?'), note(4, 'OFFICE NOTE (…): Smith is open to them')]);
    await t.seat.pollInbox();
    await t.seat.handleUpdate(upd({ text: 'about two hundred' }));
    const sent = t.session().sends[0].prompt;
    expect(sent.startsWith('[Since your person last wrote — for you, not from them]')).toBe(true);
    expect(sent).toMatch(/- You texted them \(\d\d:\d\d\): "What did the parts cost\?"/);
    expect(sent).toContain('- OFFICE NOTE (…): Smith is open to them');
    expect(sent.endsWith('[Their message]\nabout two hundred')).toBe(true);
    expect(t.stored().pending).toEqual([]);
    await t.seat.handleUpdate(upd({ text: 'thanks' }));
    expect(t.session().sends.at(-1)?.prompt).toBe('thanks');
  });

  it('the texted time is firm-local, never UTC', async () => {
    const t = office();
    await t.seat.start();
    await tick();
    t.serve([phone(5, 'x')]);
    await t.seat.pollInbox();
    const at = t.stored().pending?.[0].at as string;
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(at));
    await t.seat.handleUpdate(upd({ text: 'ok' }));
    expect(t.session().sends[0].prompt).toContain(`You texted them (${local})`);
  });

  it('a text Telegram rejects is reported failed and never waits for the next message', async () => {
    const t = office();
    await t.seat.start();
    await tick();
    t.telegram.failNext = 1;
    t.serve([phone(6, 'How did it go?')]);
    await t.seat.pollInbox();
    expect(t.reports).toEqual([{ id: OID(6), leg: 'phone', outcome: 'failed', detail: 'telegram send failed' }]);
    expect(t.stored().pending ?? []).toEqual([]);
    expect(t.stored().handledIds ?? []).toEqual([]);
  });

  it('items stay waiting when the engine send fails', async () => {
    const t = office();
    await t.seat.start();
    await tick();
    t.serve([note(7, 'OFFICE NOTE (…): hold the Jones job')]);
    await t.seat.pollInbox();
    t.session().send = async () => {
      throw new Error('engine down');
    };
    await t.seat.handleUpdate(upd({ text: 'what is next?' }));
    expect(t.stored().pending?.map((p) => p.id)).toEqual([OID(7)]);
  });

  it('abort-then-send carries the block exactly once', async () => {
    const t = office();
    await t.seat.start();
    await tick();
    await t.seat.handleUpdate(upd({ text: 'finished the Hendricks job' }));
    t.serve([phone(8, 'Was the part in stock?')]);
    await t.seat.pollInbox();
    await t.seat.handleUpdate(upd({ text: 'parts were $180' })); // mid-answer: abort, then send
    const last = t.session().sends.at(-1)?.prompt ?? '';
    expect(last.split('[Since your person last wrote').length - 1).toBe(1);
    expect(last.endsWith('[Their message]\nparts were $180')).toBe(true);
  });

  it('the office notice goes out once across restarts, and is not marked sent when Telegram rejects it', async () => {
    const t = office();
    t.telegram.failNext = 1;
    await t.seat.start();
    expect(t.stored().disclosed ?? false).toBe(false);
    t.seat.stop();
    const again = new Seat(t.deps);
    await again.start();
    again.stop();
    const third = new Seat(t.deps);
    await third.start();
    third.stop();
    expect(t.telegram.sent.filter((x) => x === TEXT.disclosure)).toHaveLength(1);
    expect(t.stored().disclosed).toBe(true);
  });

  it('the seat changed: a rebind or timezone restarts (0); deactivated or unbound stops (4); a refused token restarts (1)', async () => {
    const t = office();
    await t.seat.start();
    await tick();
    t.serve([], { telegramUserId: '999', timezone: TZ });
    await t.seat.pollInbox();
    t.serve([], { telegramUserId: String(BEN), timezone: 'Europe/London' });
    await t.seat.pollInbox();
    t.serve([], { telegramUserId: null, timezone: TZ });
    await t.seat.pollInbox();
    t.refuse(new InboxRefused(403));
    await t.seat.pollInbox();
    t.refuse(new InboxRefused(401));
    await t.seat.pollInbox();
    expect(t.changed).toEqual([0, 0, 4, 4, 1]);
    // A network blip is none of these.
    t.refuse(new Error('fetch failed'));
    await t.seat.pollInbox();
    expect(t.changed).toHaveLength(5);
  });

  it('a poll landing mid-update loses neither the offset nor the waiting item', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const t = office({
      transcribe: async () => {
        await gate; // the voice note is still being transcribed
        return { text: 'done at the Smiths', generationId: null };
      },
    });
    await t.seat.start();
    await tick();
    const update = upd({ voice: { file_id: 'v1', mime_type: 'audio/ogg' } });
    const handling = t.seat.handleUpdate(update);
    await tick();
    t.serve([note(9, 'OFFICE NOTE (…): Smith is closed')]);
    await t.seat.pollInbox();
    release();
    await handling;
    expect(t.stored().offset).toBe(update.update_id + 1);
    expect(t.stored().handledIds).toEqual([OID(9)]);
  });

  it('with no inbox wired (tests, the local driver) nothing office-related happens', async () => {
    const t = setup();
    await t.seat.start();
    await t.seat.pollInbox();
    expect(t.telegram.sent).toEqual([]);
  });

  it('settle() waits for a pull in flight and its state write', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let stored: SeatState = { sessionId: null, offset: 0 };
    const t = office({
      writeState: async (st) => {
        if (st.handledIds?.length) await gate;
        stored = JSON.parse(JSON.stringify(st)) as SeatState;
      },
    });
    await t.seat.start();
    await tick();
    t.serve([phone(10, 'Is the van back?')]);
    const poll = t.seat.pollInbox();
    await tick();
    let settled = false;
    const done = t.seat.settle(1).then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    release();
    await done;
    await poll;
    expect(stored.handledIds).toEqual([OID(10)]);
  });
});

describe('Seat — the conversation for the office (step 3)', () => {
  function recorder() {
    const turns: Array<[string, string | undefined, unknown?]> = [];
    let flushes = 0;
    const transcript = {
      person: (text: string) => void turns.push(['person', text]),
      assistant: (text: string) => void turns.push(['assistant', text]),
      toolStart: (_id: string, tool: string, args: unknown) => void turns.push(['tool', tool, args]),
      toolDone: (id: string, ok: boolean) => void turns.push(['done', id, ok]),
      settleOpenTools: () => void turns.push(['settle', undefined]),
      flush: async () => {
        flushes += 1;
      },
    };
    return { transcript, turns, flushes: () => flushes };
  }

  it("records the person's words, the spine tool call and the reply — never the office block", async () => {
    const r = recorder();
    const t = office({ transcript: r.transcript });
    await t.seat.start();
    await tick();
    t.serve([note(20, 'OFFICE NOTE (…): Smith is open to them')]);
    await t.seat.pollInbox();
    await t.seat.handleUpdate(upd({ text: 'fan swapped at the Smiths' }));
    // The engine names the server; SPINE_NAMES holds server names.
    t.session().emit('tool.execution_start', {
      toolCallId: 'c1',
      toolName: 'spine-record_field_note',
      mcpServerName: 'spine',
      mcpToolName: 'record_field_note',
      arguments: { jobId: 'j1' },
    });
    // Not a spine tool: never recorded.
    t.session().emit('tool.execution_start', { toolCallId: 'c2', toolName: 'view', mcpServerName: 'other' });
    t.session().emit('tool.execution_complete', { toolCallId: 'c1', success: true });
    t.session().emit('assistant.message', { content: 'Got that recorded.' });
    t.session().emit('session.idle', {});
    await t.seat.whenIdle(1);
    expect(r.turns).toEqual([
      ['person', 'fan swapped at the Smiths'],
      ['tool', 'record_field_note', { jobId: 'j1' }],
      ['done', 'c1', true],
      ['assistant', 'Got that recorded.'],
      ['settle', undefined],
    ]);
    expect(r.flushes()).toBeGreaterThan(0);
  });

  it('a double text records each message once, even when it aborts and resends', async () => {
    const r = recorder();
    const t = office({ transcript: r.transcript });
    await t.seat.start();
    await tick();
    await t.seat.handleUpdate(upd({ text: 'finished the Hendricks job' }));
    await t.seat.handleUpdate(upd({ text: 'parts were $180' }));
    expect(r.turns.filter(([k]) => k === 'person')).toEqual([
      ['person', 'finished the Hendricks job'],
      ['person', 'parts were $180'],
    ]);
  });

  it('a voice note is recorded as its transcript; a photo as its caption, never bytes', async () => {
    const r = recorder();
    const t = office({ transcript: r.transcript });
    await t.seat.start();
    await tick();
    await t.seat.handleUpdate(upd({ voice: { file_id: 'v', mime_type: 'audio/ogg' } }));
    await t.seat.handleUpdate(upd({ photo: [{ file_id: 'p', width: 10, height: 10 }] }));
    expect(r.turns.filter(([k]) => k === 'person')).toEqual([
      ['person', '[voice note] fan swapped, parts 180'],
      ['person', '(photo)'],
    ]);
  });

  it('a long office question keeps the reply id at its end when it waits for the next message', async () => {
    const t = office();
    await t.seat.start();
    await tick();
    const id = OID(30);
    const long = `OFFICE QUESTION (from the office record system, not a person): ${'x'.repeat(2000)} — reply via inform_team_lead and mention this id: ${id}`;
    t.serve([{ id, leg: 'note', text: long }]);
    await t.seat.pollInbox();
    await t.seat.handleUpdate(upd({ text: 'ok' }));
    expect(t.session().sends[0].prompt).toContain(`mention this id: ${id}`);
  });

  it('a reply ended by an error with no idle closes its open tool turns', async () => {
    let settled = 0;
    const t = office({
      errorIdleWaitMs: 5,
      transcript: {
        person: () => {},
        assistant: () => {},
        toolStart: () => {},
        toolDone: () => {},
        settleOpenTools: () => {
          settled += 1;
        },
        flush: async () => {},
      },
    });
    await t.seat.start();
    await tick();
    await t.seat.handleUpdate(upd({ text: 'file it' }));
    t.session().emit('session.error', { errorType: 'rate_limit', message: '429' });
    await new Promise((r) => setTimeout(r, 30));
    expect(t.policy.isBusy).toBe(false);
    expect(settled).toBe(1);
  });
});
