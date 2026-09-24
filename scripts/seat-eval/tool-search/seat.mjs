// Shared: a manager seat on the Copilot SDK engine against the LOCAL spine.
//
// The engine's own tool search never defers our tools (measured 2026-09-23:
// 0 of 45 deferred under every config tried), so the GLUE runs the search:
// spine tools are served as the glue's OWN tools (each proxies one MCP call to
// the spine), every handler is registered, but the MODEL only sees a chosen set
// — core tools + `find_tools` — changed mid-turn with session.rpc.tools.set.
// `find_tools(query)` asks a retriever (LLM reference, or Jev) and adds what it
// returns. mode 'all' shows every tool from the start (the no-search baseline).
import { readFileSync } from 'node:fs';
import { CopilotClient, defineTool } from '@github/copilot-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SPINE, SPINE_ENV } from './spine-env.mjs';

const WT = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const { PORTED_BLOCKS, applyUpdates } = await import(`${WT}/dist/seatGlue/doctrine.js`);

export const KEY = (process.env.OPENROUTER_API_KEY ?? readFileSync(process.env.KEY_ENV_FILE ?? '.env', 'utf8').match(/^OPENROUTER_API_KEY=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, ''));
if (!KEY) throw new Error('no OPENROUTER_API_KEY');

const SPINE_TOOLS = JSON.parse(readFileSync(new URL('./catalog-spine.json', import.meta.url), 'utf8'));
const FILE_TOOLS = [
  { name: 'write_file', description: "Write a file (text or base64) in the manager's sandbox.", inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'read_file', description: "Read a file from the manager's sandbox.", inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'run_command', description: "Run a shell command or Python script in the manager's sandbox (openpyxl, reportlab, pandas available). Used to build PDFs, spreadsheets and summaries from data.", inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'share_file', description: "Send a file from the manager's sandbox to someone: the manager on Telegram, a customer, the accountant. Leaves the firm when sent outside it.", inputSchema: { type: 'object', properties: { path: { type: 'string' }, to: { type: 'string' } }, required: ['path', 'to'] } },
];
export const CATALOG = [...SPINE_TOOLS, ...FILE_TOOLS].map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema }));
/** Always visible, whatever the search returns. */
export const CORE = ['resolve_date', 'find_customer', 'get_job'];

const MANAGER_PREAMBLE = (search) => [
  '# Trades manager assistant',
  '',
  "You are the AI assistant a trades business MANAGER texts on Telegram. You act for the manager's firm through your tools.",
  '(The rules below sometimes write tool names with a `spine-` prefix; your tools have no prefix: `spine-resolve_date` is `resolve_date`.)',
  '',
  'You have a sandbox for files: run_command runs Python there (openpyxl, reportlab, pandas) to build PDFs and spreadsheets;',
  'write_file / read_file handle files in it; share_file sends a file out of it. ask_user asks the manager a question with answer buttons.',
  ...(search ? [
    '',
    'Only a few of your tools are loaded. Call find_tools to load more: describe ONE capability per call in plain words',
    '(for example "record a payment on a job" or "move a booked visit to another day"). Call it again whenever you need',
    'something you do not have. Never tell the manager you lack a tool before you have searched for it.',
  ] : []),
].join('\n');
export const doctrine = (search) => [MANAGER_PREAMBLE(search), ...PORTED_BLOCKS.map(applyUpdates)].join('\n\n');

