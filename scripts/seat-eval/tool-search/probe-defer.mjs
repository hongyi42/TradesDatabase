import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { defineTool } from '@github/copilot-sdk';
import { makeClient, KEY, MANAGER_DOCTRINE } from './seat.mjs';
import { SPINE, SPINE_ENV } from './spine-env.mjs';
const client = makeClient(mkdtempSync(join(tmpdir(), 'pd-'))); await client.start();
const search = () => defineTool('tool_search_tool', { overridesBuiltInTool: true, description: 'Load tools.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, handler: () => ({ textResultForLlm: 'x', resultType: 'success', toolReferences: [] }) });
const variants = {
  A_custom_only: { availableTools: ['mcp:*', 'custom:*'], toolSearch: { enabled: true, deferThreshold: 1 }, tools: [search()] },
  B_plus_builtin_name: { availableTools: ['mcp:*', 'custom:*', 'builtin:tool_search_tool'], toolSearch: { enabled: true, deferThreshold: 1 }, tools: [search()] },
  C_builtin_no_override: { availableTools: ['mcp:*', 'custom:*', 'builtin:tool_search_tool'], toolSearch: { enabled: true, deferThreshold: 1 }, tools: [] },
  D_bare_name: { availableTools: ['mcp:*', 'custom:*', 'tool_search_tool'], toolSearch: { enabled: true }, tools: [search()] },
};
for (const [name, v] of Object.entries(variants)) {
  const s = await client.createSession({ model: '@preset/trades-seats', provider: { type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKey: KEY, wireApi: 'responses' }, systemMessage: { mode: 'replace', content: 'x' }, largeOutput: { enabled: false }, mcpServers: { spine: { ...SPINE, type: 'stdio', env: SPINE_ENV, tools: ['*'] } }, onPermissionRequest: () => ({ kind: 'approve-once' }), ...v });
  await new Promise((r) => setTimeout(r, 4000));
  const m = await s.rpc.tools.getCurrentMetadata();
  const tools = m.tools ?? [];
  const keys = tools[0] ? Object.keys(tools[0]) : [];
  const deferred = tools.filter((t) => t.deferred || t.isDeferred || t.defer === true || t.loadingMode === 'deferred').length;
  console.log(name, `tools=${tools.length} deferred=${deferred} keys=${keys.join(',')} search=${tools.filter((t) => /search/.test(t.name)).map((t) => JSON.stringify(t)).join(' ')}`);
  await s.disconnect();
}
await client.stop();
