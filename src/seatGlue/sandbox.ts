import { createHash } from 'node:crypto';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

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
    getInfo(path: string): Promise<{ size: number }>;
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
  /** The skill folders on the box; copied into SKILLS_DIR whenever they change. */
  skillsDir?: string;
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
  /** Each sandbox's skills check, shared: two tools at once never copy over each other. */
  private readonly skillsSync = new Map<string, Promise<void>>();
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
    // One check per sandbox per process, shared by concurrent calls; a failed
    // one is forgotten so the next call tries again.
    let sync = this.skillsSync.get(got.sbx.sandboxId);
    if (!sync) {
      sync = this.syncSkills(got.sbx).catch((err: unknown) => {
        this.skillsSync.delete(got.sbx.sandboxId);
        this.log(`could not copy skills: ${err instanceof Error ? err.message : String(err)}`);
      });
      this.skillsSync.set(got.sbx.sandboxId, sync);
    }
    await sync;
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

  /**
   * Copy the skill folders into the sandbox when they differ from what is there
   * (a fingerprint in SKILLS_DIR/.hash): once per sandbox per process. A missing
   * folder on the box is not an error — the seat just has no skills to copy.
   */
  private async syncSkills(sbx: E2bSandboxLike): Promise<void> {
    const dir = this.opts.skillsDir;
    if (!dir) return;
    const files = await listFiles(dir).catch(() => [] as string[]);
    if (!files.length) return;
    const contents = await Promise.all(files.map(async (f) => ({ rel: relative(dir, f), data: await readFile(f) })));
    const hash = createHash('sha256');
    for (const c of contents) hash.update(c.rel).update('\0').update(c.data).update('\0');
    const want = hash.digest('hex');
    const have = await sbx.commands.run(`cat ${SKILLS_DIR}/.hash 2>/dev/null || true`).catch(() => null);
    if (have?.stdout.trim() !== want) {
      await sbx.commands.run(`rm -rf ${SKILLS_DIR} && mkdir -p ${SKILLS_DIR}`);
      for (const c of contents) {
        // The bytes, not text: a binary file (a template, a font) must arrive intact.
        const bytes = c.data.buffer.slice(c.data.byteOffset, c.data.byteOffset + c.data.byteLength) as ArrayBuffer;
        await sbx.files.write(`${SKILLS_DIR}/${c.rel.split('\\').join('/')}`, bytes);
      }
      await sbx.files.write(`${SKILLS_DIR}/.hash`, want);
      this.log(`skills copied into sandbox ${sbx.sandboxId} (${contents.length} files)`);
    }
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

/** Every file under a folder, sorted, so the fingerprint is stable. */
async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(full)));
    else if (e.isFile()) out.push(full);
  }
  return out.sort();
}
