import { randomUUID } from 'node:crypto';
import type { Database } from './database.types.js';
import { getClient } from './client.js';
import { getObject, putObject, removeObject } from './fileStore.js';
import { wrapDbError } from './rawCaptures.js';
import { type TechnicianView, viewHasCustomer, viewHasJob, viewShowsMoney } from './technicianView.js';

// The file store (plan 2026-09-28-step-2d-files): photos and documents people
// send their seats, and files the manager's bot makes, kept and attached to a
// customer, job, visit or ledger entry. Bytes in Storage (fileStore.ts); one
// `files` row each; one `file_links` row per attachment.
//
// Deletable (operator 2026-09-28): the row is stamped deleted FIRST, then the
// bytes go — a failed removal leaves hidden orphan bytes, never a visible row
// whose bytes are gone. Every reader here filters deleted rows.

export type FileRow = Database['public']['Tables']['files']['Row'];
export type FileLinkRow = Database['public']['Tables']['file_links']['Row'];
export type FileKind = 'photo' | 'document';
export type FileSource = 'telegram' | 'sandbox';

/** 20 MB — Telegram's bot download limit, and the one ceiling for every way in. */
export const FILE_MAX_BYTES = 20 * 1024 * 1024;

export type FileTarget =
  | { customerId: string }
  | { jobId: string }
  | { visitId: string }
  | { moneyEventId: number };

/** A link's target, with the job and customer it sits under (for the view check). */
export interface ResolvedLink {
  kind: 'customer' | 'job' | 'visit' | 'money';
  customerId: string | null;
  jobId: string | null;
}

/** Who is asking. Managers and the planner see the firm's files; a technician, her view. */
export interface FileViewer {
  tier: 'manager' | 'planner' | 'technician';
  ref: string;
  personId: string | null;
  view: TechnicianView | null;
}

const targetColumn = (t: FileTarget): { col: 'customer_id' | 'job_id' | 'visit_id' | 'money_event_id'; value: string | number } =>
  'customerId' in t
    ? { col: 'customer_id', value: t.customerId }
    : 'jobId' in t
      ? { col: 'job_id', value: t.jobId }
      : 'visitId' in t
        ? { col: 'visit_id', value: t.visitId }
        : { col: 'money_event_id', value: t.moneyEventId };

/**
 * Where a target sits: its customer and job, or null when it does not exist in
 * this firm (another firm's id reads exactly like a missing one).
 */
