import { describe, expect, it, vi } from 'vitest';
import { MANAGER_DOCTRINE, TECHNICIAN_DOCTRINE } from './doctrine.js';
import { sessionConfig, type EngineConfig, type SeatHooks } from './engine.js';
import { TurnPolicy } from './turnPolicy.js';

// The session config the engine is handed — pure, no SDK needed (engine.ts only
// loads the SDK inside startEngine).
const TOKEN = `st_${'ab'.repeat(32)}`;
const base = (tier: 'manager' | 'technician'): EngineConfig => ({
  seatRef: 's2',
  stateDir: '/tmp/x',
  tz: 'America/Los_Angeles',
  model: '@preset/trades-seats',
  openrouterKey: 'or-key',
  spineUrl: 'https://spine.example/mcp',
  seatToken: TOKEN,
  tier,
});
const hooks: SeatHooks = {
  onUserInput: async () => ({ answer: 'a', wasFreeform: false }),
  onExitPlan: async () => ({ approved: true }),
};
interface Cfg {
  systemMessage: unknown;
  availableTools: unknown;
  toolSearch: unknown;
  mcpServers: Record<string, { url: string; headers: unknown; timeout: number }>;
  onUserInputRequest?: unknown;
  onExitPlanModeRequest?: unknown;
}
type Perm = (r: { kind: string; serverName?: string; toolName?: string; toolCallId?: string }) => { kind: string };

