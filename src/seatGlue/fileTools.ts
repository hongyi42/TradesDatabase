import { posix } from 'node:path';
import { batchProgressTool, type Progress } from './batchProgress.js';
import { FILES_DIR, type E2bSandboxLike } from './sandbox.js';
import type { StoredFile } from './files.js';

// A manager's file tools (step 2b, plan 2026-09-28-step-2b-manager-files-
// sandbox-skills): the glue's OWN tools, run against the manager's E2B sandbox
// — never the engine's built-in shell/file tools, which act on the box.
//
// Every result is text for the model, never a throw: a failed command, a bad
// path or a sandbox that could not be opened comes back as words it can act on.

export const FILE_TOOL_NAMES = new Set([
  'run_command',
  'read_file',
  'write_file',
  'share_file',
  'export_query',
  'batch_progress',
  'save_file',
  'open_file',
]);
/** The file store's ceiling (step 2d): Telegram's bot download limit. */
export const STORE_MAX_BYTES = 20 * 1024 * 1024;

/** What a tool result may carry into the model's context. */
export const OUTPUT_MAX = 20_000;
export const RUN_DEFAULT_S = 120;
export const RUN_MAX_S = 600;
/** Telegram's cap on a document a bot sends. */
export const SHARE_MAX_BYTES = 50 * 1024 * 1024;
/** read_file reads at most this much; bigger text is cut (never loaded whole into the glue). */
export const READ_MAX_BYTES = 256 * 1024;
/** Each of stdout and stderr is cut to its last this-many characters. */
export const STREAM_TAIL = 9_000;
const PREVIEW_MAX = 2_000;
const HOME = '/home/user/';
const EXPORT_PREVIEW_ROWS = 5;

export interface ExportResult {
  csv: string;
  columns: string[];
  rowCount: number;
  truncated: boolean;
}

/** Render's refusal (400) vs anything else (an outage, a timeout): only the first is the SQL's fault. */
export class ExportError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

export interface FileToolDeps {
  sandbox: { get(holdMs?: number): Promise<{ sbx: E2bSandboxLike; fresh: boolean }> };
  /** Render's POST /seat/export (every row as CSV). Throws with Render's words on a refusal. */
  exportRows(sql: string): Promise<ExportResult>;
  sendDocument(filename: string, bytes: Uint8Array, caption?: string): Promise<void>;
  /** Step 2c: a batch job's progress after every checklist change (null = cleared), for the Working line. */
  onProgress?(p: Progress | null): void;
  /** Step 2d: keep a sandbox file in the file store (Render /seat/files); returns its id. */
  uploadFile(f: { kind: 'photo' | 'document'; name: string; mime: string; bytes: Uint8Array; source: 'sandbox' }): Promise<string>;
  /** Step 2d: a stored file this manager may see, or null. */
  downloadFile(id: string): Promise<StoredFile | null>;
}

/** The SDK's Tool shape (1.0.14 types.d.ts:523-578), as plain objects. */
export interface FileTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler(args: unknown, invocation: { signal?: AbortSignal }): Promise<string>;
}

const GONE = 'Your earlier files are gone (your computer was replaced). ';

/** Resolve a path the model gave against the files folder; null = outside /home/user. */
export function resolvePath(p: string): string | null {
  const full = posix.resolve(FILES_DIR, p);
  return full.startsWith(HOME) ? full : null;
}

/** A type for a sandbox file by its extension (what the store records and echoes back). */
export function mimeByExt(name: string): string {
  const ext = posix.extname(name).toLowerCase();
  const known: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.pdf': 'application/pdf',
    '.csv': 'text/csv',
    '.txt': 'text/plain',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return known[ext] ?? 'application/octet-stream';
}

/** A stored file's name, safe to write under the files folder: no folders, no leading dots, extension kept. */
export function storedName(name: string): string {
  const cleaned = posix.basename(name).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return (cleaned || 'file').slice(0, 120);
}

