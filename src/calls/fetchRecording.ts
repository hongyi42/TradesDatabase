import { getClient } from '../db/index.js';

// SignalWire won't write to our bucket (no native BYO-bucket), and its recording
// media URL is auth-gated — so the worker downloads the recording with HTTP Basic
// (PROJECT_ID:API_TOKEN) and copies the bytes into the private call-audio bucket.
// Returns the stored object path.
export async function downloadAndStore(input: {
  recordingUrl: string;
  bucket: string;
  objectPath: string;
}): Promise<string> {
  const projectId = process.env.SIGNALWIRE_PROJECT_ID;
  // REST reads (recording media) authenticate with the PT-prefixed REST API Token, which
  // is DISTINCT from the PSK signing key in SIGNALWIRE_API_TOKEN — that one validates
  // X-SignalWire-Signature but 401s on every REST endpoint (confirmed live 2026-08-06).
  // Fall back to SIGNALWIRE_API_TOKEN for single-token setups. (With Media URL Protection
  // OFF the media is public and auth is optional, but we send it so protected setups work.)
  const token = process.env.SIGNALWIRE_REST_TOKEN ?? process.env.SIGNALWIRE_API_TOKEN;
  if (!projectId || !token) {
    throw new Error(
      'recording download is not configured (SIGNALWIRE_PROJECT_ID + SIGNALWIRE_REST_TOKEN or SIGNALWIRE_API_TOKEN)',
    );
  }
  const auth = `Basic ${Buffer.from(`${projectId}:${token}`).toString('base64')}`;
  const res = await fetch(input.recordingUrl, { headers: { authorization: auth } });
  if (!res.ok) throw new Error(`recording download failed (HTTP ${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') ?? 'audio/wav';
  const { error } = await getClient()
    .storage.from(input.bucket)
    .upload(input.objectPath, bytes, { contentType, upsert: true });
  if (error) throw new Error(`recording upload failed: ${error.message}`);
  return input.objectPath;
}

// A short-lived signed URL AssemblyAI can fetch (the bucket is private).
export async function signAudioUrl(
  bucket: string,
  objectPath: string,
  ttlSeconds = 3600,
): Promise<string> {
  const { data, error } = await getClient()
    .storage.from(bucket)
    .createSignedUrl(objectPath, ttlSeconds);
  if (error || !data?.signedUrl) {
    throw new Error(`sign audio url failed: ${error?.message ?? 'no url returned'}`);
  }
  return data.signedUrl;
}
