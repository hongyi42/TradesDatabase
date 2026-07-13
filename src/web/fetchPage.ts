import { lookup as dnsLookup } from 'node:dns/promises';
import { PDFParse } from 'pdf-parse';

// Hardened page fetcher for the read_webpage spine tool (Feature E). Runs ONLY
// on the spine server. Guard order per the plan: scheme → DNS/SSRF → manual
// redirects (re-validating every hop) → content-type gate → streamed size cap →
// text extraction → char cap. The caller (dispatch) has already applied the
// rate cap, the provenance tier, and attempt-logging.

export interface FetchedPage {
  finalUrl: string;
  contentType: 'html' | 'text' | 'pdf';
  text: string;
  truncated: boolean;
}

type LookupFn = (host: string) => Promise<Array<{ address: string; family: number }>>;

export interface FetchPageOpts {
  lookup?: LookupFn; // injectable so tests never do real DNS
  fetchImpl?: typeof fetch; // injectable so tests never hit the network
}

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;
const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_TEXT_CHARS = 40_000;

const defaultLookup: LookupFn = async (host) => dnsLookup(host, { all: true });

// Private/reserved IPv4 ranges an outbound fetch must never touch (RFC1918,
// loopback, link-local, CGNAT, benchmarking, multicast/reserved, unspecified).
function isPrivateV4(addr: string): boolean {
  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

// Expand any textual IPv6 form (`::` compression, trailing dotted-v4) into 8
// hextets, or null when it isn't valid IPv6. Needed because Node's URL parser
// NORMALIZES bracketed literals — `[::ffff:127.0.0.1]` becomes the compressed
// hex `::ffff:7f00:1` — so string-prefix checks on the original form are a
// bypass (found in review; the guard must judge the expanded value).
function expandV6(addr: string): number[] | null {
  let s = addr.toLowerCase();
  const v4Tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  let tail: number[] = [];
  if (v4Tail) {
    const octets = v4Tail[1].split('.').map(Number);
    if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return null;
    tail = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
    s = s.slice(0, v4Tail.index).replace(/:$/, ':'); // keep the separator shape
    s = s.endsWith('::') ? s : s.replace(/:$/, '');
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if (head === null || rest === null) return null;
  const known = head.length + rest.length + tail.length;
  if (halves.length === 2) {
    if (known > 8) return null;
    return [...head, ...new Array<number>(8 - known).fill(0), ...rest, ...tail];
  }
  return known === 8 ? [...head, ...rest, ...tail] : null;
}

function isPrivateAddress(addr: string, family: number): boolean {
  if (family === 4) return isPrivateV4(addr);
  const hex = expandV6(addr);
  if (!hex) return true; // unparseable → fail closed
  const embeddedV4 = () => `${hex[6] >> 8}.${hex[6] & 0xff}.${hex[7] >> 8}.${hex[7] & 0xff}`;
  // ::/96 covers unspecified (::), loopback (::1), and the deprecated
  // v4-compat block — nothing publicly routable lives there: reject all.
  if (hex.slice(0, 6).every((h) => h === 0)) return true;
  // v4-mapped ::ffff:0:0/96 — judge the embedded v4 (any textual form).
  if (hex.slice(0, 5).every((h) => h === 0) && hex[5] === 0xffff) return isPrivateV4(embeddedV4());
  // NAT64 well-known prefix 64:ff9b::/96 — also carries an embedded v4.
  if (hex[0] === 0x0064 && hex[1] === 0xff9b && hex.slice(2, 6).every((h) => h === 0))
    return isPrivateV4(embeddedV4());
  if ((hex[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((hex[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((hex[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

// Resolve the host and refuse if ANY answer is private/reserved. NOTE: this is
// validate-then-fetch — a DNS record that changes between this check and the
// connect (DNS rebinding) is a residual, accepted for v1; the egress here is
// Render's, not a sandbox's, and the daily fetch cap bounds probing attempts.
async function assertPublicHost(url: URL, lookup: LookupFn): Promise<void> {
  // A literal IP in the URL never touches DNS — check it directly.
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (/^[\d.]+$/.test(literal) || literal.includes(':')) {
    const family = literal.includes(':') ? 6 : 4;
    if (isPrivateAddress(literal, family)) {
      throw new Error('this address is not reachable from the assistant');
    }
    return;
  }
  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await lookup(literal);
  } catch {
    throw new Error(`could not resolve ${url.hostname}`);
  }
  if (answers.length === 0) throw new Error(`could not resolve ${url.hostname}`);
  for (const a of answers) {
    if (isPrivateAddress(a.address, a.family)) {
      throw new Error('this address is not reachable from the assistant');
    }
  }
}

// Read a body stream with a hard byte ceiling — abort past it rather than
// buffering an arbitrarily large response.
async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(
        `page is too large to read (over ${Math.round(maxBytes / (1024 * 1024))}MB) — send the person the link instead`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// HTML → readable text: drop script/style/noscript bodies and comments (the
// classic hidden-instruction carriers), then tags, then decode the common
// entities and collapse whitespace.
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchPageText(url: string, opts: FetchPageOpts = {}): Promise<FetchedPage> {
  const lookup = opts.lookup ?? defaultLookup;
  const doFetch = opts.fetchImpl ?? fetch;

  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new Error('that is not a valid URL');
  }

  let res: Response | undefined;
  for (let hop = 0; ; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new Error('only http(s) links can be read');
    }
    await assertPublicHost(current, lookup);
    res = await doFetch(current.toString(), {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'text/html, text/plain, application/pdf' },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`the page redirected without a destination (HTTP ${res.status})`);
      if (hop >= MAX_REDIRECTS - 1) throw new Error('too many redirects — page not read');
      current = new URL(loc, current); // relative locations resolve against the hop
      continue;
    }
    break;
  }
  if (!res.ok) throw new Error(`the page could not be read (HTTP ${res.status})`);

  const rawType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const contentType: FetchedPage['contentType'] | undefined =
    rawType === 'application/pdf'
      ? 'pdf'
      : rawType === 'text/html'
        ? 'html'
        : rawType === 'text/plain'
          ? 'text'
          : undefined;
  if (!contentType) {
    throw new Error(
      `unsupported content type (${rawType || 'unknown'}) — send the person the link instead`,
    );
  }

  const body = await readCapped(res, contentType === 'pdf' ? MAX_PDF_BYTES : MAX_HTML_BYTES);

  let text: string;
  if (contentType === 'pdf') {
    const parser = new PDFParse({ data: new Uint8Array(body) });
    try {
      const parsed = await parser.getText();
      text = parsed.text.replace(/\s+/g, ' ').trim();
    } catch {
      throw new Error('this PDF could not be parsed — send the person the link instead');
    } finally {
      await parser.destroy().catch(() => {}); // long-lived server: never leak workers
    }
  } else if (contentType === 'html') {
    text = htmlToText(body.toString('utf8'));
  } else {
    text = body.toString('utf8').replace(/\s+/g, ' ').trim();
  }

  const truncated = text.length > MAX_TEXT_CHARS;
  return {
    finalUrl: current.toString(),
    contentType,
    text: truncated ? text.slice(0, MAX_TEXT_CHARS) : text,
    truncated,
  };
}