/** A file name for export_query: letters, digits, dot, dash, underscore — no folders. */
export function safeName(name: string): string {
  const cleaned = name.replace(/\.csv$/i, '').replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+/, '');
  return (cleaned || 'export').slice(0, 80);
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** E2B throws CommandExitError on a non-zero exit, carrying the exit code: duck-typed. */
function exitCodeOf(err: unknown): number | null {
  const e = err as { exitCode?: unknown } | null;
  return e && typeof e.exitCode === 'number' ? e.exitCode : null;
}

/**
 * E2B's command deadline (its TimeoutError), by NAME only: a network error that
 * merely says "ETIMEDOUT" is a lost connection, not the command running long.
 */
function isTimeout(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'TimeoutError';
}

const byteLength = (s: string) => new TextEncoder().encode(s).length;

// The header first, always: however long the output, the model sees the exit code.
// Bytes against bytes (wc -c counts bytes): a name with an accent is not "cut".
function commandResult(head: string, out: { text: string; bytes: number }, err: { text: string; bytes: number }): string {
  const part = (label: string, o: { text: string; bytes: number }) => {
    const shown = byteLength(o.text);
    return `--- ${label}${o.bytes > shown ? ` (last ${shown} of ${o.bytes} bytes)` : ''} ---\n${o.text}`;
  };
  return `${head}\n${part('stdout', out)}\n${part('stderr', err)}`;
}

const obj = (props: Record<string, unknown>, required: string[]) => ({ type: 'object', properties: props, required });

export interface FileToolSet {
  tools: FileTool[];
  /**
   * Kill every command still running. The Seat calls it whenever it stops a
   * reply (Stop, /new): measured live 2026-09-28, the SDK's invocation.signal
   * never fires on session.abort(), so a stopped python3 kept running.
   */
  stopRunning(): void;
}

