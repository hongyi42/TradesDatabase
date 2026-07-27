// Google Route Optimization API ("ROI") client — plan 4b-3 Phase 3.
//
// One job: POST an OptimizeToursRequest to
// projects/{PROJECT_ID}:optimizeTours and return the raw response. ROI CANNOT
// be authenticated with an API key or end-user credentials — it requires a
// Google Cloud SERVICE ACCOUNT (Route Optimization Editor role) via OAuth2:
// https://developers.google.com/maps/documentation/route-optimization/client-libraries
// The service-account key JSON lives in GOOGLE_ROUTES_SA_KEY_JSON (one line in
// .env / Render); the GCP project id comes from the key's own project_id —
// no separate GOOGLE_CLOUD_PROJECT_ID env var to drift.

import { GoogleAuth, type JWTInput } from 'google-auth-library';

// Injectable seams (the googleRoutes idiom): token minting and HTTP transport
// are separately fakeable so tests never need a key or the network.
export type RoiTransport = (url: string, token: string, body: unknown) => Promise<unknown>;
export type MintRoiToken = () => Promise<{ token: string; projectId: string }>;

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

const liveMintToken: MintRoiToken = async () => {
  const raw = process.env.GOOGLE_ROUTES_SA_KEY_JSON;
  if (!raw) throw new Error('GOOGLE_ROUTES_SA_KEY_JSON is not set');
  let credentials: JWTInput & { project_id?: string };
  try {
    credentials = JSON.parse(raw) as JWTInput & { project_id?: string };
  } catch {
    throw new Error('GOOGLE_ROUTES_SA_KEY_JSON is not valid JSON');
  }
  if (!credentials.project_id) {
    throw new Error('GOOGLE_ROUTES_SA_KEY_JSON has no project_id');
  }
  const auth = new GoogleAuth({ credentials, scopes: [SCOPE] });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) {
    throw new Error('could not mint a Google access token from the service-account key');
  }
  return { token, projectId: credentials.project_id };
};

const liveTransport: RoiTransport = async (url, token, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`optimizeTours failed: HTTP ${res.status} ${detail.slice(0, 500)}`);
  }
  return res.json();
};

// POST the request body VERBATIM (callers build { model, ... } themselves —
// this layer adds only auth + routing). Errors propagate: an ROI outage must
// surface as a failed solve, never a silently empty plan.
export async function optimizeTours(
  requestBody: unknown,
  deps: { transport?: RoiTransport; mintToken?: MintRoiToken } = {},
): Promise<unknown> {
  const mint = deps.mintToken ?? liveMintToken;
  const transport = deps.transport ?? liveTransport;
  const { token, projectId } = await mint();
  const url = `https://routeoptimization.googleapis.com/v1/projects/${projectId}:optimizeTours`;
  return transport(url, token, requestBody);
}
