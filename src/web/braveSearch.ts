// Brave Search API client (Search plan, `web` snippet mode — Feature E).
// Runs ONLY on the spine server: the key lives in Render/env, never in a
// sandbox. Provider is deliberately isolated behind this one module + the
// WebSearchResult shape so a future swap (e.g. a Google-wrapper API if pilot
// feedback wants stronger local-business results) touches nothing else.

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface BraveWebResponse {
  web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
}

export async function braveWebSearch(query: string, count: number): Promise<WebSearchResult[]> {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new Error('web search is not configured (BRAVE_API_KEY is not set)');
  const params = new URLSearchParams({ q: query, count: String(count) });
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': key,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 429) {
    throw new Error('search is rate-limited right now — try again in a minute');
  }
  if (!res.ok) {
    throw new Error(`search failed upstream (HTTP ${res.status})`);
  }
  const body = (await res.json()) as BraveWebResponse;
  return (body.web?.results ?? [])
    .filter((r) => typeof r.url === 'string' && r.url.length > 0)
    .map((r) => ({
      title: r.title ?? '',
      url: r.url as string,
      snippet: r.description ?? '',
    }));
}
