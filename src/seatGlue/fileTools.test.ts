import { describe, expect, it } from 'vitest';
import { ExportError, FILE_TOOL_NAMES, READ_MAX_BYTES, SHARE_MAX_BYTES, STREAM_TAIL, fileTools, resolvePath, safeName, type ExportResult, type FileTool } from './fileTools.js';
import type { E2bSandboxLike } from './sandbox.js';

function fakeBox(opts: { fresh?: boolean; exit?: { code: number; out?: string; err?: string }; hang?: boolean; timeout?: boolean; dropped?: boolean; noCode?: boolean; openFails?: boolean } = {}) {
  const files = new Map<string, Uint8Array>();
  const killed: number[] = [];
  const runs: Array<{ cmd: string; opts: unknown }> = [];
  const holds: Array<number | undefined> = [];
  const reads: string[] = [];
  let release: () => void = () => {};
  const enc = (t: string) => new TextEncoder().encode(t);
  const dec = (b: Uint8Array) => new TextDecoder().decode(b);
  const sbx = {
    sandboxId: 'sbx1',
    setTimeout: async () => {},
    commands: {
      run: async (cmd: string, o?: { background?: boolean }) => {
        runs.push({ cmd, opts: o });
        if (o?.background) {
          // setsid … 'echo $$ > PGID; bash SCRIPT; echo $? > CODE' > OUT 2> ERR:
          // the "process" writes its output files, and its code when it ends.
          const m = /> (\S+); bash \S+; echo \$\? > (\S+)' > (\S+) 2> (\S+)$/.exec(cmd)!;
          const [, pgid, codeFile, outFile, errFile] = m;
          files.set(pgid, enc('4242'));
          files.set(outFile, enc(opts.exit?.out ?? 'ok'));
          files.set(errFile, enc(opts.exit?.err ?? ''));
          return {
            pid: 77,
            wait: () =>
              new Promise((resolve, reject) => {
                const dead = () => reject(Object.assign(new Error('killed'), { exitCode: 137 }));
                if (opts.hang && killed.length) return void dead(); // killed before anyone waited
                if (opts.hang) return void (release = dead);
                if (opts.timeout) return void reject(Object.assign(new Error('deadline exceeded'), { name: 'TimeoutError' }));
                if (opts.dropped) return void reject(Object.assign(new Error('connect ETIMEDOUT 34.1.2.3:443'), { name: 'Error' }));
                if (!opts.noCode) files.set(codeFile, enc(`${opts.exit?.code ?? 0}\n`));
                resolve({ exitCode: 0, stdout: '', stderr: '' }); // the wrapper always exits 0
              }),
          };
        }
        const t = /^wc -c < (\S+); tail -c (\d+) \S+$/.exec(cmd);
        if (t) {
          const b = files.get(t[1]) ?? new Uint8Array();
          return { exitCode: 0, stdout: `${b.length}\n${dec(b.slice(-Number(t[2])))}`, stderr: '' };
        }
        const c = /^cat (\S+\.code) 2>\/dev\/null$/.exec(cmd);
        if (c) return { exitCode: 0, stdout: files.has(c[1]) ? dec(files.get(c[1])!) : '', stderr: '' };
        const nul = /^head -c 8192 '(.+)' \| tr -dc '\\000' \| wc -c$/.exec(cmd);
        if (nul) return { exitCode: 0, stdout: `${files.get(nul[1])!.subarray(0, 8192).filter((x) => x === 0).length}\n`, stderr: '' };
        const h = /^head -c (\d+) '(.+)'$/.exec(cmd);
        if (h) return { exitCode: 0, stdout: dec(files.get(h[2])!).slice(0, Number(h[1])), stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      kill: async (pid: number) => {
        killed.push(pid);
        release();
        return true;
      },
    },
    files: {
      read: async (path: string, o?: { format: 'bytes' }) => {
        reads.push(path);
        const b = files.get(path);
        if (!b) throw new Error(`file not found: ${path}`);
        return o?.format === 'bytes' ? b : dec(b);
      },
      write: async (path: string, data: string) => void files.set(path, enc(data)),
      getInfo: async (path: string) => {
        const b = files.get(path);
        if (!b) throw new Error(`file not found: ${path}`);
        return { size: b.length };
      },
    },
  } as unknown as E2bSandboxLike;
  const sent: Array<{ name: string; bytes: Uint8Array; caption?: string }> = [];
  let exported: ExportResult = { csv: 'id,name\r\n1,Acme\r\n2,Chen\r\n', columns: ['id', 'name'], rowCount: 2, truncated: false };
  let exportFails: Error | null = null;
  const set = fileTools({
    sandbox: {
      get: async (holdMs?: number) => {
        holds.push(holdMs);
        if (opts.openFails) throw new Error('E2B 503');
        return { sbx, fresh: opts.fresh ?? false };
      },
    },
    exportRows: async () => {
      if (exportFails) throw exportFails;
      return exported;
    },
    sendDocument: async (name, bytes, caption) => void sent.push({ name, bytes, caption }),
  });
  const tools = set.tools;
  const tool = (n: string) => tools.find((t) => t.name === n) as FileTool;
  return {
    set,
    tools,
    tool,
    files,
    killed,
    runs,
    holds,
    reads,
    sent,
    setExport: (e: ExportResult) => (exported = e),
    failExport: (e: Error) => (exportFails = e),
  };
}

describe('fileTools', () => {
  it('are the five named tools the permission handler admits', () => {
    expect(fakeBox().tools.map((t) => t.name).sort()).toEqual([...FILE_TOOL_NAMES].sort());
  });

  it('paths resolve under /home/user only; export names lose folders', () => {
    expect(resolvePath('report.xlsx')).toBe('/home/user/files/report.xlsx');
    expect(resolvePath('/home/user/skills/x.py')).toBe('/home/user/skills/x.py');
    expect(resolvePath('/home/user/../etc/passwd')).toBeNull();
    expect(resolvePath('../../etc/passwd')).toBeNull();
    expect(safeName('../skills/x')).toBe('skillsx');
    expect(safeName('open jobs.csv')).toBe('openjobs');
    expect(safeName('...')).toBe('export');
  });

  it('run_command runs the command as a script, holds the sandbox for it + 5 min, and returns the tails', async () => {
    const b = fakeBox({ exit: { code: 0, out: 'built' } });
    const out = await b.tool('run_command').handler({ command: 'python3 build.py', timeoutSeconds: 300 }, {});
    expect(out).toMatch(/^exit code 0\n--- stdout ---\nbuilt/);
    expect(b.holds[0]).toBe(300_000 + 5 * 60_000);
    const bg = b.runs.find((r) => (r.opts as { background?: boolean } | undefined)?.background)!;
    // Its own process group, so a kill takes every child with it; its own exit code in a file.
    expect(bg.cmd).toMatch(
      /^setsid --wait bash -c 'echo \$\$ > \/tmp\/run-\S+\.pgid; bash \/tmp\/run-\S+\.sh; echo \$\? > \/tmp\/run-\S+\.code' > \/tmp\/run-\S+\.out 2> \/tmp\/run-\S+\.err$/,
    );
    expect(bg.opts).toEqual({ cwd: '/home/user/files', timeoutMs: 300_000, background: true });
    expect(b.runs.at(-1)!.cmd).toMatch(/^rm -f /);
  });

  it('a non-zero exit is a RESULT with its code, never a throw', async () => {
    const b = fakeBox({ exit: { code: 1, err: 'Traceback: KeyError' } });
    const out = await b.tool('run_command').handler({ command: 'python3 bad.py' }, {});
    expect(out).toMatch(/^exit code 1/);
    expect(out).toContain('KeyError');
  });

  it('huge output: the exit code still comes first, each stream is cut to its tail', async () => {
    const b = fakeBox({ exit: { code: 3, out: 'x'.repeat(100_000) } });
    const out = await b.tool('run_command').handler({ command: 'yes' }, {});
    expect(out).toMatch(/^exit code 3\n--- stdout \(last 9000 of 100000 bytes\) ---/);
    expect(out.length).toBeLessThan(STREAM_TAIL + 500);
  });

  it('non-ASCII output is not labelled cut: bytes are compared with bytes', async () => {
    const b = fakeBox({ exit: { code: 0, out: 'Zoë Müller ✓' } });
    const out = await b.tool('run_command').handler({ command: 'python3 names.py' }, {});
    expect(out).toContain('--- stdout ---\nZoë Müller ✓');
  });

  it('a command that reported no exit code says so rather than guess', async () => {
    const b = fakeBox({ noCode: true });
    expect(await b.tool('run_command').handler({ command: 'x' }, {})).toMatch(/^exit code unknown/);
  });

  it("a dropped connection (even one that says ETIMEDOUT) is said as one, not as a timeout; the command is still killed", async () => {
    const b = fakeBox({ dropped: true });
    const out = await b.tool('run_command').handler({ command: 'python3 x.py' }, {});
    expect(out).toMatch(/^The connection to your computer was lost/);
    expect(b.killed).toEqual([77]);
  });

  it('a Stop kills the process group — also when the call was already aborted before it started', async () => {
    const b = fakeBox({ hang: true });
    const ctl = new AbortController();
    const running = b.tool('run_command').handler({ command: 'sleep 999' }, { signal: ctl.signal });
    await new Promise((r) => setTimeout(r, 5));
    ctl.abort();
    expect(await running).toMatch(/^Stopped by the manager/);
    expect(b.killed).toEqual([77]);
    // The group kill waits for the pgid file, so a Stop in the first instant still finds the group.
    expect(b.runs.some((r) => /^for i in \$\(seq 1 30\); do \[ -s \S+\.pgid \] && break; sleep 0\.1; done; kill -9 -- -\$\(cat \S+\.pgid\)/.test(r.cmd))).toBe(true);

    const b2 = fakeBox({ hang: true });
    const pre = new AbortController();
    pre.abort();
    expect(await b2.tool('run_command').handler({ command: 'sleep 999' }, { signal: pre.signal })).toMatch(/^Stopped/);
    expect(b2.killed).toEqual([77]);
  });

  it("stopRunning (the Seat's Stop) kills the whole group of every running command", async () => {
    const b = fakeBox({ hang: true });
    const running = b.tool('run_command').handler({ command: 'python3 -c "import time; time.sleep(180)"' }, {});
    await new Promise((r) => setTimeout(r, 5));
    b.set.stopRunning();
    expect(await running).toMatch(/^Stopped by the manager/);
    expect(b.killed).toEqual([77]);
    expect(b.runs.some((r) => /kill -9 -- -\$\(cat \/tmp\/run-\S+\.pgid\)/.test(r.cmd))).toBe(true);
    b.set.stopRunning(); // nothing left running: a no-op
    expect(b.killed).toEqual([77]);
  });

  it('out of time: the process is killed and the model is told how to ask for longer', async () => {
    const b = fakeBox({ timeout: true });
    const out = await b.tool('run_command').handler({ command: 'python3 slow.py', timeoutSeconds: 30 }, {});
    expect(out).toMatch(/^Timed out after 30 s; the command was killed/);
    expect(b.killed).toEqual([77]);
  });

  it('write_file then read_file round-trips text; a binary file points at share_file', async () => {
    const b = fakeBox();
    expect(await b.tool('write_file').handler({ path: 'notes.txt', content: 'hello' }, {})).toMatch(/Wrote \/home\/user\/files\/notes.txt/);
    expect(await b.tool('read_file').handler({ path: 'notes.txt' }, {})).toBe('hello');
    b.files.set('/home/user/files/a.xlsx', new Uint8Array([80, 75, 3, 4, 0, 0]));
    expect(await b.tool('read_file').handler({ path: 'a.xlsx' }, {})).toMatch(/not a text file.*share_file/);
    // A big file is never loaded whole: its head comes back through a command.
    b.files.set('/home/user/files/big.log', new TextEncoder().encode('y'.repeat(READ_MAX_BYTES + 10)));
    const big = await b.tool('read_file').handler({ path: 'big.log' }, {});
    expect(big).toMatch(/is 262154 bytes; this is its first 20000 characters/);
    expect(b.reads).not.toContain('/home/user/files/big.log');
    // A big BINARY file is still refused, not poured into the model.
    const bin = new Uint8Array(READ_MAX_BYTES + 10);
    bin.set([80, 75, 3, 4]);
    b.files.set('/home/user/files/big.xlsx', bin);
    expect(await b.tool('read_file').handler({ path: 'big.xlsx' }, {})).toMatch(/not a text file.*share_file/);
  });

  it('share_file sends the bytes by name; refuses outside /home/user and over 50 MB', async () => {
    const b = fakeBox();
    b.files.set('/home/user/files/open_jobs.xlsx', new Uint8Array([1, 2, 3]));
    expect(await b.tool('share_file').handler({ path: 'open_jobs.xlsx', caption: 'Open jobs' }, {})).toMatch(/Sent open_jobs.xlsx/);
    expect(b.sent).toEqual([{ name: 'open_jobs.xlsx', bytes: new Uint8Array([1, 2, 3]), caption: 'Open jobs' }]);
    expect(await b.tool('share_file').handler({ path: '/home/user/../etc/shadow' }, {})).toMatch(/outside your files/);
    b.files.set('/home/user/files/big.bin', new Uint8Array(SHARE_MAX_BYTES + 1));
    expect(await b.tool('share_file').handler({ path: 'big.bin' }, {})).toMatch(/50 MB/);
    expect(b.reads).not.toContain('/home/user/files/big.bin'); // refused before any read
    expect(b.sent).toHaveLength(1);
  });

  it('export_query writes the FULL CSV to a safe name but hands the model only a preview', async () => {
    const b = fakeBox();
    const rows = Array.from({ length: 40 }, (_, i) => `${i},Customer ${i}`).join('\r\n');
    b.setExport({ csv: `id,name\r\n${rows}\r\n`, columns: ['id', 'name'], rowCount: 40, truncated: false });
    const out = await b.tool('export_query').handler({ sql: 'select id, name from v_customers', filename: '../skills/open jobs' }, {});
    const written = new TextDecoder().decode(b.files.get('/home/user/files/skillsopenjobs.csv'));
    expect(written.split('\r\n').filter(Boolean)).toHaveLength(41);
    expect(out).toMatch(/40 rows/);
    expect(out).toContain('Customer 4');
    expect(out).not.toContain('Customer 39');
  });

  it("export_query: Render's 400 is 'refused'; an outage is 'try again' (the SQL may be fine); truncation and a long preview are bounded", async () => {
    const b = fakeBox();
    b.failExport(new ExportError('column "nope" does not exist', 400));
    expect(await b.tool('export_query').handler({ sql: 'select nope from v_jobs', filename: 'x' }, {})).toMatch(/refused: column "nope"/);
    b.failExport(new ExportError('Render answered HTTP 500', 500));
    expect(await b.tool('export_query').handler({ sql: 'select a from v_jobs', filename: 'x' }, {})).toMatch(/could not run just now.*SQL may be fine/);
    b.failExport(new Error('The operation was aborted due to timeout'));
    expect(await b.tool('export_query').handler({ sql: 'select a from v_jobs', filename: 'x' }, {})).toMatch(/could not run just now/);
    const b2 = fakeBox();
    b2.setExport({ csv: `a\r\n${'z'.repeat(50_000)}\r\n`, columns: ['a'], rowCount: 1000, truncated: true });
    const out = await b2.tool('export_query').handler({ sql: 'select a from v_jobs', filename: 'x' }, {});
    expect(out).toMatch(/TRUNCATED/);
    expect(out.length).toBeLessThan(2_500);
  });

  it('a replaced sandbox is said up front; an unopenable one is an error result', async () => {
    expect(await fakeBox({ fresh: true }).tool('write_file').handler({ path: 'a.txt', content: 'x' }, {})).toMatch(/^Your earlier files are gone/);
    expect(await fakeBox({ openFails: true }).tool('read_file').handler({ path: 'a.txt' }, {})).toMatch(/could not be opened.*503/);
    expect(await fakeBox().tool('read_file').handler({ path: 'missing.txt' }, {})).toMatch(/^Error: file not found/);
  });
});