export function makeClient(baseDirectory) {
  return new CopilotClient({ mode: 'empty', baseDirectory, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', TZ: 'America/Los_Angeles' }, logLevel: 'error' });
}

/** One MCP client to the local spine per worker (stdio child process). */
export async function spineClient() {
  const c = new Client({ name: 'tooleval-glue', version: '0' });
  await c.connect(new StdioClientTransport({ ...SPINE, env: SPINE_ENV }));
  return c;
}

const mcpText = (r) => (r?.content ?? []).map((p) => (p.type === 'text' ? p.text : `[${p.type}]`)).join('\n') || (r?.isError ? 'error' : 'ok');

/**
 * Run one item. mode: 'search' (core + find_tools, retriever decides) | 'all'.
 * retrieve(query) -> Promise<string[]> of catalog names.
 */
export async function runItem(client, spine, item, { retrieve, mode = 'search', timeoutMs = 240_000 }) {
  const log = [];
  let phase = 'context';
  const visible = new Set(mode === 'all' ? CATALOG.map((t) => t.name) : CORE);
  const handlerFor = (t) => async (args) => {
    if (FILE_TOOLS.some((f) => f.name === t.name)) {
      return t.name === 'read_file' ? 'customer,job,amount\nMaria Gonzalez,AC repair,450.00' : t.name === 'run_command' ? 'exit 0\nwrote /work/output file' : 'ok';
    }
    try { return mcpText(await spine.callTool({ name: t.name, arguments: args ?? {} }, undefined, { timeout: 60_000 })); } catch (e) { return `error: ${e.message}`; }
  };
  const allTools = CATALOG.map((t) => defineTool(t.name, { description: t.description, parameters: t.inputSchema, handler: handlerFor(t) }));
  let session;
  const defs = () => [...CATALOG.filter((t) => visible.has(t.name)).map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })), ...(mode === 'search' ? [FIND_DEF] : [])];
  const FIND_DEF = { name: 'find_tools', description: 'Load tools you do not have yet. Describe ONE capability you need in plain words; the matching tools are added and you can call them next.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'The capability you need, in plain words.' } }, required: ['query'] } };
  const findTool = defineTool('find_tools', {
    description: FIND_DEF.description, parameters: FIND_DEF.parameters,
    handler: async ({ query }) => {
      const t0 = Date.now();
      let names = [];
      let err = null;
      try { names = await retrieve(String(query ?? '')); } catch (e) { err = e.message; }
      names = names.filter((n) => CATALOG.some((c) => c.name === n));
      const added = names.filter((n) => !visible.has(n));
      for (const n of names) visible.add(n);
      if (added.length) await session.rpc.tools.set({ tools: defs() });
      log.push({ phase, search: String(query ?? ''), returned: names, added, ms: Date.now() - t0, err });
      return names.length ? `Loaded: ${names.join(', ')}. You can call them now.` : 'No matching tools. Describe the capability differently.';
    },
  });
  const initial = [...allTools.filter((t) => visible.has(t.name)), ...(mode === 'search' ? [findTool] : [])];
  session = await client.createSession({
    model: '@preset/trades-seats',
    provider: { type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKey: KEY, wireApi: 'responses', maxPromptTokens: 100_000 },
    systemMessage: { mode: 'replace', content: doctrine(mode === 'search') },
    availableTools: ['custom:*', 'builtin:ask_user'],
    toolSearch: { enabled: false },
    largeOutput: { enabled: false },
    tools: initial,
    onPermissionRequest: () => ({ kind: 'approve-once' }),
    onUserInputRequest: (req) => { log.push({ phase, askUser: String(req.question ?? '').slice(0, 160) }); return { answer: req.choices?.[0] ?? 'Yes, go ahead.', wasFreeform: !req.choices?.length }; },
  });
  // Every handler known locally; the model sees only `visible` (+ find_tools).
  session.registerTools([...allTools, ...(mode === 'search' ? [findTool] : [])]);
  const usage = { calls: 0, input: 0, output: 0, cached: 0, generations: [] };
  let idleResolve = null;
  const replies = [];
  session.on((e) => {
    const d = e.data ?? {};
    if (e.type === 'tool.execution_start' && d.toolName !== 'find_tools') log.push({ phase, call: d.toolName, visible: visible.has(d.toolName) || d.toolName === 'ask_user' });
    else if (e.type === 'assistant.usage') { usage.calls++; usage.input += d.inputTokens ?? 0; usage.output += d.outputTokens ?? 0; usage.cached += d.cacheReadTokens ?? 0; if (d.apiCallId) usage.generations.push(d.apiCallId); }
    else if (e.type === 'assistant.message' && typeof d.content === 'string' && d.content.trim() && !(Array.isArray(d.toolRequests) && d.toolRequests.length)) replies.push({ phase, text: d.content.trim().slice(0, 400) });
    else if (e.type === 'session.error') log.push({ phase, error: `${d.errorType ?? ''} ${d.message ?? ''}`.slice(0, 200) });
    else if (e.type === 'session.idle' && idleResolve) { const r = idleResolve; idleResolve = null; r(); }
  });
  const turn = async (prompt) => {
    const idle = new Promise((r) => { idleResolve = r; });
    await session.send({ prompt });
    return Promise.race([idle.then(() => false), new Promise((r) => setTimeout(() => r(true), timeoutMs))]);
  };
  let timedOut = false;
  const ctxUser = Array.isArray(item.context) ? item.context.find((c) => c.role === 'user') : null;
  if (ctxUser) timedOut = await turn(ctxUser.text);
  phase = 'test';
  const u0 = { ...usage };
  const t0 = Date.now();
  if (!timedOut) timedOut = await turn(item.text);
  const secs = Math.round((Date.now() - t0) / 1000);
  await session.disconnect().catch(() => {});
  const testUsage = { calls: usage.calls - u0.calls, input: usage.input - u0.input, output: usage.output - u0.output, cached: usage.cached - u0.cached };
  return { id: item.id, mode, log, replies, usage: testUsage, generations: usage.generations, timedOut, secs, visibleAtEnd: visible.size };
}

export async function keyUsage() {
  const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${KEY}` } });
  const d = (await r.json()).data;
  return { usage: d.usage, remaining: d.limit_remaining };
}
