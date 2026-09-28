import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FILES_DIR, IDLE_MS, ManagerSandbox, isNotFound, type E2bModuleLike, type E2bSandboxLike } from './sandbox.js';

class NotFound extends Error {
  name = 'SandboxNotFoundError';
}

function fakeSdk() {
  const calls: Array<{ op: string; arg: unknown; opts?: Record<string, unknown> }> = [];
  const alive = new Set<string>();
  const timeouts: number[] = [];
  let n = 0;
  const make = (id: string): E2bSandboxLike =>
    ({
      sandboxId: id,
      setTimeout: async (ms: number) => void timeouts.push(ms),
      commands: {
        run: async (cmd: string) => {
          calls.push({ op: 'run', arg: cmd });
          return { exitCode: 0, stdout: '', stderr: '' };
        },
        kill: async () => true,
      },
      files: { read: async () => '', write: async () => undefined },
    }) as unknown as E2bSandboxLike;
  const sdk: E2bModuleLike = {
    Sandbox: {
      create: async (template, opts) => {
        calls.push({ op: 'create', arg: template, opts });
        const id = `sbx${++n}`;
        alive.add(id);
        return make(id);
      },
      connect: async (id, opts) => {
        calls.push({ op: 'connect', arg: id, opts });
        await new Promise((r) => setTimeout(r, 5));
        if (!alive.has(id)) throw new NotFound(`sandbox ${id} not found`);
        return make(id);
      },
    },
  };
  return { sdk, calls, alive, timeouts };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sbx-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const open = (sdk: E2bModuleLike) =>
  new ManagerSandbox({
    apiKey: 'e2b_key',
    template: 'trades-manager',
    stateDir: dir,
    meta: { seat: 's2', tenantId: 't1', technicianRef: 'manager-sam' },
    sdk,
    log: () => {},
  });

describe('ManagerSandbox', () => {
  it('first use creates one: paused on idle, auto-resumed, NO internet, our template, labelled, key explicit', async () => {
    const f = fakeSdk();
    const { sbx, fresh } = await open(f.sdk).get();
    expect(fresh).toBe(false);
    const create = f.calls.find((c) => c.op === 'create')!;
    expect(create.arg).toBe('trades-manager');
    expect(create.opts).toEqual({
      apiKey: 'e2b_key',
      timeoutMs: IDLE_MS,
      lifecycle: { onTimeout: 'pause', autoResume: true },
      allowInternetAccess: false,
      metadata: { seat: 's2', tenant: 't1', person: 'manager-sam' },
    });
    expect(f.calls).toContainEqual({ op: 'run', arg: `mkdir -p ${FILES_DIR}` });
    expect(JSON.parse(await readFile(join(dir, 'sandbox.json'), 'utf8'))).toMatchObject({ sandboxId: sbx.sandboxId, template: 'trades-manager' });
    expect(f.timeouts.at(-1)).toBe(IDLE_MS);
  });

  it('a later process wakes the SAME sandbox by id, with the key, and re-arms the timer (longer when asked)', async () => {
    const f = fakeSdk();
    const first = await open(f.sdk).get();
    const again = await open(f.sdk).get(30 * 60_000);
    expect(again.sbx.sandboxId).toBe(first.sbx.sandboxId);
    expect(again.fresh).toBe(false);
    expect(f.calls.filter((c) => c.op === 'create')).toHaveLength(1);
    expect(f.calls.find((c) => c.op === 'connect')!.opts).toEqual({ apiKey: 'e2b_key' });
    expect(f.timeouts.at(-1)).toBe(30 * 60_000);
  });

  it('a plain reconnect re-arms 10 minutes; a quick call never shortens a long hold', async () => {
    const f = fakeSdk();
    const box = open(f.sdk);
    await box.get();
    expect(f.timeouts.at(-1)).toBe(IDLE_MS);
    await box.get(35 * 60_000);
    expect(f.timeouts.at(-1)).toBe(35 * 60_000);
    await box.get(); // a read during that long command
    expect(f.timeouts.at(-1)).toBeGreaterThan(34 * 60_000);
  });

  it('sandbox.json is written owner-only', async () => {
    const f = fakeSdk();
    await open(f.sdk).get();
    const { mode } = await stat(join(dir, 'sandbox.json'));
    expect(mode & 0o777).toBe(0o600);
  });

  it('a vanished sandbox is replaced, and `fresh` says the earlier files are gone', async () => {
    const f = fakeSdk();
    const first = await open(f.sdk).get();
    f.alive.delete(first.sbx.sandboxId);
    const again = await open(f.sdk).get();
    expect(again.sbx.sandboxId).not.toBe(first.sbx.sandboxId);
    expect(again.fresh).toBe(true);
  });

  it('any other connect failure is thrown, never papered over with a new sandbox', async () => {
    const f = fakeSdk();
    await open(f.sdk).get();
    f.sdk.Sandbox.connect = async () => {
      throw new Error('503 service unavailable');
    };
    await expect(open(f.sdk).get()).rejects.toThrow(/503/);
    expect(f.calls.filter((c) => c.op === 'create')).toHaveLength(1);
  });

  it('two tools at once open it once', async () => {
    const f = fakeSdk();
    await writeFile(join(dir, 'sandbox.json'), JSON.stringify({ sandboxId: 'sbx9', createdAt: 'x', template: 't' }));
    f.alive.add('sbx9');
    const box = open(f.sdk);
    const [a, b] = await Promise.all([box.get(), box.get()]);
    expect(a.sbx.sandboxId).toBe('sbx9');
    expect(b.sbx.sandboxId).toBe('sbx9');
    expect(f.calls.filter((c) => c.op === 'connect')).toHaveLength(1);
  });

  it('isNotFound knows the SDK error, a 404 and the message', () => {
    expect(isNotFound(new NotFound('x'))).toBe(true);
    expect(isNotFound({ status: 404 })).toBe(true);
    expect(isNotFound(new Error('Sandbox abc not found'))).toBe(true);
    expect(isNotFound(new Error('timeout'))).toBe(false);
  });

  it('skills are copied in once, and again only when the folder changes', async () => {
    const f = fakeSdk();
    const written: string[] = [];
    let remote = '';
    const skills = join(dir, 'skills');
    await mkdir(join(skills, 'spreadsheet'), { recursive: true });
    await writeFile(join(skills, 'spreadsheet', 'SKILL.md'), '# v1');
    await writeFile(join(skills, 'spreadsheet', 'x.py'), 'print(1)');
    const make = () =>
      new ManagerSandbox({
        apiKey: 'k',
        template: 't',
        stateDir: dir,
        meta: { seat: 's2', tenantId: 't1', technicianRef: 'm' },
        skillsDir: skills,
        log: () => {},
        sdk: {
          Sandbox: {
            create: async (tpl, o) => wrap(await f.sdk.Sandbox.create(tpl, o)),
            connect: async (id, o) => wrap(await f.sdk.Sandbox.connect(id, o)),
          },
        },
      });
    const wrap = (sbx: E2bSandboxLike): E2bSandboxLike =>
      ({
        ...sbx,
        commands: {
          ...sbx.commands,
          run: async (cmd: string) => ({ exitCode: 0, stdout: cmd.startsWith('cat /home/user/skills/.hash') ? remote : '', stderr: '' }),
        },
        files: {
          ...sbx.files,
          write: async (path: string, data: string) => {
            written.push(path);
            if (path.endsWith('/.hash')) remote = data;
          },
        },
      }) as unknown as E2bSandboxLike;
    await make().get();
    expect(written.sort()).toEqual(['/home/user/skills/.hash', '/home/user/skills/spreadsheet/SKILL.md', '/home/user/skills/spreadsheet/x.py']);
    written.length = 0;
    await make().get(); // a new process, same folder: nothing copied
    expect(written).toEqual([]);
    await writeFile(join(skills, 'spreadsheet', 'SKILL.md'), '# v2');
    await make().get();
    expect(written).toContain('/home/user/skills/spreadsheet/SKILL.md');
    // Two tools at once in a NEW process: one copy, not two racing each other.
    await writeFile(join(skills, 'spreadsheet', 'SKILL.md'), '# v3');
    written.length = 0;
    const box = make();
    await Promise.all([box.get(), box.get()]);
    expect(written.filter((w) => w.endsWith('SKILL.md'))).toHaveLength(1);
  });

  it('skill files are written as bytes, so a binary one arrives intact', async () => {
    const f = fakeSdk();
    const got: Array<{ path: string; data: unknown }> = [];
    const skills = join(dir, 'skills');
    await mkdir(join(skills, 'tpl'), { recursive: true });
    await writeFile(join(skills, 'tpl', 'blank.xlsx'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]));
    const box = new ManagerSandbox({
      apiKey: 'k',
      template: 't',
      stateDir: dir,
      meta: { seat: 's', tenantId: 't', technicianRef: 'm' },
      skillsDir: skills,
      log: () => {},
      sdk: {
        Sandbox: {
          create: async (tpl, o) => {
            const sbx = await f.sdk.Sandbox.create(tpl, o);
            return { ...sbx, files: { ...sbx.files, write: async (path: string, data: unknown) => void got.push({ path, data }) } } as unknown as E2bSandboxLike;
          },
          connect: f.sdk.Sandbox.connect,
        },
      },
    });
    await box.get();
    const xlsx = got.find((g) => g.path.endsWith('blank.xlsx'))!;
    expect(new Uint8Array(xlsx.data as ArrayBuffer)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]));
  });
});

