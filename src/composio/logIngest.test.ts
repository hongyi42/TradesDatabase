import { describe, expect, test } from 'vitest';
import type { Technician } from '../db/technicians.js';
import type { AppendRawCaptureInput, RawCapture } from '../db/rawCaptures.js';
import { runLogIngestion, type ExecutionLogItem } from './logIngest.js';

// Pure unit tests — fetchers, roster read, and the L1 append all injected.

const TENANT = '11111111-1111-1111-1111-111111111111';
const NOW = '2026-07-04T12:00:00.000Z';

function tech(over: Partial<Technician> = {}): Technician {
  return {
    id: 'tech-1',
    tenant_id: TENANT,
    ref: 'sam',
    display_name: 'Sam',
    tier: 'manager',
    state: 'active',
    sandbox_ref: null,
    composio_connected_account_id: 'ca_x',
    composio_trigger_id: null,
    connected_email: 'sam@biz.com',
    badge_hash: null,
    host_id: null,
    offboarding_started_at: null,
    link_issued_at: null,
    composio_session_id: 'trs_x',
    created_at: '2026-07-04T00:00:00.000Z',
    updated_at: '2026-07-04T00:00:00.000Z',
    ...over,
  };
}

function item(over: Partial<ExecutionLogItem> & { metadata?: Record<string, unknown> }): ExecutionLogItem {
  const { metadata, ...rest } = over;
  return {
    id: 'log-1',
    status: 'success',
    ...rest,
    // The live-verified metadata shape: tool is an OBJECT {slug, ...}.
    metadata: { tool: { slug: 'GMAIL_SEND_EMAIL' }, user_id: `${TENANT}:sam`, ...metadata },
  };
}

// Harness: run ingestion over fixed items with a roster map + recording append.
function harness(opts: {
  items: ExecutionLogItem[];
  roster?: Record<string, Technician | null>; // key `${tenant}:${ref}`
  detail?: Record<string, unknown>;
  appendThrows?: (input: AppendRawCaptureInput) => Error | null;
}) {
  const appended: AppendRawCaptureInput[] = [];
  const detailCalls: string[] = [];
  const deps = {
    fetchLogs: async () => opts.items,
    fetchDetail: async (id: string) => {
      detailCalls.push(id);
      return opts.detail ?? { data: { request: { payload: {} }, response: { status_code: 200, body: {} } } };
    },
    getTech: async (tenantId: string, ref: string) =>
      opts.roster?.[`${tenantId}:${ref}`] ?? null,
    append: async (input: AppendRawCaptureInput) => {
      const err = opts.appendThrows?.(input);
      if (err) throw err;
      appended.push(input);
      return { id: 'cap-1' } as RawCapture;
    },
  };
  return { appended, detailCalls, deps };
}