export function fileTools(deps: FileToolDeps): FileToolSet {
  /** Kill functions of the commands running right now. */
  const running = new Set<() => void>();
  // Every tool opens the sandbox first; a replaced one is said up front.
  const withBox = async (holdMs: number | undefined, f: (sbx: E2bSandboxLike) => Promise<string>): Promise<string> => {
    let got;
    try {
      got = await deps.sandbox.get(holdMs);
    } catch (err) {
      return `Error: your computer could not be opened (${errText(err)}). Try again in a minute.`;
    }
    try {
      return (got.fresh ? GONE : '') + (await f(got.sbx));
    } catch (err) {
      return `${got.fresh ? GONE : ''}Error: ${errText(err)}`;
    }
  };
  const pathOrRefuse = (p: unknown): string | { refused: string } => {
    if (typeof p !== 'string' || !p.trim()) return { refused: 'Error: give a path, for example "report.xlsx".' };
    return resolvePath(p) ?? { refused: `Error: ${p} is outside your files. Paths live under ${HOME}.` };
  };

  const tools: FileTool[] = [
    {
      name: 'run_command',
      description:
        `Run a shell command on your own computer (Linux, Python 3.12 with openpyxl, xlsxwriter, reportlab, pandas; NO internet). ` +
        `It starts in ${FILES_DIR}, where the manager's files live. Use it to run Python that builds spreadsheets, PDFs and other files. ` +
        `Returns the exit code, stdout and stderr (the last ${OUTPUT_MAX} characters).`,
      parameters: obj(
        {
          command: { type: 'string', description: 'The shell command, e.g. "python3 build.py".' },
          timeoutSeconds: { type: 'number', description: `Default ${RUN_DEFAULT_S}, at most ${RUN_MAX_S}.` },
        },
        ['command'],
      ),
      handler: async (args, invocation) => {
        const { command, timeoutSeconds } = (args ?? {}) as { command?: unknown; timeoutSeconds?: unknown };
        if (typeof command !== 'string' || !command.trim()) return 'Error: give a command.';
        const secs = Math.min(RUN_MAX_S, Math.max(1, typeof timeoutSeconds === 'number' ? timeoutSeconds : RUN_DEFAULT_S));
        // The sandbox must stay awake for the whole command, plus a margin.
        return withBox(secs * 1000 + 5 * 60_000, async (sbx) => {
          // Output goes to files IN the sandbox and only their tails come back:
          // E2B keeps a command's whole stdout in the glue's memory otherwise,
          // and a runaway loop must not fill the box (review).
          const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const script = `/tmp/run-${id}.sh`;
          const outFile = `/tmp/run-${id}.out`;
          const errFile = `/tmp/run-${id}.err`;
          const pgidFile = `/tmp/run-${id}.pgid`;
          const codeFile = `/tmp/run-${id}.code`;
          await sbx.files.write(script, command);
          // Its own process GROUP (setsid), recorded, so a kill takes python3 and
          // every other child with it — killing the shell alone leaves them running.
          // The command's OWN exit code goes to a file: setsid --wait hands back the
          // raw wait status for a signal death (SIGKILL reads as 9, not 137).
          const handle = await sbx.commands.run(
            `setsid --wait bash -c 'echo $$ > ${pgidFile}; bash ${script}; echo $? > ${codeFile}' > ${outFile} 2> ${errFile}`,
            { cwd: FILES_DIR, timeoutMs: secs * 1000, background: true },
          );
          // The group kill in flight, so the clean-up never deletes the pgid file
          // under it (review round 3).
          let killing: Promise<unknown> = Promise.resolve();
          const kill = () => {
            // The pgid file is written by the inner shell: a Stop in the first
            // instant waits (up to 3 s) for it rather than miss the group.
            killing = Promise.all([
              sbx.commands
                .run(`for i in $(seq 1 30); do [ -s ${pgidFile} ] && break; sleep 0.1; done; kill -9 -- -$(cat ${pgidFile}) 2>/dev/null; true`)
                .catch(() => {}),
              sbx.commands.kill(handle.pid).catch(() => {}),
            ]);
          };
          // A Stop aborts this call (run_command is abort-safe): kill the process
          // so it does not carry on writing files nobody asked for any more.
          let stopped = false;
          const onAbort = () => {
            stopped = true;
            kill();
          };
          if (invocation.signal?.aborted) onAbort();
          invocation.signal?.addEventListener('abort', onAbort, { once: true });
          running.add(onAbort);
          let head: string | null = null;
          try {
            await handle.wait();
          } catch (err) {
            if (stopped) head = 'Stopped by the manager; the command was killed.';
            else if (exitCodeOf(err) === null) {
              // The wait ended without the command's exit: kill it either way.
              kill();
              head = isTimeout(err)
                ? `Timed out after ${secs} s; the command was killed. Raise timeoutSeconds (up to ${RUN_MAX_S}) if it needs longer.`
                : `The connection to your computer was lost (${errText(err)}); the command was stopped. Try again.`;
            }
          } finally {
            invocation.signal?.removeEventListener('abort', onAbort);
            running.delete(onAbort);
          }
          const tailOf = async (file: string) => {
            const r = await sbx.commands.run(`wc -c < ${file}; tail -c ${STREAM_TAIL} ${file}`).catch(() => null);
            if (!r) return { text: '', bytes: 0 };
            const nl = r.stdout.indexOf('\n');
            return { bytes: Number(r.stdout.slice(0, nl)) || 0, text: r.stdout.slice(nl + 1) };
          };
          if (head === null) {
            const code = await sbx.commands.run(`cat ${codeFile} 2>/dev/null`).catch(() => null);
            const n = Number(code?.stdout.trim());
            head = code?.stdout.trim() && Number.isInteger(n) ? `exit code ${n}` : 'exit code unknown (the command did not report one)';
          }
          const [out, errOut] = [await tailOf(outFile), await tailOf(errFile)];
          await killing;
          await sbx.commands.run(`rm -f ${script} ${outFile} ${errFile} ${pgidFile} ${codeFile}`).catch(() => {});
          return commandResult(head, out, errOut);
        });
      },
    },
    {
      name: 'read_file',
      description: `Read a text file from your computer (up to ${OUTPUT_MAX} characters). Relative paths are in ${FILES_DIR}.`,
      parameters: obj({ path: { type: 'string' } }, ['path']),
      handler: async (args) => {
        const path = pathOrRefuse((args as { path?: unknown } | null)?.path);
        if (typeof path !== 'string') return path.refused;
        return withBox(undefined, async (sbx) => {
          const { size } = await sbx.files.getInfo(path);
          if (size > READ_MAX_BYTES) {
            const quoted = `'${path.replace(/'/g, "'\\''")}'`;
            // Binary first, as for a small file: an .xlsx must never pour into the model.
            const nul = await sbx.commands.run(`head -c 8192 ${quoted} | tr -dc '\\000' | wc -c`);
            if (Number(nul.stdout.trim()) > 0) {
              return `${path} is not a text file (${size} bytes). To give it to the manager, use share_file.`;
            }
            const head = await sbx.commands.run(`head -c ${OUTPUT_MAX} ${quoted}`);
            return `${head.stdout}\n…(${path} is ${size} bytes; this is its first ${OUTPUT_MAX} characters. Use run_command to search it.)`;
          }
          const bytes = await sbx.files.read(path, { format: 'bytes' });
          if (bytes.subarray(0, 8192).includes(0)) {
            return `${path} is not a text file (${bytes.length} bytes). To give it to the manager, use share_file.`;
          }
          const text = new TextDecoder().decode(bytes);
          return text.length <= OUTPUT_MAX ? text : `${text.slice(0, OUTPUT_MAX)}\n…(cut at ${OUTPUT_MAX} of ${text.length} characters)`;
        });
      },
    },
    {
      name: 'write_file',
      description: `Write a text file on your computer (replaces it). Relative paths are in ${FILES_DIR}. For firm data, use export_query instead of typing rows.`,
      parameters: obj({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
      handler: async (args) => {
        const { content } = (args ?? {}) as { content?: unknown };
        const path = pathOrRefuse((args as { path?: unknown } | null)?.path);
        if (typeof path !== 'string') return path.refused;
        if (typeof content !== 'string') return 'Error: content must be text.';
        return withBox(undefined, async (sbx) => {
          await sbx.files.write(path, content);
          return `Wrote ${path} (${content.length} characters).`;
        });
      },
    },
    {
      name: 'share_file',
      description: `Send a file from your computer to the manager in this Telegram chat (up to 50 MB). Only files under ${HOME}.`,
      parameters: obj(
        { path: { type: 'string' }, caption: { type: 'string', description: 'A short line shown with the file.' } },
        ['path'],
      ),
      handler: async (args) => {
        const { caption } = (args ?? {}) as { caption?: unknown };
        const path = pathOrRefuse((args as { path?: unknown } | null)?.path);
        if (typeof path !== 'string') return path.refused;
        return withBox(undefined, async (sbx) => {
          const { size } = await sbx.files.getInfo(path);
          if (size > SHARE_MAX_BYTES) return `Error: ${path} is ${size} bytes; Telegram takes at most 50 MB.`;
          const bytes = await sbx.files.read(path, { format: 'bytes' });
          const name = posix.basename(path);
          await deps.sendDocument(name, bytes, typeof caption === 'string' ? caption : undefined);
          return `Sent ${name} (${bytes.length} bytes) to the chat.`;
        });
      },
    },
    {
      name: 'export_query',
      description:
        `Put firm data into a CSV file on your computer: runs a read-only query like spine-query_spine (the same v_* views) ` +
        `and writes EVERY row (up to 1,000) to ${FILES_DIR}/<filename>.csv without you copying anything. ` +
        `Returns the path, the row count, the columns and the first ${EXPORT_PREVIEW_ROWS} rows.`,
      parameters: obj(
        {
          sql: { type: 'string', description: 'One SELECT over the v_* views.' },
          filename: { type: 'string', description: 'A name for the file, e.g. "open_jobs".' },
        },
        ['sql', 'filename'],
      ),
      handler: async (args) => {
        const { sql, filename } = (args ?? {}) as { sql?: unknown; filename?: unknown };
        if (typeof sql !== 'string' || !sql.trim()) return 'Error: give the SQL.';
        const path = `${FILES_DIR}/${safeName(typeof filename === 'string' ? filename : 'export')}.csv`;
        let out: ExportResult;
        try {
          out = await deps.exportRows(sql);
        } catch (err) {
          if (err instanceof ExportError && err.status === 400) return `Error: the query was refused: ${err.message}`;
          return `Error: the export could not run just now (${errText(err)}). Your SQL may be fine; try again in a minute.`;
        }
        return withBox(undefined, async (sbx) => {
          await sbx.files.write(path, out.csv);
          let preview = out.csv.split('\r\n').slice(0, EXPORT_PREVIEW_ROWS + 1).join('\n');
          if (preview.length > PREVIEW_MAX) preview = `${preview.slice(0, PREVIEW_MAX)}…`;
          return (
            `Wrote ${path}: ${out.rowCount} rows${out.truncated ? ' (TRUNCATED at 1,000 — narrow the query)' : ''}, ` +
            `columns ${out.columns.join(', ') || '(none)'}.\nFirst rows:\n${preview}`
          );
        });
      },
    },
    // Step 2c: the batch checklist (batchProgress.ts).
    batchProgressTool({ sandbox: deps.sandbox, onProgress: deps.onProgress }),
    // Step 2d: the file store, both ways.
    {
      name: 'save_file',
      description:
        `Keep a file from your computer in the firm's file store (up to 20 MB), so it outlives this computer and can ` +
        `be attached to a customer, job, visit or ledger entry. Returns its file id: attach it with spine-link_file.`,
      parameters: obj({ path: { type: 'string' } }, ['path']),
      handler: async (args) => {
        const path = pathOrRefuse((args as { path?: unknown } | null)?.path);
        if (typeof path !== 'string') return path.refused;
        return withBox(undefined, async (sbx) => {
          const { size } = await sbx.files.getInfo(path);
          if (size > STORE_MAX_BYTES) return `Error: ${path} is ${size} bytes; the file store takes at most 20 MB.`;
          if (size === 0) return `Error: ${path} is empty.`;
          const bytes = await sbx.files.read(path, { format: 'bytes' });
          const name = posix.basename(path);
          const mime = mimeByExt(name);
          let id: string;
          try {
            id = await deps.uploadFile({ kind: mime.startsWith('image/') ? 'photo' : 'document', name, mime, bytes, source: 'sandbox' });
          } catch (err) {
            return `Error: ${name} could not be kept just now (${errText(err)}). Try again in a minute.`;
          }
          return `Saved ${name} as file ${id}. Attach it with spine-link_file.`;
        });
      },
    },
    {
      name: 'open_file',
      description:
        `Bring a stored file (a photo, a document your manager sent, one you saved) onto your computer under ${FILES_DIR}, ` +
        `to read or work on it. Give its fileId.`,
      parameters: obj({ fileId: { type: 'string' } }, ['fileId']),
      handler: async (args) => {
        const fileId = (args as { fileId?: unknown } | null)?.fileId;
        if (typeof fileId !== 'string' || !fileId.trim()) return 'Error: give the fileId.';
        let file: StoredFile | null;
        try {
          file = await deps.downloadFile(fileId.trim());
        } catch (err) {
          return `Error: the file could not be fetched just now (${errText(err)}). Try again in a minute.`;
        }
        if (!file) return 'No such file.';
        // Unique per file: every Telegram photo is stored as "photo.jpg", and a
        // second open must never silently replace the first.
        const path = resolvePath(`${fileId.trim().slice(0, 8)}-${storedName(file.name)}`);
        if (!path) return 'Error: that file name cannot be written here.';
        const stored = file;
        return withBox(undefined, async (sbx) => {
          await sbx.files.write(path, new Uint8Array(stored.bytes).buffer);
          return `Wrote ${path} (${stored.bytes.length} bytes).`;
        });
      },
    },
  ];
  return {
    tools,
    stopRunning: () => {
      for (const stop of [...running]) stop();
    },
  };
}