describe('sessionConfig — the manager seat (step 2a)', () => {
  it('a manager gets the manager rulebook, two tool servers and the two built-ins', () => {
    const c = sessionConfig(base('manager'), new TurnPolicy(), hooks) as unknown as Cfg;
    expect(c.systemMessage).toEqual({ mode: 'replace', content: MANAGER_DOCTRINE });
    expect(c.availableTools).toEqual(['mcp:*', 'builtin:ask_user', 'builtin:exit_plan_mode']);
    expect(c.toolSearch).toEqual({ enabled: false });
    expect(Object.keys(c.mcpServers)).toEqual(['spine', 'composio']);
    expect(c.mcpServers.composio.url).toBe('https://spine.example/composio');
    // Same seat token on both — the relay resolves it like the spine does.
    expect(c.mcpServers.composio.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(c.mcpServers.composio.timeout).toBe(300_000);
    expect(typeof c.onUserInputRequest).toBe('function');
    expect(typeof c.onExitPlanModeRequest).toBe('function');
  });

  it("a technician's config is exactly what it was before step 2a", () => {
    const c = sessionConfig(base('technician'), new TurnPolicy(), hooks) as unknown as Cfg;
    expect(c.systemMessage).toEqual({ mode: 'replace', content: TECHNICIAN_DOCTRINE });
    expect(c.availableTools).toEqual(['mcp:*']);
    expect(Object.keys(c.mcpServers)).toEqual(['spine']);
    expect(c.mcpServers.spine).toEqual({
      type: 'http',
      url: 'https://spine.example/mcp',
      tools: ['*'],
      timeout: 300_000,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(c.onUserInputRequest).toBeUndefined();
    expect(c.onExitPlanModeRequest).toBeUndefined();
  });

  it('approves spine and composio calls (pending from the handler), rejects anything else', () => {
    const policy = new TurnPolicy();
    const perm = (sessionConfig(base('manager'), policy, hooks) as { onPermissionRequest: Perm }).onPermissionRequest;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(perm({ kind: 'mcp', serverName: 'composio', toolName: 'composio-GMAIL_SEND', toolCallId: 'c1' })).toEqual({ kind: 'approve-once' });
    expect(policy.toolPending).toBe(true);
    expect(perm({ kind: 'mcp', serverName: 'spine', toolName: 'spine-get_job', toolCallId: 'c2' })).toEqual({ kind: 'approve-once' });
    expect(perm({ kind: 'mcp', serverName: 'someone-else', toolName: 'x' })).toEqual({ kind: 'reject' });
    expect(perm({ kind: 'shell', toolName: 'bash' })).toEqual({ kind: 'reject' });
    // The two built-ins, if the engine asks about them at all (unmeasured).
    expect(perm({ kind: 'custom-tool', toolName: 'ask_user' })).toEqual({ kind: 'approve-once' });
    expect(perm({ kind: 'custom-tool', toolName: 'exit_plan_mode' })).toEqual({ kind: 'approve-once' });
    // A tool server we never configured cannot borrow a built-in's name.
    expect(perm({ kind: 'mcp', serverName: 'rogue', toolName: 'ask_user' })).toEqual({ kind: 'reject' });
  });

  it('a technician may not use the manager built-ins', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const perm = (sessionConfig(base('technician'), new TurnPolicy()) as { onPermissionRequest: Perm }).onPermissionRequest;
    expect(perm({ kind: 'custom-tool', toolName: 'ask_user' })).toEqual({ kind: 'reject' });
  });
});

describe('sessionConfig — a manager\'s file tools (step 2b)', () => {
  const tool = (name: string) => ({ name, description: '', parameters: {}, handler: async () => '' });
  const tools = ['run_command', 'read_file', 'write_file', 'share_file', 'export_query'].map(tool);

  it('a manager with tools gets custom:*, the tools, and our skill folders (with the skill tool)', () => {
    const c = sessionConfig({ ...base('manager'), tools, skillsDir: '/opt/seat-glue/skills' }, new TurnPolicy(), hooks) as unknown as Cfg & {
      tools?: unknown[];
      enableSkills?: boolean;
      skillDirectories?: string[];
    };
    expect(c.availableTools).toEqual(['mcp:*', 'builtin:ask_user', 'builtin:exit_plan_mode', 'custom:*', 'builtin:skill']);
    expect(c.tools).toBe(tools);
    expect(c.enableSkills).toBe(true);
    expect(c.skillDirectories).toEqual(['/opt/seat-glue/skills']);
  });

  it('the skills are LISTED in the rulebook: it replaces the engine prompt that would have listed them', () => {
    const skills = [{ name: 'spreadsheet', description: 'How to make a spreadsheet.' }];
    const c = sessionConfig({ ...base('manager'), tools, skillsDir: '/s', skills }, new TurnPolicy(), hooks) as unknown as Cfg;
    const content = (c.systemMessage as { content: string }).content;
    expect(content.startsWith(MANAGER_DOCTRINE)).toBe(true);
    expect(content).toContain('## Skills');
    expect(content).toContain('- spreadsheet: How to make a spreadsheet.');
    // No tools, no skills section: a manager without a sandbox has the plain rulebook.
    const bare = sessionConfig({ ...base('manager'), skillsDir: '/s', skills }, new TurnPolicy(), hooks) as unknown as Cfg;
    expect(bare.systemMessage).toEqual({ mode: 'replace', content: MANAGER_DOCTRINE });
  });

  it('a manager WITHOUT file tools gets no skills (their scripts run on the sandbox)', () => {
    const c = sessionConfig({ ...base('manager'), skillsDir: '/opt/seat-glue/skills' }, new TurnPolicy(), hooks) as Record<string, unknown>;
    expect(c.enableSkills).toBeUndefined();
    expect(c.availableTools).toEqual(['mcp:*', 'builtin:ask_user', 'builtin:exit_plan_mode']);
  });

  it('a technician never carries them, even if handed some: the whole config is unchanged', () => {
    const withTools = sessionConfig({ ...base('technician'), tools }, new TurnPolicy()) as Record<string, unknown>;
    const without = sessionConfig(base('technician'), new TurnPolicy()) as Record<string, unknown>;
    expect(Object.keys(withTools)).toEqual(Object.keys(without));
    const data = (c: Record<string, unknown>) => JSON.parse(JSON.stringify(c));
    expect(data(withTools)).toEqual(data(without));
    expect(withTools.tools).toBeUndefined();
  });

  it('a file-tool call is approved AND marked pending; an unknown custom tool is refused', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const policy = new TurnPolicy();
    policy.onSend();
    const perm = (sessionConfig({ ...base('manager'), tools }, policy, hooks) as { onPermissionRequest: Perm }).onPermissionRequest;
    expect(perm({ kind: 'custom-tool', toolName: 'write_file', toolCallId: 'w1' })).toEqual({ kind: 'approve-once' });
    expect(policy.toolPending).toBe(true);
    expect(policy.onlyAbortSafePending).toBe(false);
    expect(perm({ kind: 'custom-tool', toolName: 'format_disk', toolCallId: 'x1' })).toEqual({ kind: 'reject' });
    // Without tools configured, a file-tool name is refused too.
    const bare = (sessionConfig(base('manager'), new TurnPolicy(), hooks) as { onPermissionRequest: Perm }).onPermissionRequest;
    expect(bare({ kind: 'custom-tool', toolName: 'run_command', toolCallId: 'r1' })).toEqual({ kind: 'reject' });
  });
});