describe('runLogIngestion — classification', () => {
  test('manager send → outbound_email with sent:<id>, body stored in the email form, unmarked', async () => {
    const h = harness({
      items: [item({})],
      roster: { [`${TENANT}:sam`]: tech() },
      detail: {
        data: {
          request: { payload: { recipient_email: 'c@x.com', subject: 'Invoice', body: 'Attached.' } },
          response: { status_code: 200, body: { id: 'msg-9' } },
        },
      },
    });
    const summary = await runLogIngestion(NOW, h.deps);
    expect(summary).toMatchObject({ scanned: 1, captured: 1, rowErrors: 0 });
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]).toMatchObject({
      tenantId: TENANT,
      channel: 'outbound_email',
      technicianRef: 'sam',
      externalId: 'sent:msg-9',
      sensitivity: null, // business correspondence stays visible to technicians
    });
    expect(h.appended[0].rawText).toBe('Subject: Invoice\nFrom: sam@biz.com\n\nAttached.');
  });

  test('pre-existing sent:<id> → deduped, not an error', async () => {
    const dup = Object.assign(new Error('duplicate'), { code: '23505' });
    const h = harness({
      items: [item({})],
      roster: { [`${TENANT}:sam`]: tech() },
      detail: { data: { request: { payload: { subject: 's', body: 'b' } }, response: { body: { id: 'msg-9' } } } },
      appendThrows: () => dup,
    });
    const summary = await runLogIngestion(NOW, h.deps);
    expect(summary).toMatchObject({ captured: 0, deduped: 1, rowErrors: 0 });
  });

  test('technician-attributed send is SKIPPED even with an unparseable message id (double-capture backstop)', async () => {
    const h = harness({
      items: [item({ metadata: { user_id: `${TENANT}:jane` } })],
      roster: { [`${TENANT}:jane`]: tech({ ref: 'jane', tier: 'technician' }) },
      detail: { data: { request: { payload: { subject: 's', body: 'b' } }, response: { body: { ok: true } } } },
    });
    const summary = await runLogIngestion(NOW, h.deps);
    expect(summary).toMatchObject({ captured: 0, skippedTechnicianSends: 1 });
    expect(h.appended).toHaveLength(0);
    expect(h.detailCalls).toHaveLength(0); // skipped before the detail fetch
  });

  test('unknown slug → captured as agent_action with KEYS-ONLY redaction, manager marked', async () => {
    const h = harness({
      items: [item({ metadata: { tool: { slug: 'STRIPE_CREATE_PAYMENT' } } })],
      roster: { [`${TENANT}:sam`]: tech() },
      detail: {
        data: {
          request: { payload: { amount_cents: 45000, customer_ref: 'cus_SECRET', card: '4242' } },
          response: { status_code: 200, body: { payment_id: 'pay_SECRET' } },
        },
      },
    });
    const summary = await runLogIngestion(NOW, h.deps);
    expect(summary).toMatchObject({ captured: 1 });
    const row = h.appended[0];
    expect(row).toMatchObject({
      channel: 'agent_action',
      externalId: 'composio-exec:log-1',
      sensitivity: 'manager_only',
    });
    // Key names yes, VALUES never — L1 is undeletable.
    expect(row.rawText).toContain('amount_cents');
    expect(row.rawText).toContain('customer_ref');
    for (const leaked of ['45000', 'cus_SECRET', '4242', 'pay_SECRET']) {
      expect(row.rawText).not.toContain(leaked);
      expect(JSON.stringify(row.metadata)).not.toContain(leaked);
    }
  });

  test('COMPOSIO_MANAGE_CONNECTIONS is captured (mints real grants); other meta-tools are reads', async () => {
    const h = harness({
      items: [
        item({ id: 'log-m', metadata: { tool: { slug: 'COMPOSIO_MANAGE_CONNECTIONS' } } }),
        item({ id: 'log-s', metadata: { tool: { slug: 'COMPOSIO_SEARCH_TOOLS' } } }),
      ],
      roster: { [`${TENANT}:sam`]: tech() },
    });
    const summary = await runLogIngestion(NOW, h.deps);
    expect(summary).toMatchObject({ captured: 1, skippedReads: 1 });
    expect(h.appended[0].metadata).toMatchObject({ toolSlug: 'COMPOSIO_MANAGE_CONNECTIONS' });
  });

  test('read slugs and failed executions are skipped', async () => {
    const h = harness({
      items: [
        item({ id: 'log-r1', metadata: { tool: { slug: 'GMAIL_FETCH_EMAILS' } } }),
        item({ id: 'log-r2', metadata: { tool: { slug: 'GMAIL_GET_PROFILE' } } }),
        item({ id: 'log-f', status: 'failed', metadata: { tool: { slug: 'GMAIL_SEND_EMAIL' } } }),
      ],
      roster: { [`${TENANT}:sam`]: tech() },
    });
    const summary = await runLogIngestion(NOW, h.deps);
    expect(summary).toMatchObject({ scanned: 3, captured: 0, skippedReads: 2 });
    expect(h.appended).toHaveLength(0);
  });

  test('Excel reads are skipped; Excel writes are captured (user decision 2026-07-05)', async () => {
    // Slugs are the live-observed catalog names from the 2026-07-05 scenario run.
    const h = harness({
      items: [
        item({ id: 'x1', metadata: { tool: { slug: 'EXCEL_LIST_FILES' } } }),
        item({ id: 'x2', metadata: { tool: { slug: 'EXCEL_GET_RANGE' } } }),
        item({ id: 'x3', metadata: { tool: { slug: 'EXCEL_SEARCH_FILES' } } }),
        item({ id: 'x4', metadata: { tool: { slug: 'EXCEL_LIST_TABLE_ROWS' } } }),
        item({ id: 'x5', metadata: { tool: { slug: 'EXCEL_ADD_TABLE_ROW' } } }),
        item({ id: 'x6', metadata: { tool: { slug: 'EXCEL_UPDATE_RANGE' } } }),
        item({ id: 'x7', metadata: { tool: { slug: 'EXCEL_ADD_TABLE' } } }),
      ],
      roster: { [`${TENANT}:sam`]: tech() },
    });
    const summary = await runLogIngestion(NOW, h.deps);
    expect(summary).toMatchObject({ scanned: 7, captured: 3, skippedReads: 4 });
    const slugs = h.appended.map((a) => (a.metadata as Record<string, unknown>).toolSlug).sort();
    expect(slugs).toEqual(['EXCEL_ADD_TABLE', 'EXCEL_ADD_TABLE_ROW', 'EXCEL_UPDATE_RANGE']);
    // Writes stay keys-only + manager_only — the redaction policy is unchanged.
    expect(h.appended[0].sensitivity).toBe('manager_only');
    expect(h.appended[0].rawText).toContain('argument keys:');
  });

  test('non-composite / default / connector / non-uuid user ids are skipped with a counter', async () => {
    const h = harness({
      items: [
        item({ id: 'l1', metadata: { tool: { slug: 'STRIPE_X' }, user_id: 'default' } }),
        item({ id: 'l2', metadata: { tool: { slug: 'STRIPE_X' }, user_id: TENANT } }), // bare uuid
        item({ id: 'l3', metadata: { tool: { slug: 'STRIPE_X' }, user_id: `${TENANT}:connector:gmail` } }),
        item({ id: 'l4', metadata: { tool: { slug: 'STRIPE_X' }, user_id: 'not-a-uuid:sam' } }),
      ],
    });
    const summary = await runLogIngestion(NOW, h.deps);
    expect(summary).toMatchObject({ scanned: 4, captured: 0, skippedNonComposite: 4 });
  });

  test('unknown ref → captured AND marked manager_only (safe default)', async () => {
    const h = harness({
      items: [item({ metadata: { tool: { slug: 'STRIPE_CREATE_PAYMENT' }, user_id: `${TENANT}:ghost` } })],
      roster: {},
    });
    const summary = await runLogIngestion(NOW, h.deps);
    expect(summary).toMatchObject({ captured: 1 });
    expect(h.appended[0]).toMatchObject({
      technicianRef: 'ghost',
      sensitivity: 'manager_only',
    });
  });

  test('a throwing row is isolated (rowErrors), the rest of the batch continues', async () => {
    const boom = new Error('detail 500');
    const h = harness({
      items: [
        item({ id: 'log-bad', metadata: { tool: { slug: 'STRIPE_X' } } }),
        item({ id: 'log-good', metadata: { tool: { slug: 'STRIPE_Y' } } }),
      ],
      roster: { [`${TENANT}:sam`]: tech() },
    });
    const origFetchDetail = h.deps.fetchDetail;
    h.deps.fetchDetail = async (id: string) => {
      if (id === 'log-bad') throw boom;
      return origFetchDetail(id);
    };
    const summary = await runLogIngestion(NOW, h.deps);
    expect(summary).toMatchObject({ scanned: 2, captured: 1, rowErrors: 1 });
  });

  test('the window passed to the fetcher is the last 60 minutes', async () => {
    let window: { from: string; to: string } | undefined;
    const deps = {
      fetchLogs: async (w: { from: string; to: string }) => {
        window = w;
        return [];
      },
      fetchDetail: async () => ({}),
      getTech: async () => null,
      append: async () => ({ id: 'x' }) as RawCapture,
    };
    await runLogIngestion(NOW, deps);
    expect(window).toEqual({ from: '2026-07-04T11:00:00.000Z', to: NOW });
  });
});

