// The slice of `fetch` the glue uses, so every network caller can be handed a
// fake in tests. The global fetch satisfies it structurally.
export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface HttpInit {
  method?: string;
  headers?: Record<string, string>;
  /** FormData only for Telegram's file upload (sendDocument); JSON everywhere else. */
  body?: string | FormData;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init?: HttpInit) => Promise<HttpResponse>;

export const defaultFetch: FetchLike = (url, init) => fetch(url, init);

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
