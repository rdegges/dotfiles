export const meta = {
  name: 'pr-bdfl-gate',
  description: 'Phase A: cluster-aware BDFL direction gate over every open non-maintainer PR of a skills registry. The project-specific inputs (repo, project, maintainer persona, audience, institutional context) are required args: the orchestrator reads them from the maintainer context note and passes them in.',
  whenToUse: 'Before the panel loop: pass every open non-maintainer PR as args.prs = [{ n, author, title, note }], plus args.today, and args.repo, args.project, args.maintainer, args.maintainerShort, args.audience, args.context from the maintainer context note. Then pass the ADVANCE verdicts to pr-panel-loop.',
  phases: [
    { title: 'Gate', detail: 'one BDFL judgment per PR, cluster-aware' },
  ],
}

// args: { prs: [{ n, author, title, note }], today, repo, project, maintainer,
// maintainerShort, audience, context } — the per-PR cluster note is the
// cross-PR context (siblings touching the same skill, suspected duplicates,
// recorded decisions the PR brushes against). Pass guidance via files when
// large; Workflow args can arrive as a JSON STRING.
const ARGS = typeof args === 'string' ? JSON.parse(args) : (args || {})
const PRS = ARGS.prs
if (!ARGS.today) throw new Error('pass args.today as YYYY-MM-DD (Date is unavailable in workflow scripts)')
if (!Array.isArray(PRS) || PRS.length === 0) throw new Error('pass args.prs = [{ n, author, title, note }]')

// Everything project-specific lives in the maintainer's private context note,
// not here, so this script can live in a public repo. Fail closed on any gap.
function required(name, what) {
  const v = ARGS[name]
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`pass args.${name}: ${what} (from the maintainer context note)`)
  return v
}
const REPO = required('repo', 'absolute path to the local clone')
const PROJECT = required('project', 'project display name')
const MAINTAINER = required('maintainer', 'full name of the maintainer persona')
const MAINTAINER_SHORT = required('maintainerShort', 'short name used in "in <name>\'s voice"')
const AUDIENCE = required('audience', 'who a merge ships to, completing "It ships to …"')
// {{today}} in the context text is replaced with args.today.
const CONTEXT = required('context', 'the INSTITUTIONAL CONTEXT block: conventions and dated maintainer rulings').trim().split('{{today}}').join(ARGS.today)

const GATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pr', 'verdict', 'direction_rationale', 'naming_and_conventions', 'required_changes', 'panel_guidance', 'merge_dependencies', 'draft_comment', 'confidence'],
  properties: {
    pr: { type: 'number' },
    verdict: { type: 'string', enum: ['ADVANCE', 'ADVANCE_AFTER_DEPENDENCY', 'REJECT', 'SUPERSEDED', 'DEFER'] },
    direction_rationale: { type: 'string', description: '3-6 sentences: the BDFL judgment on whether this idea makes the registry better long-term, and why' },
    naming_and_conventions: { type: 'string', description: 'verdict on the name + structural conventions, with the compliant alternative if wrong' },
    required_changes: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['severity', 'issue', 'suggested_fix'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          issue: { type: 'string' },
          suggested_fix: { type: 'string' },
        },
      },
    },
    panel_guidance: { type: 'string', description: 'for ADVANCE*: what the engineer/tester/red-team/security lenses should dig into for THIS PR specifically; empty string otherwise' },
    merge_dependencies: { type: 'array', items: { type: 'number' }, description: 'PR numbers that must land (or be decided) before this one' },
    draft_comment: { type: 'string', description: `for REJECT/SUPERSEDED/DEFER: the polite PR comment in ${MAINTAINER_SHORT}'s voice; empty string for ADVANCE*` },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
}

phase('Gate')
log(`BDFL gate over ${PRS.length} PRs`)

