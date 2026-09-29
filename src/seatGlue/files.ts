import { defaultFetch, type FetchLike } from './http.js';
import { seatHeaders } from './identity.js';
import type { FileTool } from './fileTools.js';

// The glue's side of the file store (plan 2026-09-28-step-2d-files, Phase 3):
// upload the bytes a person sent (or a sandbox file) to Render's /seat/files,
// and download a stored file to send back. Render is the only thing that
// touches Storage; the glue only ever holds its own seat token.
//
// EVERY CALL HAS A HARD CLOCK: the seat handles Telegram updates one at a time,
// so a hung upload would hold every later message — Stop included.

export const FILE_CALL_TIMEOUT_MS = 60_000;
/** 20 MB — Telegram's bot download limit, and the store's one ceiling. */
export const FILE_MAX_BYTES = 20 * 1024 * 1024;
export const SEND_FILE_TOOL = 'send_file';

export interface SpineFileConfig {
  spineUrl: string;
  seatToken: string;
}

export interface UploadInput {
  kind: 'photo' | 'document';
  name: string;
  mime: string;
  bytes: Uint8Array;
  source?: 'telegram' | 'sandbox';
}

export interface StoredFile {
  bytes: Uint8Array;
  name: string;
  mime: string;
}

/** The stored file's id. Throws with Render's words (or the status) on any refusal. */
export async function uploadFile(cfg: SpineFileConfig, f: UploadInput, fetchFn: FetchLike = defaultFetch): Promise<string> {
  const url = new URL('/seat/files', cfg.spineUrl);
  url.searchParams.set('kind', f.kind);
  url.searchParams.set('name', f.name);
  const res = await fetchFn(url.toString(), {
    method: 'POST',
    headers: {
      ...seatHeaders(cfg.seatToken),
      'content-type': f.mime || 'application/octet-stream',
      ...(f.source === 'sandbox' ? { 'x-file-source': 'sandbox' } : {}),
    },
    body: new Uint8Array(f.bytes),
    signal: AbortSignal.timeout(FILE_CALL_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as { id?: string; error?: string } | null;
  if (!res.ok || typeof body?.id !== 'string') throw new Error(body?.error ?? `Render answered HTTP ${res.status}`);
  return body.id;
}

/** A stored file this seat's person may see, or null (missing, deleted or not theirs read the same). */
export async function downloadFile(cfg: SpineFileConfig, id: string, fetchFn: FetchLike = defaultFetch): Promise<StoredFile | null> {
  const res = await fetchFn(new URL(`/seat/files/${encodeURIComponent(id)}`, cfg.spineUrl).toString(), {
    method: 'GET',
    headers: { ...seatHeaders(cfg.seatToken) },
    signal: AbortSignal.timeout(FILE_CALL_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Render answered HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let name = 'file';
  try {
    name = decodeURIComponent(res.headers?.get('x-file-name') ?? '') || 'file';
  } catch {
    /* a malformed name header: keep the default */
  }
  return { bytes, name, mime: res.headers?.get('content-type') ?? 'application/octet-stream' };
}

const FILE_ID = /^[0-9a-f-]{36}$/i;
const IMAGE = /^image\/(jpeg|png)$/i;
/** Bot API sendPhoto: "The photo must be at most 10 MB in size" — bigger goes as a document. */
export const TELEGRAM_MAX_PHOTO = 10 * 1024 * 1024;

export interface SendFileDeps {
  downloadFile(id: string): Promise<StoredFile | null>;
  sendPhoto(bytes: Uint8Array, caption?: string): Promise<void>;
  sendDocument(name: string, bytes: Uint8Array, caption?: string): Promise<void>;
}

/**
 * send_file — every seat's one custom tool (step 2d): a stored file back to
 * the person, as a photo when it is a jpeg/png, else as a document. Built
 * outside fileTools(): those open the manager's sandbox, this needs none.
 * Every result is words for the model, never a throw.
 */
export function sendFileTool(deps: SendFileDeps): FileTool {
  return {
    name: SEND_FILE_TOOL,
    description:
      'Send a stored file (a photo or document from list_files, or one your person sent earlier) to them in this ' +
      'Telegram chat. Give its fileId; an optional caption is shown with it.',
    parameters: {
      type: 'object',
      properties: {
        fileId: { type: 'string' },
        caption: { type: 'string', description: 'A short line shown with the file.' },
      },
      required: ['fileId'],
    },
    handler: async (args) => {
      const { fileId, caption } = (args ?? {}) as { fileId?: unknown; caption?: unknown };
      if (typeof fileId !== 'string' || !FILE_ID.test(fileId)) return 'Error: give the fileId (from list_files or the message).';
      const cap = typeof caption === 'string' && caption.trim() ? caption : undefined;
      let file: StoredFile | null;
      try {
        file = await deps.downloadFile(fileId);
      } catch (err) {
        return `Error: the file could not be fetched just now (${err instanceof Error ? err.message : String(err)}). Try again in a minute.`;
      }
      if (!file) return 'No such file (or it is not one your person may see).';
      try {
        if (IMAGE.test(file.mime) && file.bytes.length <= TELEGRAM_MAX_PHOTO) await deps.sendPhoto(file.bytes, cap);
        else await deps.sendDocument(file.name, file.bytes, cap);
      } catch (err) {
        return `Error: Telegram did not take the file (${err instanceof Error ? err.message : String(err)}).`;
      }
      return `Sent ${file.name} to the chat.`;
    },
  };
}