describe('runLogIngestion — shape tolerance (flat fallbacks)', () => {
  test('flat tool_slug / arguments / response_data shapes still parse', async () => {
    const h = harness({
      items: [
        {
          id: 'log-flat',
          status: 'success',
          metadata: { tool_slug: 'GMAIL_SEND_EMAIL', user_id: `${TENANT}:sam` },
        },
      ],
      roster: { [`${TENANT}:sam`]: tech() },
      detail: {
        data: {
          arguments: { recipient_email: 'c@x.com', subject: 'Flat', body: 'B' },
          response_data: { id: 'msg-flat' },
        },
      },
    });
    const summary = await runLogIngestion(NOW, h.deps);
    expect(summary).toMatchObject({ captured: 1 });
    expect(h.appended[0]).toMatchObject({ channel: 'outbound_email', externalId: 'sent:msg-flat' });
  });
});

describe('fetchExecutionLogs — default fetcher (stubbed fetch)', () => {
  test('reads the real `logs` envelope, follows next_cursor, sends epoch-ms time_range', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const pages = [
      { logs: [{ id: 'a' }], next_cursor: '1783194505634' },
      { logs: [{ id: 'b' }], next_cursor: null },
    ];
    let call = 0;
    const savedFetch = globalThis.fetch;
    const savedKey = process.env.COMPOSIO_API_KEY;
    process.env.COMPOSIO_API_KEY = 'test-key';
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? '{}'));
      return {
        ok: true,
        json: async () => pages[call++],
        text: async () => '',
      };
    }) as unknown as typeof fetch;
    try {
      const { fetchExecutionLogs } = await import('./logIngest.js');
      const items = await fetchExecutionLogs({
        from: '2026-07-04T11:00:00.000Z',
        to: '2026-07-04T12:00:00.000Z',
      });
      expect(items.map((i) => i.id)).toEqual(['a', 'b']);
      expect(bodies).toHaveLength(2);
      // epoch-ms numbers, never ISO strings (the API 400s on strings).
      expect(bodies[0].time_range).toEqual({
        from: Date.parse('2026-07-04T11:00:00.000Z'),
        to: Date.parse('2026-07-04T12:00:00.000Z'),
      });
      expect(bodies[1].cursor).toBe('1783194505634');
    } finally {
      globalThis.fetch = savedFetch;
      if (savedKey === undefined) delete process.env.COMPOSIO_API_KEY;
      else process.env.COMPOSIO_API_KEY = savedKey;
    }
  });
});
