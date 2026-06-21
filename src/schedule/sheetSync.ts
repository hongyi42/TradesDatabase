import { google } from 'googleapis';
import { upsertScheduleEntry } from '../db/index.js';

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
export async function syncScheduleFromSheet(
  tenantId: string,
  spreadsheetId: string,
  deps: { read?: SheetReader } = {},
): Promise<{ upserted: number }> {
  const read = deps.read ?? googleSheetReader;
  const rows = await read(spreadsheetId);
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
  }
  return { upserted: rows.length };
}