export async function resolveTarget(tenantId: string, t: FileTarget): Promise<ResolvedLink | null> {
  const db = getClient();
  if ('customerId' in t) {
    const { data, error } = await db.from('customers').select('id').eq('id', t.customerId).eq('tenant_id', tenantId).maybeSingle();
    if (error) throw wrapDbError('resolveTarget (customer) failed', error);
    return data ? { kind: 'customer', customerId: data.id, jobId: null } : null;
  }
  if ('jobId' in t) {
    const { data, error } = await db.from('jobs').select('id, customer_id').eq('id', t.jobId).eq('tenant_id', tenantId).maybeSingle();
    if (error) throw wrapDbError('resolveTarget (job) failed', error);
    return data ? { kind: 'job', customerId: data.customer_id, jobId: data.id } : null;
  }
  if ('visitId' in t) {
    const { data, error } = await db
      .from('visits')
      .select('id, job_id, jobs!inner(customer_id)')
      .eq('id', t.visitId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) throw wrapDbError('resolveTarget (visit) failed', error);
    if (!data) return null;
    const job = data.jobs as unknown as { customer_id: string } | null;
    return { kind: 'visit', customerId: job?.customer_id ?? null, jobId: data.job_id };
  }
  const { data, error } = await db
    .from('money_events')
    .select('id, job_id, jobs!inner(customer_id)')
    .eq('id', t.moneyEventId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw wrapDbError('resolveTarget (money) failed', error);
  if (!data) return null;
  const job = data.jobs as unknown as { customer_id: string } | null;
  return { kind: 'money', customerId: job?.customer_id ?? null, jobId: data.job_id };
}

/** May this viewer see things attached to this target? Money needs the money question too. */
export function targetVisibleTo(link: ResolvedLink, who: FileViewer): boolean {
  if (who.tier !== 'technician') return true;
  const v = who.view;
  if (!v) return false;
  if (link.kind === 'customer') return !!link.customerId && viewHasCustomer(v, link.customerId);
  const jobInView = !!link.jobId && viewHasJob(v, link.jobId);
  if (link.kind !== 'money') return jobInView;
  return jobInView && viewShowsMoney(v, { jobId: link.jobId, customerId: link.customerId });
}

/**
 * The file rule (plan Decisions): managers and the planner see every live file;
 * a technician sees one she sent, or one with at least one link she may see.
 * An unlinked file is its sender's (and the managers').
 */
export function fileVisibleTo(file: FileRow, links: ResolvedLink[], who: FileViewer): boolean {
  if (file.deleted_at) return false;
  if (who.tier !== 'technician') return true;
  if ((who.personId && file.uploaded_by === who.personId) || file.uploaded_by_ref === who.ref) return true;
  return links.some((l) => targetVisibleTo(l, who));
}

export interface CreateFileInput {
  tenantId: string;
  kind: FileKind;
  fileName: string;
  mimeType: string;
  bytes: Buffer;
  uploadedByRef: string;
  uploadedBy: string | null;
  source: FileSource;
}

/** Bytes first, then the row; if the row fails, the bytes are removed (best effort). */
export async function createFile(input: CreateFileInput): Promise<FileRow> {
  if (input.bytes.length === 0) throw new Error('the file is empty');
  if (input.bytes.length > FILE_MAX_BYTES) throw new Error('the file is over 20 MB');
  const id = randomUUID();
  const storagePath = `${input.tenantId}/${id}`;
  await putObject(storagePath, input.bytes, input.mimeType);
  const { data, error } = await getClient()
    .from('files')
    .insert({
      id,
      tenant_id: input.tenantId,
      kind: input.kind,
      file_name: input.fileName.slice(0, 255) || 'file',
      mime_type: input.mimeType || 'application/octet-stream',
      size_bytes: input.bytes.length,
      storage_path: storagePath,
      uploaded_by_ref: input.uploadedByRef,
      uploaded_by: input.uploadedBy,
      source: input.source,
    })
    .select()
    .single();
  if (error || !data) {
    await removeObject(storagePath).catch(() => {});
    throw wrapDbError('createFile failed', error);
  }
  return data;
}

/** One file of this firm, live or deleted (callers decide), or null. */
export async function getFile(tenantId: string, id: string): Promise<FileRow | null> {
  const { data, error } = await getClient().from('files').select().eq('id', id).eq('tenant_id', tenantId).maybeSingle();
  if (error) throw wrapDbError('getFile failed', error);
  return data;
}

/** A file's links, each resolved to the job and customer it sits under. */
export async function linksOf(tenantId: string, fileId: string): Promise<ResolvedLink[]> {
  const { data, error } = await getClient()
    .from('file_links')
    .select('customer_id, job_id, visit_id, money_event_id')
    .eq('tenant_id', tenantId)
    .eq('file_id', fileId);
  if (error) throw wrapDbError('linksOf failed', error);
  const out: ResolvedLink[] = [];
  for (const l of data ?? []) {
    const t: FileTarget | null = l.customer_id
      ? { customerId: l.customer_id }
      : l.job_id
        ? { jobId: l.job_id }
        : l.visit_id
          ? { visitId: l.visit_id }
          : l.money_event_id !== null
            ? { moneyEventId: l.money_event_id }
            : null;
    const r = t ? await resolveTarget(tenantId, t) : null;
    if (r) out.push(r);
  }
  return out;
}

/**
 * Attach a live file to a target of the same firm. A second identical link
 * returns 'already' (insert, catch 23505: PostgREST upsert cannot name a
 * partial unique index). Throws 'file not found' / 'target not found'.
 */
export async function linkFile(
  tenantId: string,
  fileId: string,
  target: FileTarget,
  linkedByRef: string,
): Promise<'linked' | 'already'> {
  const file = await getFile(tenantId, fileId);
  if (!file || file.deleted_at) throw new Error('file not found');
  if (!(await resolveTarget(tenantId, target))) throw new Error('target not found');
  const { error } = await getClient()
    .from('file_links')
    .insert({
      tenant_id: tenantId,
      file_id: fileId,
      linked_by_ref: linkedByRef,
      customer_id: 'customerId' in target ? target.customerId : null,
      job_id: 'jobId' in target ? target.jobId : null,
      visit_id: 'visitId' in target ? target.visitId : null,
      money_event_id: 'moneyEventId' in target ? target.moneyEventId : null,
    });
  if (!error) return 'linked';
  const err = wrapDbError('linkFile failed', error) as Error & { code?: string };
  if (err.code === '23505') return 'already';
  throw err;
}

/** The live files attached to a target, newest first. */
export async function listFiles(tenantId: string, target: FileTarget): Promise<FileRow[]> {
  const { col, value } = targetColumn(target);
  const links = await getClient().from('file_links').select('file_id').eq('tenant_id', tenantId).eq(col, value);
  if (links.error) throw wrapDbError('listFiles (links) failed', links.error);
  const ids = [...new Set((links.data ?? []).map((l) => l.file_id))];
  if (ids.length === 0) return [];
  const { data, error } = await getClient()
    .from('files')
    .select()
    .eq('tenant_id', tenantId)
    .in('id', ids)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) throw wrapDbError('listFiles failed', error);
  return data ?? [];
}

export async function readFileBytes(file: FileRow): Promise<Buffer> {
  return getObject(file.storage_path);
}

/**
 * Stamp deleted, then remove the bytes. A failed removal is logged, not an
 * error: the row is already hidden everywhere.
 */
export async function deleteFile(tenantId: string, id: string, byRef: string): Promise<'deleted' | 'already' | 'not_found'> {
  const file = await getFile(tenantId, id);
  if (!file) return 'not_found';
  if (file.deleted_at) return 'already';
  const { data, error } = await getClient()
    .from('files')
    .update({ deleted_at: new Date().toISOString(), deleted_by_ref: byRef })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .select('id');
  if (error) throw wrapDbError('deleteFile failed', error);
  if (!data?.length) return 'already';
  try {
    await removeObject(file.storage_path);
  } catch (err) {
    console.error(`[files] removing the bytes of ${id} failed (the row is already deleted)`, err);
  }
  return 'deleted';
}
