import { google } from 'googleapis';
import { isInactiveState, listTeam, upsertOpenReviewItem, upsertScheduleEntry } from '../db/index.js';
import { closestRef } from './refSuggest.js';

// One row read from the manager's schedule sheet. rowKey is a STABLE id for the
// sheet row so re-syncing updates in place rather than duplicating.
export interface ScheduleRow {
  rowKey: string;
  technicianRef: string;
  customerName?: string | null;
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  phone?: string | null;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
}

// Injected so tests can supply rows without touching Google.
export type SheetReader = (spreadsheetId: string) => Promise<ScheduleRow[]>;

const SHEET_RANGE = 'A1:Z10000';

// Default reader: pulls the first worksheet via the Google Sheets API using
// Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS). Expects a
// header row whose columns include (case-insensitive substring): technician,
// customer, address, city, state, postal, phone, start, end. The row key is the
// 1-based sheet row number — stable across in-place manager edits.
const googleSheetReader: SheetReader = async (spreadsheetId) => {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: SHEET_RANGE });
  const values = res.data.values ?? [];
  if (values.length < 2) return [];

  const header = values[0].map((h) => String(h).trim().toLowerCase());
  const col = (name: string) => header.findIndex((h) => h.includes(name));
  const idx = {
    technician: col('technician'),
    customer: col('customer'),
    address: col('address'),
    city: col('city'),
    state: col('state'),
    postal: col('postal'),
    phone: col('phone'),
    start: col('start'),
    end: col('end'),
  };

  const rows: ScheduleRow[] = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    const cell = (j: number) =>
      j >= 0 && r[j] != null && String(r[j]).trim() !== '' ? String(r[j]).trim() : null;
    const technicianRef = cell(idx.technician);
    if (!technicianRef) continue; // skip blank rows
    rows.push({
      rowKey: String(i + 1),
      technicianRef,
      customerName: cell(idx.customer),
      addressLine1: cell(idx.address),
      city: cell(idx.city),
      state: cell(idx.state),
      postalCode: cell(idx.postal),
      phone: cell(idx.phone),
      scheduledStart: cell(idx.start),
      scheduledEnd: cell(idx.end),
    });
  }
  return rows;
};

// One-way Sheet → spine sync (manager edits the sheet; we mirror it). Idempotent
// via upsertScheduleEntry's (tenant_id, external_row_key) conflict target.
// Write-back of resolved customer/job ids is deferred to a later phase.
//
// LOOSE ref enforcement (decided 2026-07-02): a row whose technician column
// matches no roster ref is STILL upserted (the sheet is the manager's ground
// truth; a typo must not break the whole sync) but flagged to the manager with
// a did-you-mean suggestion — an unmatched ref otherwise disables
// schedule-assisted matching for that person with no error anywhere.
export async function syncScheduleFromSheet(
  tenantId: string,
  spreadsheetId: string,
  deps: {
    read?: SheetReader;
    roster?: typeof listTeam;
    flagReview?: typeof upsertOpenReviewItem;
  } = {},
): Promise<{ upserted: number; flagged: number }> {
  const read = deps.read ?? googleSheetReader;
  const roster = deps.roster ?? listTeam;
  const flagReview = deps.flagReview ?? upsertOpenReviewItem;
  const rows = await read(spreadsheetId);
  // One roster read per sync. Offboarding/offboarded people are not valid
  // schedule targets — their refs flag like any other unknown value.
  // A roster-read failure hard-fails the sync ON PURPOSE: nothing has been
  // upserted yet (no partial state) and the periodic sync retries next run —
  // unlike the per-row flag write below, which is advisory.
  const team = await roster(tenantId);
  const known = new Set(team.filter((t) => !isInactiveState(t.state)).map((t) => t.ref));
  const knownRefs = [...known]; // hoisted: closestRef runs per unmatched row
  // An EMPTY roster means this tenant hasn't adopted the technicians table yet
  // (pre-backfill) — flagging would open one review item per unique sheet ref,
  // all with null suggestions: a queue flood with zero signal. Validate only
  // once at least one active roster row exists.
  const rosterAdopted = known.size > 0;
  let flagged = 0;
  for (const row of rows) {
    await upsertScheduleEntry({
      tenantId,
      technicianRef: row.technicianRef,
      externalRowKey: row.rowKey,
      customerName: row.customerName ?? null,
      addressLine1: row.addressLine1 ?? null,
      city: row.city ?? null,
      state: row.state ?? null,
      postalCode: row.postalCode ?? null,
      phone: row.phone ?? null,
      scheduledStart: row.scheduledStart ?? null,
      scheduledEnd: row.scheduledEnd ?? null,
    });
    if (rosterAdopted && !known.has(row.technicianRef)) {
      // Advisory, like the webhook's unknown-ref flag: a failed flag write must
      // not abort the import mid-loop (the upsert above is the ground truth).
      // Concrete trigger: upsertOpenReviewItem throws if the manager resolves
      // the open item between its insert-conflict and follow-up select.
      try {
        await flagReview({
          tenantId,
          kind: 'sheet_ref_mismatch',
          subjectRef: row.technicianRef,
          suggestion: closestRef(row.technicianRef, knownRefs),
          detail: { rowKey: row.rowKey },
        });
        flagged++;
      } catch {
        /* advisory */
      }
    }
  }
  return { upserted: rows.length, flagged };
}
