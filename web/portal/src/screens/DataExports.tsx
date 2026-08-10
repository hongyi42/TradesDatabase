import { useState } from 'react';
import { Button, Pill, S } from '../components/ui.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { ACCOUNT, DATA_COUNTS, EXPORTS, SANDBOX_LOG, SEATS, USER } from '../data/mock.js';
import { downloadText, toCsv } from '../data/csv.js';
import {
  EXPORT_LABEL,
  TIER_LABEL,
  displayStatus,
  type ExportJob,
  type ExportKind,
} from '../data/model.js';

// Not in the approved design — a new screen for the export feature.
//
// Three things drive its shape, and none of them are cosmetic:
//   1. The two data tiers are separated because they are not the same risk.
//      "Records" is ordinary business data. "Records + conversations" is bulk
//      PII belonging to the customer's OWN customers — homeowner names,
//      addresses and the verbatim text of what they said — so it gets its own
//      button and its own confirmation naming what is inside.
//   2. Every export is a NEW COPY of that data living outside the database, so
//      links expire (7 days) and past exports are listed with their expiry
//      rather than quietly 404ing.
//   3. The list doubles as the audit trail: who asked, for what, when.

const OPTIONS: Array<{
  kind: ExportKind;
  title: string;
  blurb: string;
  contains: string;
  sensitive?: boolean;
}> = [
  {
    kind: 'records',
    title: 'Your records',
    blurb: 'Customers, jobs, visits, schedule and your team. One CSV per table, zipped.',
    contains: `${DATA_COUNTS.customers.toLocaleString()} customers · ${DATA_COUNTS.jobs.toLocaleString()} jobs · ${DATA_COUNTS.visits.toLocaleString()} visits`,
  },
  {
    kind: 'conversations',
    title: 'Records and conversations',
    blurb:
      'Everything above, plus the full text of emails and call transcripts your team logged.',
    contains: `${DATA_COUNTS.conversations.toLocaleString()} conversations · ${DATA_COUNTS.callsTranscribed} calls transcribed`,
    sensitive: true,
  },
  {
    kind: 'logs',
    title: 'Activity and sandbox logs',
    blurb:
      'Sign-ins, seat changes, provisioning events and per-sandbox logs. No customer details.',
    contains: 'Last 90 days',
  },
];

const STATUS_TONE = { Ready: 'teal', Building: 'amber', Expired: 'muted' } as const;

