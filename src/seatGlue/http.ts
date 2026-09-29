// The slice of `fetch` the glue uses, so every network caller can be handed a
// fake in tests. The global fetch satisfies it structurally.
export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  /** Response headers — read only by the file store's download (step 2d); fakes may leave it out. */
  headers?: { get(name: string): string | null };
}

export interface HttpInit {
  method?: string;
  headers?: Record<string, string>;
  /** FormData for Telegram's file upload (sendDocument); raw bytes for the file store's upload (step 2d); JSON everywhere else. */
  body?: string | FormData | Uint8Array<ArrayBuffer>;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init?: HttpInit) => Promise<HttpResponse>;

export const defaultFetch: FetchLike = (url, init) => fetch(url, init);

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
