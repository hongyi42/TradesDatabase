import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// A manager's own computer (step 2b, plan 2026-09-28-step-2b-manager-files-
// sandbox-skills): ONE E2B sandbox per manager seat, created on first use and
// then woken by id. It PAUSES after an idle timeout — files, memory and running
// processes kept, unbilled, kept indefinitely (docs.e2b.dev/sandbox/persistence;
// gate-tested 2026-09-27: woke in 0.53 s, files byte-identical, a job frozen
// mid-run finished). E2B's DEFAULT is to kill on timeout, so the lifecycle is
// set on every create, never left to the default.
//
// No internet inside (operator 2026-09-28, 2A): model-written code runs here,
// and with no way out it cannot post the firm's data anywhere. The libraries
// are baked into our template instead (Box_Setup_Stuff/seat-glue/e2b-template.mjs).
//
// Loaded like the Copilot SDK (engine.ts): a NON-LITERAL specifier from the box
// package's node_modules, typed by the small interfaces below (checked by hand
// against e2b 2.51.0's index.d.ts). The key is passed explicitly on every call —
// the SDK would otherwise fall back to process.env.

const E2B_SPECIFIER: string = 'e2b';

export const IDLE_MS = 10 * 60_000;
export const FILES_DIR = '/home/user/files';
export const SKILLS_DIR = '/home/user/skills';
const STATE_FILE = 'sandbox.json';

export interface CommandResultLike {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export interface CommandHandleLike {
  pid: number;
  wait(): Promise<CommandResultLike>;
}
export interface E2bSandboxLike {
  sandboxId: string;
  setTimeout(timeoutMs: number): Promise<void>;
  commands: {
    run(cmd: string, opts: { cwd?: string; timeoutMs?: number; background: true }): Promise<CommandHandleLike>;
    run(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<CommandResultLike>;
    kill(pid: number): Promise<boolean>;
  };
  files: {
    read(path: string, opts: { format: 'bytes' }): Promise<Uint8Array>;
    read(path: string): Promise<string>;
    write(path: string, data: string | ArrayBuffer): Promise<unknown>;
  };
}
export interface E2bModuleLike {
  Sandbox: {
    create(template: string, opts: Record<string, unknown>): Promise<E2bSandboxLike>;
    connect(sandboxId: string, opts: Record<string, unknown>): Promise<E2bSandboxLike>;
  };
}

interface Stored {
  sandboxId: string;
  createdAt: string;
  template: string;
}

export interface ManagerSandboxOptions {
  apiKey: string;
  template: string;
  stateDir: string;
  meta: { seat: string; tenantId: string; technicianRef: string };
  /** Tests hand in a fake; the box loads the real SDK. */
  sdk?: E2bModuleLike;
  log?: (msg: string) => void;
}

/** A not-found error from connect: the sandbox was killed or never existed. */
export function isNotFound(err: unknown): boolean {
  const e = err as { name?: unknown; message?: unknown; status?: unknown } | null;
  if (!e) return false;
  return (
    (typeof e.name === 'string' && /NotFound/.test(e.name)) ||
    e.status === 404 ||
    (typeof e.message === 'string' && /not found|404/i.test(e.message))
  );
}

export class ManagerSandbox {
  private opening: Promise<{ sbx: E2bSandboxLike; fresh: boolean }> | null = null;
  /** When the longest hold asked for so far runs out (ms since epoch). */
  private holdUntil = 0;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: ManagerSandboxOptions) {
    this.log = opts.log ?? ((m) => console.log(`seat-glue: ${m}`));
  }

  /**
   * The manager's sandbox, awake, with its idle timer set to at least `holdMs`
   * (a long command must never pause mid-run). `fresh` = it was created just now
   * although one was on record: the manager's earlier files are gone.
   */
  async get(holdMs = IDLE_MS): Promise<{ sbx: E2bSandboxLike; fresh: boolean }> {
    // One open at a time: two tools called together share it.
    this.opening ??= this.open().finally(() => {
      this.opening = null;
    });
    const got = await this.opening;
    // E2B's setTimeout can SHORTEN the timer too: a quick read during a long
    // command must never cut that command's hold back to 10 minutes (review).
    const now = Date.now();
    this.holdUntil = Math.max(this.holdUntil, now + holdMs);
    await got.sbx.setTimeout(Math.max(IDLE_MS, this.holdUntil - now));
    return got;
  }

  private async sdk(): Promise<E2bModuleLike> {
    return this.opts.sdk ?? ((await import(E2B_SPECIFIER)) as E2bModuleLike);
  }

  private async open(): Promise<{ sbx: E2bSandboxLike; fresh: boolean }> {
    const { Sandbox } = await this.sdk();
    const stored = await this.readStored();
    if (stored) {
      try {
        return { sbx: await Sandbox.connect(stored.sandboxId, { apiKey: this.opts.apiKey }), fresh: false };
      } catch (err) {
        if (!isNotFound(err)) throw err;
        this.log(`sandbox ${stored.sandboxId} is gone — creating a new one`);
      }
    }
    const sbx = await Sandbox.create(this.opts.template, {
      apiKey: this.opts.apiKey,
      timeoutMs: IDLE_MS,
      lifecycle: { onTimeout: 'pause', autoResume: true },
      allowInternetAccess: false,
      metadata: { seat: this.opts.meta.seat, tenant: this.opts.meta.tenantId, person: this.opts.meta.technicianRef },
    });
    await sbx.commands.run(`mkdir -p ${FILES_DIR}`);
    await this.writeStored({ sandboxId: sbx.sandboxId, createdAt: new Date().toISOString(), template: this.opts.template });
    this.log(`sandbox ${sbx.sandboxId} created from ${this.opts.template}`);
    return { sbx, fresh: stored !== null };
  }

  private async readStored(): Promise<Stored | null> {
    try {
      const raw = JSON.parse(await readFile(join(this.opts.stateDir, STATE_FILE), 'utf8')) as Partial<Stored>;
      return typeof raw.sandboxId === 'string' && raw.sandboxId ? (raw as Stored) : null;
    } catch {
      return null;
    }
  }

  private async writeStored(s: Stored): Promise<void> {
    const file = join(this.opts.stateDir, STATE_FILE);
    await writeFile(`${file}.tmp`, JSON.stringify(s, null, 2), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
}
