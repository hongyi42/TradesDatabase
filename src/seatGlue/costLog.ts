import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultFetch, sleep, type FetchLike } from './http.js';

// One JSON line per model call, with the SERVED model and the real price read
// from OpenRouter's generation record (GET /api/v1/generation?id=<id>). Step 0
// measured that the engine's own assistant.usage echoes the REQUESTED model and
// reports cost 0 under BYOK, so it is never the source (engineering-memory §2
// "Step 0 measured"). The engine's apiCallId IS the generation id.
//
// Step 1 writes a file on the box, not cost_events (operator, 2026-09-22). The
// generation id rides every line, so a later import keyed on
// cost_events.source_ref cannot double-count.

export interface CostContext {
  seat: string;
  tenantId: string;
  technicianRef: string;
  stateDir: string;
  openrouterKey: string;
}

export interface CallRef {
  generationId: string;
  replyId: string | null;
  sessionId: string | null;
  kind: 'seat' | 'transcribe';
}

export interface CostLine {
  ts: string;
  status: 'ok' | 'unresolved';
  seat: string;
  tenantId: string;
  technicianRef: string;
  sessionId: string | null;
  replyId: string | null;
  kind: CallRef['kind'];
  generationId: string;
  model?: string;
  provider?: string;
  totalCost?: number;
  tokensPrompt?: number;
  tokensCompletion?: number;
  cached?: number;
  reasoning?: number;
}

export interface CostLogDeps {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Wait before each attempt; the record is rarely ready the instant a call ends. */
  delaysMs?: number[];
}

export const DEFAULT_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000];

export class CostLog {
  private readonly seen = new Set<string>();
  private readonly inFlight = new Set<Promise<CostLine | null>>();
  private readonly fetchImpl: FetchLike;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly delays: number[];

  constructor(
    private readonly ctx: CostContext,
    deps: CostLogDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? defaultFetch;
    this.wait = deps.sleep ?? sleep;
    this.now = deps.now ?? (() => new Date());
    this.delays = deps.delaysMs ?? DEFAULT_DELAYS_MS;
  }

  /**
   * Log one model call. Fed from both assistant.usage and model.call_failure;
   * an id is logged once however many events carry it. Never throws: cost
   * accounting must not break a reply.
   */
  record(ref: CallRef): Promise<CostLine | null> {
    if (!ref.generationId || this.seen.has(ref.generationId)) return Promise.resolve(null);
    this.seen.add(ref.generationId);
    const p = this.write(ref);
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
    return p;
  }

  /** Wait for every cost line still being resolved (the local driver calls it before exiting). */
  async flush(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight]);
  }

  private async write(ref: CallRef): Promise<CostLine | null> {
    try {
      const data = await this.fetchGeneration(ref.generationId);
      const line: CostLine = data
        ? {
            ...this.base(ref, 'ok'),
            model: str(data.model),
            provider: str(data.provider_name),
            totalCost: num(data.total_cost),
            tokensPrompt: num(data.tokens_prompt),
            tokensCompletion: num(data.tokens_completion),
            cached: num(data.native_tokens_cached),
            reasoning: num(data.native_tokens_reasoning),
          }
        : this.base(ref, 'unresolved');
      await this.append(line);
      return line;
    } catch (err) {
      console.error(`seat-glue: cost line not written — ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private base(ref: CallRef, status: CostLine['status']): CostLine {
    return {
      ts: this.now().toISOString(),
      status,
      seat: this.ctx.seat,
      tenantId: this.ctx.tenantId,
      technicianRef: this.ctx.technicianRef,
      sessionId: ref.sessionId,
      replyId: ref.replyId,
      kind: ref.kind,
      generationId: ref.generationId,
    };
  }

  private async fetchGeneration(id: string): Promise<Record<string, unknown> | null> {
    for (const delay of this.delays) {
      await this.wait(delay);
      try {
        const res = await this.fetchImpl(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(id)}`, {
          headers: { authorization: `Bearer ${this.ctx.openrouterKey}` },
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          const body = (await res.json()) as { data?: Record<string, unknown> };
          if (body?.data) return body.data;
          continue;
        }
        // Not ready yet, rate-limited or a server blip: try again. Anything else
        // (401, 400) will not change by waiting.
        if (res.status === 404 || res.status === 429 || res.status >= 500) continue;
        return null;
      } catch {
        continue;
      }
    }
    return null;
  }

  private async append(line: CostLine): Promise<void> {
    const dir = join(this.ctx.stateDir, 'costs');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await appendFile(join(dir, `${line.ts.slice(0, 7)}.jsonl`), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
