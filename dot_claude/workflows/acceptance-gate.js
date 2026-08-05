export const meta = {
  name: 'acceptance-gate',
  description: 'Post-implementation acceptance pipeline: tester pass, then red-team review, then the BDFL merge verdict',
  whenToUse: 'When an implementation is finished and needs its gates run before merge. Runs the gates only — it applies no fixes; REVISE/conditions go back to the orchestrator. args: { repo: "<abs path>", change: "<what to judge: branch, commit range, or \'the uncommitted changes\'>", spec: "<the original request/plan, verbatim>", runNotes: "<optional: how to run/serve the app, test commands, Docker convention — relayed to the tester>" }',
  phases: [
    { title: 'Test', detail: 'tester agent owns the suite and the visual pass' },
    { title: 'Review', detail: 'fresh-context red-team checks the diff against the spec' },
    { title: 'Gate', detail: 'BDFL renders the merge verdict on everything' },
  ],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: ['APPROVE', 'APPROVE WITH CONDITIONS', 'REVISE', 'REJECT'],
    },
    reason: { type: 'string', description: 'the one-sentence Line-1 reason' },
    conditions: {
      type: 'array',
      items: { type: 'string' },
      description: 'for APPROVE WITH CONDITIONS: bounded conditions, each executable without a further judgment call (empty otherwise)',
    },
    guidance: {
      type: 'string',
      description: 'for REVISE/REJECT: ordered rework instructions, written to be relayed verbatim (empty otherwise)',
    },
    report: { type: 'string', description: 'the full verdict report per your output contract' },
  },
  required: ['verdict', 'reason', 'conditions', 'guidance', 'report'],
  additionalProperties: false,
}

// The harness sometimes delivers args as a JSON-encoded string — normalize.
const A = typeof args === 'string' ? JSON.parse(args) : (args ?? {})

if (!A.repo || !A.change || !A.spec) throw new Error('args.repo, args.change, and args.spec are required')

// Sequential by doctrine: the tester modifies test files, so its output is part
// of the tree the red-team reviews, and the BDFL judges the final state.
phase('Test')
const testerReport = await agent(
  `Repo: ${A.repo}. The change under test: ${A.change}. Run your full process per your definition.${A.runNotes ? ` Notes: ${A.runNotes}` : ''}`,
  { agentType: 'tester', label: 'tester' },
)

phase('Review')
const redTeamReport = await agent(
  `Repo: ${A.repo}.

The spec (the original request/plan):
${A.spec}

The change to review: ${A.change}. Note: a tester agent has already run on this tree and may have added or modified TEST files — those test changes are part of the change under review (judge them too), but implementation files are the maker's work. You have deliberately not been shown the tester's report or the maker's reasoning.`,
  { agentType: 'red-team-reviewer', label: 'red-team' },
)

phase('Gate')
const gate = await agent(
  `Repo: ${A.repo}. You are gating this change for merge: ${A.change}.

The spec (the original request/plan):
${A.spec}

The tester agent's report:
${testerReport}

The red-team reviewer's report (fresh-context, independent of the tester):
${redTeamReport}

Judge per your definition. Both reports are checker input, not verdicts — verify what you need yourself. Fill every schema field; use an empty array/string for fields your verdict does not need.`,
  { agentType: 'bdfl', label: 'bdfl', schema: VERDICT_SCHEMA },
)

log(`BDFL: ${gate.verdict} — ${gate.reason}`)

return {
  verdict: gate.verdict,
  reason: gate.reason,
  conditions: gate.conditions,
  guidance: gate.guidance,
  bdflReport: gate.report,
  testerReport,
  redTeamReport,
}
