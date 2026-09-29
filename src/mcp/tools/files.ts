import {
  type FileRow,
  type FileTarget,
  type FileViewer,
  deleteFile,
  fileVisibleTo,
  getFile,
  getTechnicianView,
  linkFile,
  linksOf,
  listFiles,
  resolveTarget,
  targetVisibleTo,
} from '../../db/index.js';
import { OUTSIDE_VIEW_NOTE, UUID_RE, callerTierOf, viewerIdOf } from './shared.js';
import type { DomainTools, ToolContext, ToolDef } from './types.js';

// The file store's doors for the AI (plan 2026-09-28-step-2d-files, Phase 2).
// Every badge sees these; each handler applies the view itself (the
// get_customer_context posture): managers see the firm's files, a technician
// what her view reaches — her own uploads, and files attached to a job, visit
// or customer in her view; money-linked files only where money is open to her.
// A file she may not see reads exactly like a missing one.

const TARGET_PROPS = {
  customerId: { type: 'string', description: 'A customer id.' },
  jobId: { type: 'string', description: 'A job id.' },
  visitId: { type: 'string', description: 'A visit (trip) id.' },
  moneyEventId: { type: 'number', description: 'A ledger entry id (managers only).' },
  documentId: { type: 'string', description: 'An invoice or estimate id (managers only).' },
} as const;

const BASE_TOOLS: readonly ToolDef[] = [
  {
    name: 'list_files',
    description:
      'List the photos and documents attached to ONE customer, job, visit, ledger entry, invoice or ' +
      'estimate, newest first. Give exactly one of customerId, jobId, visitId, moneyEventId, ' +
      'documentId. To send one to your ' +
      'person, use send_file with its id.',
    inputSchema: { type: 'object', properties: { ...TARGET_PROPS }, required: [] },
  },
  {
    name: 'link_file',
    description:
      'Attach a stored file to the customer, job, visit, ledger entry, invoice or estimate it ' +
      'belongs to. A photo or ' +
      'document your person sends arrives already saved, with its file id in the message ' +
      '("[photo saved as file <id>]"): attach it where it belongs. If you cannot tell which job or ' +
      'visit, ask them first; a photo of nothing work-related is left unattached. One file may be ' +
      'attached to several things. Give fileId and exactly one target.',
    inputSchema: {
      type: 'object',
      properties: { fileId: { type: 'string' }, ...TARGET_PROPS },
      required: ['fileId'],
    },
  },
  {
    name: 'delete_file',
    description:
      'Delete a stored file when your person asks: the file is removed for good and disappears ' +
      'everywhere it was attached. Only the person who sent it, or a manager, may delete it. No ' +
      'confirmation needed — do it and say what you deleted.',
    inputSchema: { type: 'object', properties: { fileId: { type: 'string' } }, required: ['fileId'] },
  },
];

/** Exactly one target from the args, or a thrown plain-words error. */
function targetOf(ctx: ToolContext): FileTarget {
  const given: FileTarget[] = [];
  const c = ctx.str('customerId');
  const j = ctx.str('jobId');
  const v = ctx.str('visitId');
  const m = ctx.args.moneyEventId;
  const d = ctx.str('documentId');
  if (c) given.push({ customerId: c });
  if (j) given.push({ jobId: j });
  if (v) given.push({ visitId: v });
  if (m !== undefined && m !== null && m !== '') {
    const n = Number(m);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error('moneyEventId must be a ledger entry id (a whole number)');
    given.push({ moneyEventId: n });
  }
  if (d) given.push({ documentId: d });
  if (given.length !== 1) throw new Error('give exactly one of customerId, jobId, visitId, moneyEventId, documentId');
  return given[0];
}

/** A malformed id names nothing: said as not found, never a database error. */
const wellFormed = (t: FileTarget): boolean =>
  'customerId' in t
    ? UUID_RE.test(t.customerId)
    : 'jobId' in t
      ? UUID_RE.test(t.jobId)
      : 'visitId' in t
        ? UUID_RE.test(t.visitId)
        : 'documentId' in t
          ? UUID_RE.test(t.documentId)
          : true;

