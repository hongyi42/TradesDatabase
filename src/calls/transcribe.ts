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

interface AaiTranscript {
  status: 'queued' | 'processing' | 'completed' | 'error';
  text?: string | null;
  error?: string | null;
  utterances?: Array<{ speaker: string; text: string }> | null;
}

function formatDiarized(t: AaiTranscript): string {
  if (t.utterances && t.utterances.length > 0) {
    return t.utterances.map((u) => `Speaker ${u.speaker}: ${u.text}`).join('\n');
  }
  return t.text ?? '';
}

// AssemblyAI batch transcription with speaker diarization. Takes a FETCHABLE
// audio_url (a short-lived Supabase signed URL — the SignalWire media URL is
// auth-gated, so AssemblyAI cannot fetch it directly), polls to completion, and
// returns the diarized transcript. speaker_labels comes from the dual channels,
// not a voiceprint (compliance: no biometric template).
export const assemblyAiTranscriber: Transcriber = {
  async transcribe(audioUrl: string): Promise<string> {
    const key = process.env.ASSEMBLYAI_API_KEY;
    if (!key) throw new Error('transcription is not configured (ASSEMBLYAI_API_KEY is not set)');

    const submit = await fetch(`${BASE}/transcript`, {
      method: 'POST',
      headers: { authorization: key, 'content-type': 'application/json' },
      body: JSON.stringify({ audio_url: audioUrl, speaker_labels: true }),
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