export function DataExports() {
  const [jobs, setJobs] = useState<ExportJob[]>(EXPORTS);
  const [confirming, setConfirming] = useState<ExportKind | null>(null);
  const [note, setNote] = useState<string | null>(null);

  function queue(kind: ExportKind) {
    const id = `exp-${String(44 + jobs.length).padStart(4, '0')}`;
    setJobs((list) => [
      {
        id,
        kind,
        requestedBy: USER.name,
        requestedAt: 'Just now',
        sizeLabel: null,
        status: 'Building',
        expiresLabel: 'expires in 7 days',
        rowCount: null,
      },
      ...list,
    ]);
    setNote(
      `We're building your ${EXPORT_LABEL[kind].toLowerCase()} export. We'll email ${USER.email} when it's ready — you can close this page.`,
    );
  }

  function start(kind: ExportKind) {
    // Records is small enough to hand over immediately in the prototype, so the
    // button does a real thing you can open in Excel. The other two are queued,
    // which is what all three will do once this is server-side.
    if (kind === 'records') {
      const csv = toCsv(
        ['ref', 'name', 'trade', 'tier', 'status', 'telegram_user_id', 'bot', 'sandbox', 'seat_since'],
        SEATS.map((s) => [
          s.ref,
          s.name,
          s.trade,
          s.seatExempt ? 'seat-exempt' : TIER_LABEL[s.tier],
          displayStatus(s),
          s.telegramUserId ?? '',
          s.botUsername ?? '',
          s.sandboxRef ?? '',
          s.seatSince,
        ]),
      );
      downloadText('tradesdatabase-team-2026-08.csv', csv);
      setNote('Downloaded your team as CSV. The full records export is queued below.');
    }
    if (kind === 'logs') {
      downloadText(
        'tradesdatabase-logs-2026-08.txt',
        [`# ${ACCOUNT.name} · sandbox activity`, '', ...SANDBOX_LOG].join('\n'),
        'text/plain;charset=utf-8',
      );
    }
    queue(kind);
  }

  return (
    <>
      <h1 style={S.h1}>Data &amp; exports</h1>
      <p style={S.sub}>
        Your records are yours. Download them any time — {ACCOUNT.name} · manager access only.
      </p>

      {note && (
        <div
          style={{
            marginTop: 18,
            border: '1px solid var(--shell-line)',
            borderLeft: '3px solid var(--amber)',
            borderRadius: 8,
            padding: '12px 14px',
            fontSize: 13.5,
            color: 'var(--shell-ink-2)',
          }}
          role="status"
        >
          {note}
        </div>
      )}

      <div style={{ display: 'grid', gap: 14, marginTop: 18 }}>
        {OPTIONS.map((o) => (
          <section
            key={o.kind}
            style={{
              ...S.card,
              padding: 22,
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 24,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{o.title}</h2>
                {o.sensitive && <Pill tone="amber">Sensitive</Pill>}
              </div>
              <p style={{ margin: '7px 0 0', fontSize: 13.5, color: 'var(--ink-2)', maxWidth: '46em' }}>
                {o.blurb}
              </p>
              <p style={{ margin: '9px 0 0', ...S.mono, fontSize: 12, color: 'var(--ink-5)' }}>
                {o.contains}
              </p>
            </div>
            <Button
              variant={o.sensitive ? 'outline' : 'primary'}
              onClick={() => (o.sensitive ? setConfirming(o.kind) : start(o.kind))}
              style={{ flex: 'none' }}
            >
              {o.sensitive ? 'Request export' : 'Download'}
            </Button>
          </section>
        ))}
      </div>

      <h2 style={{ margin: '30px 0 12px', fontSize: 16, fontWeight: 600, color: 'var(--shell-ink)' }}>
        Past exports
      </h2>

      <div style={{ ...S.card, overflow: 'hidden' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1.2fr 1fr 0.8fr 0.9fr auto',
            gap: 16,
            padding: '10px 18px',
            background: 'var(--surface-alt-2)',
            borderBottom: '1px solid var(--line)',
          }}
        >
          <span style={S.colHead}>Export</span>
          <span style={S.colHead}>Contents</span>
          <span style={S.colHead}>Requested</span>
          <span style={S.colHead}>Rows</span>
          <span style={S.colHead}>Size</span>
          <span style={S.colHead}>Status</span>
        </div>

        {jobs.map((j, i) => (
          <div
            key={j.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1.2fr 1fr 0.8fr 0.9fr auto',
              gap: 16,
              padding: '14px 18px',
              alignItems: 'center',
              borderTop: i === 0 ? 0 : '1px solid var(--line-soft)',
            }}
          >
            <span style={{ ...S.mono, fontSize: 12.5 }}>{j.id}</span>
            <span style={{ fontSize: 13.5, color: 'var(--ink-2)' }}>{EXPORT_LABEL[j.kind]}</span>
            <span style={{ fontSize: 13, color: 'var(--ink-3)' }}>
              {j.requestedAt}
              <br />
              <span style={{ fontSize: 12, color: 'var(--ink-5)' }}>by {j.requestedBy}</span>
            </span>
            <span style={{ ...S.mono, fontSize: 12, color: 'var(--ink-3)' }}>
              {j.rowCount === null ? '—' : j.rowCount.toLocaleString()}
            </span>
            <span style={{ ...S.mono, fontSize: 12, color: 'var(--ink-3)' }}>
              {j.sizeLabel ?? '—'}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ ...S.mono, fontSize: 11, color: 'var(--ink-5)' }}>{j.expiresLabel}</span>
              <Pill tone={STATUS_TONE[j.status]}>{j.status}</Pill>
            </span>
          </div>
        ))}
      </div>

      <p style={{ margin: '14px 0 0', fontSize: 12.5, color: 'var(--shell-ink-2)' }}>
        Download links expire after 7 days and the file is deleted. Every export is recorded
        against the person who asked for it.
      </p>

      {confirming && (
        <ConfirmDialog
          title="Download conversations as well?"
          confirmLabel="Yes, include conversations"
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const kind = confirming;
            setConfirming(null);
            queue(kind);
          }}
        >
          <p style={{ margin: 0 }}>
            This file will contain <strong>your customers’ personal details</strong> — names,
            addresses, phone numbers — and the full text of{' '}
            <span style={S.mono}>{DATA_COUNTS.conversations.toLocaleString()}</span> emails and call
            transcripts.
          </p>
          <p style={{ margin: '10px 0 0' }}>
            Keep it somewhere you would keep a customer list. The download link stops working after
            7 days and we delete our copy.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
