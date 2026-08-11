// Speech-to-text, decoupled behind a Transcriber interface so the STT vendor is
// swappable and a stored recording can be re-transcribed later with a better model.

export interface Transcriber {
  transcribe(audioUrl: string): Promise<string>;
}

const BASE = 'https://api.assemblyai.com/v2';
const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 20 * 60 * 1000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface AaiUtterance {
  // With multichannel:true, `speaker` carries the CHANNEL NUMBER ("1","2"), and
  // `channel` is the same value. We read `channel` first, fall back to `speaker`.
  speaker?: string | null;
  channel?: string | null;
  text: string;
}

interface AaiTranscript {
  status: 'queued' | 'processing' | 'completed' | 'error';
  text?: string | null;
  error?: string | null;
  audio_channels?: number | null;
  utterances?: AaiUtterance[] | null;
}

// The call is recorded DUAL-CHANNEL (SignalWire `record-from-answer-dual`): the
// inbound caller is the A-leg = channel 1, the forwarded business line is the
// B-leg = channel 2 (documented convention, confirmed on a live pilot call
// 2026-08-11). So a channel number maps deterministically to a role — no voice
// modeling, no guessing.
const CHANNEL_ROLE: Record<string, string> = { '1': 'Caller', '2': 'Business' };

function roleFor(u: AaiUtterance): string {
  const ch = String(u.channel ?? u.speaker ?? '').trim();
  return CHANNEL_ROLE[ch] ?? (ch ? `Channel ${ch}` : 'Speaker');
}

// Turn the multichannel utterances into a role-labeled, time-ordered dialog:
//   Caller: ...
//   Business: ...
// Only role-labels when the recording genuinely split into 2+ channels; a mono
// file (or a single-channel result) must NOT fake a two-party dialog — it falls
// back to the plain transcript text.
export function formatDiarized(t: AaiTranscript): string {
  const utterances = t.utterances ?? [];
  if (utterances.length === 0) return t.text ?? '';
  const distinctChannels = new Set(
    utterances.map((u) => String(u.channel ?? u.speaker ?? '').trim()).filter((c) => c !== ''),
  );
  if (distinctChannels.size < 2) {
    return t.text ?? utterances.map((u) => u.text).join(' ');
  }
  return utterances.map((u) => `${roleFor(u)}: ${u.text}`).join('\n');
}

// AssemblyAI batch transcription using MULTICHANNEL (not speaker diarization).
// Takes a FETCHABLE audio_url (a short-lived Supabase signed URL — the SignalWire
// media URL is auth-gated, so AssemblyAI cannot fetch it directly), polls to
// completion, and returns the role-labeled transcript. multichannel splits by the
// two PHYSICAL recording channels — caller vs business — which is both more
// reliable than diarizing a mono mix AND compliance-cleaner: it does no voiceprint
// / speaker-acoustic modeling at all (no biometric template).
export const assemblyAiTranscriber: Transcriber = {
  async transcribe(audioUrl: string): Promise<string> {
    const key = process.env.ASSEMBLYAI_API_KEY;
    if (!key) throw new Error('transcription is not configured (ASSEMBLYAI_API_KEY is not set)');

    const submit = await fetch(`${BASE}/transcript`, {
      method: 'POST',
      headers: { authorization: key, 'content-type': 'application/json' },
      body: JSON.stringify({ audio_url: audioUrl, multichannel: true }),
    });
    if (!submit.ok) throw new Error(`assemblyai submit failed (HTTP ${submit.status})`);
    const { id } = (await submit.json()) as { id: string };

    const deadline = Date.now() + MAX_WAIT_MS;
    for (;;) {
      if (Date.now() > deadline) throw new Error('assemblyai transcription timed out');
      await delay(POLL_INTERVAL_MS);
      const res = await fetch(`${BASE}/transcript/${id}`, { headers: { authorization: key } });
      if (!res.ok) throw new Error(`assemblyai poll failed (HTTP ${res.status})`);
      const body = (await res.json()) as AaiTranscript;
      if (body.status === 'completed') return formatDiarized(body);
      if (body.status === 'error') throw new Error(`assemblyai error: ${body.error ?? 'unknown'}`);
    }
  },
};
