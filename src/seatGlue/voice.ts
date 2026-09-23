import { defaultFetch, type FetchLike } from './http.js';

// Voice notes are transcribed BEFORE the seat sees them. OpenRouter documents
// audio input only on /chat/completions with `input_audio`
// (openrouter.ai/docs/guides/overview/multimodal/audio.md, read 2026-09-22),
// and step 0 requires the engine on the responses wire, where audio is
// undocumented. So the glue asks Gemini directly and hands the seat text.
export const TRANSCRIBE_MODEL = 'google/gemini-3.8-flash';

const FORMATS: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
};

export function audioFormat(mime: string): string {
  const f = FORMATS[mime.split(';')[0].trim().toLowerCase()];
  if (!f) throw new Error(`seat-glue: unsupported audio type ${mime}`);
  return f;
}

export interface TranscribeDeps {
  openrouterKey: string;
  fetch?: FetchLike;
  model?: string;
}

export async function transcribe(
  buf: Buffer,
  mime: string,
  deps: TranscribeDeps,
): Promise<{ text: string; generationId: string | null }> {
  const format = audioFormat(mime);
  const res = await (deps.fetch ?? defaultFetch)('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${deps.openrouterKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: deps.model ?? TRANSCRIBE_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Transcribe this voice note exactly, in the language spoken. Reply with the transcript only; no commentary.',
            },
            { type: 'input_audio', input_audio: { data: buf.toString('base64'), format } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const body = (await res.json().catch(() => null)) as {
    id?: string;
    choices?: Array<{ message?: { content?: unknown } }>;
  } | null;
  if (!res.ok) throw new Error(`seat-glue: transcription failed (HTTP ${res.status})`);
  const content = body?.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) throw new Error('seat-glue: transcription came back empty');
  return { text, generationId: typeof body?.id === 'string' ? body.id : null };
}
