// A manager seat's own memory (plan 2026-09-24 step 2a; operator 2026-09-23:
// "Seat memory can live on a table on Render").
//
// One domain's slice of the spine's tool surface. Tier membership is
// declarative: listing the tools under `admin` puts them in ADMIN_TOOL_NAMES,
// and the hub refuses them to every non-manager badge before a handler runs.
//
// SCOPE IS ALWAYS THE CALLER. There is no `technician` argument on purpose: a
// seat reads and writes only its own person's notes, so no prompt can steer it
// into another manager's memory.
import {
  deleteSeatMemoryFile,
  listSeatMemoryPaths,
  readSeatMemoryFile,
  writeSeatMemoryFile,
} from '../../db/index.js';
import { validateMemoryContent, validateMemoryPath } from '../../teamLead/memory.js';
import type { DomainTools, ToolContext } from './types.js';

const PATH_HELP =
  'A lowercase path ending in .md, for example "prefs.md" or "invoices/terms.md".';

const ADMIN_TOOLS = [
  {
    name: 'list_my_memory',
    description:
      "List the notes you keep for your manager between conversations (manager only): their " +
      'standing preferences and working notes — how they like invoices, exports and replies, ' +
      'what they asked you to remember. Check it at the start of any task a preference could ' +
      'change. These are YOUR notes about working for this person, never the firm\'s records: ' +
      'customers, jobs, money and visits belong in the spine.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_my_memory',
    description: 'Read one of your notes by its path (manager only). Absent is an answer, not an error.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: PATH_HELP } },
      required: ['path'],
    },
  },
  {
    name: 'write_my_memory',
    description:
      'Save (or replace) one of your notes (manager only) — send the WHOLE file each time. ' +
      'Empty content deletes it. Keep a preference the manager states ("invoices are due in ' +
      '14 days") and say you will remember it. Up to 4000 characters per file; the previous ' +
      'version is kept.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: PATH_HELP },
        content: { type: 'string', description: 'The whole file, as markdown text.' },
      },
      required: ['path'],
    },
  },
];

async function handleList(toolCtx: ToolContext): Promise<unknown> {
  const { tenantId, identity } = toolCtx;
  const paths = await listSeatMemoryPaths(tenantId, identity.technicianRef);
  return {
    status: 'ok',
    paths,
    ...(paths.length ? {} : { note: 'You have no notes yet.' }),
  };
}

async function handleRead(toolCtx: ToolContext): Promise<unknown> {
  const { tenantId, identity, str } = toolCtx;
  const checked = validateMemoryPath(str('path'));
  if ('refused' in checked) throw new Error(checked.refused);
  const row = await readSeatMemoryFile(tenantId, identity.technicianRef, checked.path);
  if (!row) {
    return { status: 'ok', path: checked.path, exists: false, note: 'There is no such note.' };
  }
  return { status: 'ok', path: checked.path, exists: true, updatedAt: row.updated_at, content: row.content };
}

async function handleWrite(toolCtx: ToolContext): Promise<unknown> {
  const { args, tenantId, identity, str } = toolCtx;
  const checked = validateMemoryPath(str('path'));
  if ('refused' in checked) throw new Error(checked.refused);
  // A content key that is present but not text is a model mistake, refused —
  // never read as a delete (the planner's write_memory rule).
  if ('content' in args && args.content !== null && typeof args.content !== 'string') {
    throw new Error('content must be text — send the whole file as a string, or leave it out to delete');
  }
  const content = str('content') ?? '';
  if (content.trim().length === 0) {
    const existed = await deleteSeatMemoryFile(tenantId, identity.technicianRef, checked.path);
    return {
      status: 'ok',
      path: checked.path,
      action: 'deleted',
      note: existed ? 'Deleted. Its last content is kept as a version.' : 'There was no such note.',
    };
  }
  const sized = validateMemoryContent(checked.path, content);
  if ('refused' in sized) throw new Error(sized.refused);
  await writeSeatMemoryFile(tenantId, identity.technicianRef, checked.path, sized.content);
  return { status: 'ok', path: checked.path, action: 'saved', chars: sized.content.length };
}

export const memoryTools = {
  domain: 'memory',
  admin: ADMIN_TOOLS,
  handlers: {
    list_my_memory: handleList,
    read_my_memory: handleRead,
    write_my_memory: handleWrite,
  },
} satisfies DomainTools;