/** Who is asking, for the file rule — exported for send_email's attachment (2e). */
export async function viewerOf(ctx: ToolContext): Promise<FileViewer> {
  const tier = callerTierOf(ctx);
  const personId = viewerIdOf(ctx);
  return {
    tier,
    ref: ctx.identity.technicianRef,
    personId,
    view: tier === 'technician' ? await getTechnicianView(ctx.tenantId, personId) : null,
  };
}

const shape = (f: FileRow) => ({
  id: f.id,
  kind: f.kind,
  fileName: f.file_name,
  mimeType: f.mime_type,
  sizeBytes: f.size_bytes,
  uploadedBy: f.uploaded_by_ref,
  createdAt: f.created_at,
});

/** The file if this viewer may see it, else null (missing, deleted or out of view read the same). */
export async function visibleFile(ctx: ToolContext, who: FileViewer, fileId: string): Promise<FileRow | null> {
  if (!UUID_RE.test(fileId)) return null;
  const file = await getFile(ctx.tenantId, fileId);
  if (!file || file.deleted_at) return null;
  if (who.tier !== 'technician') return file;
  return fileVisibleTo(file, await linksOf(ctx.tenantId, fileId), who) ? file : null;
}

async function handleListFiles(ctx: ToolContext): Promise<unknown> {
  const target = targetOf(ctx);
  const who = await viewerOf(ctx);
  const resolved = wellFormed(target) ? await resolveTarget(ctx.tenantId, target) : null;
  // A ledger entry a technician may not see money on reads as missing: its
  // existence is money information too.
  if (!resolved || (resolved.kind === 'money' && !targetVisibleTo(resolved, who))) {
    return { files: [], note: 'not found' };
  }
  if (!targetVisibleTo(resolved, who)) return { files: [], inView: false, note: OUTSIDE_VIEW_NOTE };
  const files = await listFiles(ctx.tenantId, target);
  if (who.tier !== 'technician') return { files: files.map(shape) };
  // Each file against the whole rule, not just this target: a file also on a
  // ledger entry whose money is closed to her stays hidden on her job's list.
  const shown: FileRow[] = [];
  for (const f of files) if (fileVisibleTo(f, await linksOf(ctx.tenantId, f.id), who)) shown.push(f);
  return { files: shown.map(shape) };
}

async function handleLinkFile(ctx: ToolContext): Promise<unknown> {
  const fileId = ctx.str('fileId');
  if (!fileId) throw new Error('fileId is required');
  const target = targetOf(ctx);
  const who = await viewerOf(ctx);
  if (!(await visibleFile(ctx, who, fileId))) return { status: 'not_found', note: 'no such file' };
  const resolved = wellFormed(target) ? await resolveTarget(ctx.tenantId, target) : null;
  // Attaching to the ledger is a manager's job; to a technician an entry
  // she may not see money on is simply not there.
  if (!resolved || (resolved.kind === 'money' && who.tier === 'technician')) {
    return { status: 'not_found', note: 'no such customer, job, visit, ledger entry or document' };
  }
  if (!targetVisibleTo(resolved, who)) return { status: 'outside_view', note: OUTSIDE_VIEW_NOTE };
  const outcome = await linkFile(ctx.tenantId, fileId, target, ctx.identity.technicianRef);
  return { status: outcome === 'linked' ? 'linked' : 'already_linked' };
}

async function handleDeleteFile(ctx: ToolContext): Promise<unknown> {
  const fileId = ctx.str('fileId');
  if (!fileId) throw new Error('fileId is required');
  const who = await viewerOf(ctx);
  const file = await visibleFile(ctx, who, fileId);
  if (!file) return { status: 'not_found', note: 'no such file' };
  // By roster row only (a ref can be reissued after a removed person's row goes).
  const own = !!who.personId && file.uploaded_by === who.personId;
  if (who.tier !== 'manager' && !own) {
    return { status: 'refused', note: 'only the person who sent this file, or a manager, can delete it' };
  }
  const outcome = await deleteFile(ctx.tenantId, fileId, ctx.identity.technicianRef);
  return outcome === 'deleted'
    ? { status: 'deleted', fileName: file.file_name }
    : { status: 'not_found', note: 'no such file' };
}

export const filesTools = {
  domain: 'files',
  base: BASE_TOOLS,
  handlers: {
    list_files: handleListFiles,
    link_file: handleLinkFile,
    delete_file: handleDeleteFile,
  },
} satisfies DomainTools;