const results = await pipeline(PRS, (pr) =>
  agent(
    `You are the BDFL acceptance gate for ${PROJECT} PR #${pr.n} — "${pr.title}" by ${pr.author}.

PERSONA: You are ${MAINTAINER} — ${PROJECT}'s BDFL and sole maintainer, a very senior AI engineer, leader, and the vision-holder for this registry. It ships to ${AUDIENCE}; a merge goes live in ~30 minutes. Your job in THIS phase is the direction call only: is the idea behind this PR right for the registry in the long run? A deep technical/eval/security panel runs later — do not duplicate it.

REPO: ${REPO} (local clone; run read-only git/gh commands from there).

DO, IN ORDER:
1. Read ${REPO}/skills/README.md fully (review bar, description bar, naming, generic-primitive pattern, live-system rules, eval rules) and skim ${REPO}/CONTRIBUTING.md (confidentiality, distribution, branch rules).
2. Run: cd ${REPO} && gh pr view ${pr.n} --json title,body,author,additions,deletions,files && gh pr diff ${pr.n} | head -c 120000 — for large PRs read every SKILL.md frontmatter/description change fully and sample the rest deliberately (references, scripts, evals). Also run: gh pr checks ${pr.n} (treat CI as signal; recall misses are informational, precision failures matter).
3. If the PR adds or reshapes a skill, read the CURRENT state of the affected skill(s) on main under ${REPO}/skills/ to judge the delta honestly — including each affected skill's existing description, to judge routing collisions.
4. Weigh everything against the institutional context below. Prior maintainer decisions are YOUR OWN recorded precedents — a PR that contradicts one needs strong new evidence to advance.

INSTITUTIONAL CONTEXT:
${CONTEXT}

CLUSTER CONTEXT FOR THIS PR:
${pr.note}

JUDGE (the BDFL questions):
- Will this increase the long-run quality of the registry? Is it the right SHAPE (profile in an existing primitive vs new skill vs merge into a sibling)?
- Should it be named this way (kebab-case, verb-led, no prefixes)?
- Does it fit conventions structurally (only skills/ + shared-references/ edited; references/ and scripts/ used correctly; evals present; frontmatter complete)?
- Does it fight an existing skill or a sibling PR for routing?
- Any confidentiality red flags visible at a skim?
- Is it superseded by, in conflict with, or dependent on a sibling PR from the queue? Say which should win and why.

VERDICTS: ADVANCE (idea is right; the panel will polish it), ADVANCE_AFTER_DEPENDENCY (right, but sequenced behind a named sibling/decision), REJECT (the idea itself is not right for this repo), SUPERSEDED (a sibling PR does the same job better — name it), DEFER (right idea, wrong time — name the unblock condition).
Bias: if the idea will be good in the long run, ADVANCE and let the loop fix the execution. REJECT is for ideas that are fundamentally wrong for the registry (hub resurrections, routing forks of healthy primitives, stale event-bound skills with no durable core), not for fixable flaws.

FOR REJECT/SUPERSEDED/DEFER — draft_comment: write the PR comment in ${MAINTAINER_SHORT}'s voice: warm, direct, plain English, no emojis, no corporate hedging. Thank the author for the specific work (name something genuinely good in it), state the decision plainly, explain the WHY grounded in the repo's conventions and recorded decisions (cite files/sections like the generic-primitive section of skills/README.md), and give a concrete path forward (where the durable parts should live, what a future version would need, or which sibling PR wins and why). If parts are worth harvesting, say exactly which files/ideas.

FOR ADVANCE* — panel_guidance: the specific, PR-shaped things each lens should dig into (engineer: structure/fallbacks/routing; tester: which evals to run or add; red-team: what could be missed; security: what to probe).

BOUNDARIES: read-only. Do NOT post comments, approve, close, merge, push, or write any file. Do NOT run eval suites (tester's job later). Your entire output is the single StructuredOutput JSON.`,
    { schema: GATE_SCHEMA, label: `bdfl:#${pr.n}`, phase: 'Gate' }
  )
)

const out = results.filter(Boolean)
log(`Gate complete: ${out.length}/${PRS.length} verdicts returned`)
return {
  verdicts: out,
  missing: PRS.filter((p) => !out.some((r) => r.pr === p.n)).map((p) => p.n),
}
