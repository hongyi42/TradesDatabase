// The half a string check cannot settle (plan 2026-08-22): does the note blame
// the person, and does it assert anything the gap block did not contain.
//
// The judge sees the BLOCK and the NOTE and nothing else — never the
// deterministic verdict, never the scenario's `why`. A judge shown the answer
// grades the answer.
//
// Cheaper tier than the planner on purpose: this is a reading-comprehension
// task over two short texts, not the task under test.

const JUDGE_TOOL = {
  name: 'verdict',
  description: 'Your judgment on the note.',
  inputSchema: {
    type: 'object',
    properties: {
      blamesPerson: { type: 'boolean', description: 'Does it suggest the technician is at fault, avoided, or ignored us?' },
      unsupportedClaims: {
        type: 'array',
        items: { type: 'string' },
        description: 'Every factual claim in the note that the block does NOT support. Quote them. Empty if none.',
      },
      wouldActOnIt: { type: 'boolean', description: 'Could a busy manager tell what is being asked of them, in one read?' },
      note: { type: 'string', description: 'One sentence of reasoning.' },
    },
    required: ['blamesPerson', 'unsupportedClaims', 'wouldActOnIt', 'note'],
  },
};

const SYSTEM = [
  'You are checking one sentence a system wrote for a busy trades-business manager.',
  'You are given the RECORD BLOCK the system had, and the NOTE it produced.',
  '',
  'Judge exactly two things and nothing else:',
  '  1. Does the note suggest the technician is at fault? It must not. Silence is',
  '     not avoidance — the person may not know the answer, or may not even have',
  '     been on that job. Reporting a fact ("we asked", "no note has landed") is',
  '     NOT blame; implying they ignored, refused or neglected it is.',
  '  2. Does the note assert anything the block does not support? Quote each one.',
  '     A claim the block contradicts counts. So does a claim the block is simply',
  '     silent about. Rewording something the block DOES say is fine.',
  '',
  'Then say whether a manager could act on it in one read.',
].join('\n');

export async function judgeNote({ block, note, model, apiKey, callPlanner }) {
  const user = `RECORD BLOCK:\n${block}\n\nNOTE:\n${note}`;
  const res = await callPlanner({ system: SYSTEM, tool: JUDGE_TOOL, user, model, apiKey });
  return { verdict: res.plan, cost: res.cost };
}
