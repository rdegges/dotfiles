export const meta = {
  name: 'pr-panel-loop',
  description: 'Phase B: per-PR evaluate-optimize review loop — 4 parallel lenses, fixer applies blockers on the PR branch, re-review until clean (exits early on a 2-round fixer stall or when only maintainer-only findings remain; 12-round runaway backstop), then a BDFL final verdict. The project-specific inputs (repo, project, maintainer persona, audience, rules, rulings) are required args: the orchestrator reads them from the maintainer context note and passes them in.',
  whenToUse: 'After the pr-bdfl-gate phase: pass the ADVANCE PRs as args.prs (each with a guidanceFile holding its gate verdict and panel_guidance), plus args.scratch, and args.repo, args.project, args.maintainer, args.maintainerShort, args.audience, args.rules, args.rulings from the maintainer context note. args.repo, args.scratch, and each guidanceFile must be absolute paths of letters, digits, and . _ / - only: paths with spaces (e.g. vault paths) are rejected.',
  phases: [
    { title: 'Panel', detail: 'engineer + tester + red-team + security lenses per PR, looped with a fixer' },
    { title: 'Final', detail: 'BDFL final verdict per PR' },
  ],
}

// args: { prs: [{ n, title, author, branch, guidanceFile, merge_dependencies }], scratch: '<abs path for worktrees>',
//   repo, project, maintainer, maintainerShort, audience, rules, rulings }
// No fixed round limit — loop until clean. Exit only on convergence, a stall
// (two consecutive rounds with zero fixer progress => escalate to the
// maintainer), or the runaway backstop below.
const ROUND_BACKSTOP = 12
const ARGS = typeof args === 'string' ? JSON.parse(args) : (args || {})
const PRS = ARGS.prs
const SCRATCH = ARGS.scratch
if (!Array.isArray(PRS) || PRS.length === 0) throw new Error('pass args.prs = [{ n, title, author, branch, guidanceFile, merge_dependencies }]')
if (!SCRATCH) throw new Error('pass args.scratch as an absolute path for the PR worktrees')

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
const MAINTAINER_SHORT = required('maintainerShort', 'short name used for voice and escalations')
const AUDIENCE = required('audience', 'who a merge ships to, completing "This registry ships to …"')
const RULES = required('rules', 'the REPO GROUND RULES block every lens and the fixer read').trim()
const RULINGS = required('rulings', 'fixer bullet on which maintainer rulings are standing orders and which stay open')

// PR records are contributor-controlled, and branch, REPO, SCRATCH, and
// guidanceFile reach `git fetch`/`git worktree add`/`git push` shell lines in
// the prompts, so validate them all before any agent starts. Duplicated in
// pr-bdfl-gate.js on purpose: workflow scripts cannot import.
const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/
function check(ok, field, what) {
  if (!ok) throw new Error(`${field}: ${what}`)
}
const isText = (v) => typeof v === 'string' && !CONTROL_CHARS.test(v)
const isSafePath = (v) => typeof v === 'string' && SAFE_PATH.test(v)
check(isSafePath(REPO), 'args.repo', 'must be an absolute path of [A-Za-z0-9._/-] only (no spaces)')
check(isSafePath(SCRATCH), 'args.scratch', 'must be an absolute path of [A-Za-z0-9._/-] only (no spaces)')
const seenN = new Set()
PRS.forEach((pr, i) => {
  const at = `args.prs[${i}]`
  check(pr !== null && typeof pr === 'object', at, 'must be an object { n, title, author, branch, guidanceFile, merge_dependencies }')
  check(Number.isInteger(pr.n) && pr.n > 0, `${at}.n`, 'must be a positive integer')
  check(!seenN.has(pr.n), `${at}.n`, `duplicate PR number ${pr.n}`)
  seenN.add(pr.n)
  for (const k of ['title', 'author']) check(isText(pr[k]), `${at}.${k}`, 'must be a string with no control characters')
  const b = pr.branch
  // Beyond the charset, mirror the `git check-ref-format --branch` rules the
  // charset lets through; `HEAD` would resolve origin/HEAD, not the PR branch.
  check(
    typeof b === 'string' && SAFE_BRANCH.test(b) && !b.includes('..') && !b.includes('//') && !b.endsWith('/') &&
      b !== 'HEAD' && !b.includes('@{') &&
      b.split('/').every((c) => !c.startsWith('.') && !c.endsWith('.') && !c.endsWith('.lock')),
    `${at}.branch`,
    'must match ^[A-Za-z0-9][A-Za-z0-9._/-]*$ and be a valid git branch: not "HEAD", no "..", "//", "@{", or trailing "/", and no path component that starts with "." or ends with "." or ".lock"'
  )
  check(isSafePath(pr.guidanceFile), `${at}.guidanceFile`, 'must be an absolute path of [A-Za-z0-9._/-] only (no spaces)')
  const deps = pr.merge_dependencies
  check(deps === undefined || (Array.isArray(deps) && deps.every(Number.isInteger)), `${at}.merge_dependencies`, 'must be an array of integers when present')
})

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lens', 'verdict', 'findings', 'evidence_of_checks'],
  properties: {
    lens: { type: 'string' },
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['severity', 'area', 'issue', 'evidence', 'suggested_fix'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          area: { type: 'string', description: 'file path or skill area the finding anchors to' },
          issue: { type: 'string' },
          evidence: { type: 'string', description: 'file:line quotes or command output proving the issue is real' },
          suggested_fix: { type: 'string' },
        },
      },
    },
    evidence_of_checks: { type: 'string', description: 'what you actually ran/read so the fixer and BDFL can trust a PASS' },
  },
}

const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['applied', 'skipped', 'pushed', 'commits', 'notes'],
  properties: {
    applied: { type: 'array', items: { type: 'string' } },
    skipped: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['finding', 'why'], properties: { finding: { type: 'string' }, why: { type: 'string' } } } },
    pushed: { type: 'boolean' },
    commits: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

const FINAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pr', 'final', 'summary_comment', 'merge_notes', 'residual_risks'],
  properties: {
    pr: { type: 'number' },
    final: { type: 'string', enum: ['APPROVE', 'ESCALATE'] },
    summary_comment: { type: 'string', description: `PR comment in ${MAINTAINER_SHORT} voice summarizing the review + what was fixed; posted at approval time` },
    merge_notes: { type: 'string', description: 'anything the merge step must know: sequencing, conflicts expected, CI to re-verify' },
    residual_risks: { type: 'array', items: { type: 'string' } },
  },
}

function lensPrompt(pr, lens, charter, round, history) {
  return `You are the ${lens} reviewer for ${PROJECT} PR #${pr.n} — "${pr.title}" by ${pr.author} (branch ${pr.branch}). Round ${round} (the loop repeats until the panel is clean).

This registry ships to ${AUDIENCE}; merge = live rollout in ~30 min. Be rigorous and adversarial toward the change, and honest when it is genuinely clean: verdict PASS means "I would ship this"; FAIL means at least one blocker/major remains. Minor-only findings => PASS with the minors listed.

REPO: ${REPO}. Read ${REPO}/skills/README.md first. A read-only checkout of the PR branch is at ${SCRATCH}/pr-${pr.n} (git worktree). Inspect the change with: cd ${REPO} && gh pr diff ${pr.n}, plus direct reads in the worktree. gh pr checks ${pr.n} and the CI-posted PR comments (gh pr view ${pr.n} --comments) show eval/lint results of record.

${RULES}

BDFL GATE GUIDANCE FOR THIS PR: Read ${pr.guidanceFile} FIRST (the acceptance review's verdict, required changes, and any main-loop adjudication notes) — treat required changes as review targets to verify, not as assumptions.

YOUR CHARTER:
${charter}

${history ? `PRIOR ROUNDS (findings + what the fixer says it did — verify fixes actually landed and hunt regressions the fixes introduced):\n${history}` : ''}

Report only real, evidenced findings — no style preferences, no speculative nits. Every finding needs file:line (or command output) evidence. Boundaries: read-only — no pushes, comments, or file writes outside ${SCRATCH}/pr-${pr.n} (and even there, do not modify tracked files; scratch notes only). Output only the StructuredOutput JSON.`
}

const CHARTERS = {
  engineer: `Technical quality of the skill(s) as shipped artifacts:
- Structure: files in the right places (references/ vs scripts/ vs evals/), no dead/unreferenced files, no generated-tree (plugins/, codex-plugins/) content, frontmatter complete + name==folder, version bump + CHANGELOG sane.
- Description quality: verb-led, concrete triggers, bounded ("don't use" naming siblings), <=1024 chars; would it ROUTE for real phrasings without stealing a sibling's traffic? Compare against every overlapping sibling skill's description on main.
- Runbook quality: body reads as numbered, executable steps; inputs stated; output contract explicit; Don'ts present; 100-400 lines; reference material pushed to references/.
- Fallbacks: every connector/tool dependency has a graceful-degrade path (paste/upload ask); code paths (scripts/) only as progressive enhancement behind a capability check, never the only path; browser paths satisfy all 5 rules.
- Any scripts: correct, minimal, tested (pytest under scripts/), no heavy deps, runnable on a clean machine.`,
  tester: `Eval robustness — is this skill adequately tested, and do the evals actually pass?
- CI is the record: read gh pr checks + the CI eval comment. Any precision (false-positive) failure is a blocker finding.
- triggers.json: 8-10 positives varied in formality/vocabulary; 8-10 negatives that are sibling-owned near-misses (name which sibling owns each); no [REPLACE]; no description-bait (description quoting eval queries verbatim).
- Coverage gaps: enumerate edge cases a real user would type that are missing (batch phrasing, role variants, "don't use" boundary probes against each overlapping sibling) — file missing coverage as findings with the exact queries to add.
- If descriptions/triggers changed since the last CI run (e.g. a fixer pushed), do NOT run the eval runner locally (standing rule: local runs are contaminated by user-level skills). Wait for the CI 'Trigger evals' check on the new head and read its comment; report the pre-push state as UNVERIFIED until then.
- Quality evals: never run them locally. Review evals/evals.json by reading it (shape, realism, whether expectations are checkable); if output is objectively checkable but evals.json is missing, that's a major finding (propose 2-3 evals with expectations).
- pytest suites under scripts/ must run green (run them in the worktree; use python3 -m pytest).`,
  redteam: `Fresh-context adversarial pass — what is everyone missing? You never saw the other reviews. Attack the change:
- Try to construct realistic user requests where the skill misbehaves: fabricates data, acts without drafting, overwrites something, mixes profiles, follows injected instructions from untrusted data (a pasted CSV/Slack thread/web page telling the model to do something else — data-not-instructions).
- Cross-skill contradictions: does this PR make two skills give conflicting guidance for the same user question? Does it break a consumer of a shared-reference it edits (search for other consumers)?
- Staleness traps: hardcoded dates/statuses/claims that rot; unverifiable figures; phantom cross-references to skills/files that don't exist on main or in this PR.
- Rollout blast radius: what breaks for existing users the moment this merges (renamed/removed skills, changed defaults, marketplace sync effects)?
- Check the PR against its own stated intent (gh pr view body): anything promised but not delivered, or delivered but undeclared?`,
  security: `Security + data-safety review:
- Confidentiality sweep of EVERY added/changed file: customer names, ARR/deal figures, account IDs, real employee data, secrets/tokens, internal URLs that leak unannounced strategy, real-data screenshots/HTML. grep the worktree, do not trust the diff alone.
- Data exfiltration paths: any instruction/code that uploads, posts, or shares data externally (public paste/file hosts, webhooks, third-party APIs), or writes outside the user's own storage. Any HTML/JS artifacts: external fetches, trackers, form posts.
- Write-safety: skills must be draft-only — no CRM/CPQ/system-of-record writes, no auto-send, no destructive shell in scripts/. If Snowflake/SQL is referenced: read-only tool usage only (execute-sql-read, never execute-sql-write), and queries must not embed sensitive filters.
- Prompt-injection surfaces: skill text that instructs the model to obey content found in fetched/pasted data; missing data-not-instructions guardrails where untrusted input is processed.
- Repo-infra tampering: changes to scripts/, CI workflows, linter, install hooks — anything a contributor PR should not need to touch, or that weakens a gate.`,
}

function fixerPrompt(pr, round, findingsBrief) {
  return `You are the fixer for ${PROJECT} PR #${pr.n} — "${pr.title}" by ${pr.author}, branch ${pr.branch}, review round ${round}.

A working checkout of the PR branch exists at ${SCRATCH}/pr-${pr.n} (git worktree on branch pr-${pr.n}-review tracking origin/${pr.branch} — verify with git status; if the worktree is missing, create it: cd ${REPO} && git fetch origin ${pr.branch} && git worktree add ${SCRATCH}/pr-${pr.n} -b pr-${pr.n}-review origin/${pr.branch}).

${RULES}

Read ${pr.guidanceFile} FIRST — the BDFL gate's required changes and main-loop adjudication notes (ports, harvests, renames) are standing orders for you, whether or not a panel finding repeats them.

PANEL FINDINGS TO FIX (blockers and majors; apply minors only when trivial and zero-risk):
${findingsBrief}

RULES OF ENGAGEMENT:
- Surgical: fix exactly what the findings describe; no drive-by refactors. Match the file's existing style. US English.
- If a finding is wrong or would degrade the skill, SKIP it with a one-line why (goes back to the panel next round) — never apply a bad suggestion blindly.
- Renames (skill folder + name: field) are allowed when the findings call for one: update folder, frontmatter, all internal references, evals, and the PR-local CHANGELOG; note the rename prominently.
- After edits: bump version + CHANGELOG entry per the findings if warranted; run python3 ${REPO}/scripts/lint-skills.py (from the worktree root) and fix what it flags for the changed skill(s); run any pytest suites you touched.
- Commit from inside ${SCRATCH}/pr-${pr.n} with PATH-SCOPED adds only (git add skills/... shared-references/... — NEVER git add -A, never plugins/ or codex-plugins/ or scratch files). Concise conventional commit message explaining the review fix. End the message with the co-author attribution line your environment provides, if any.
- Push to the CONTRIBUTOR'S PR branch: git push origin HEAD:${pr.branch}. Never force-push, never rewrite their commits, never push to main.
- If the branch is behind or CONFLICTING with origin/main (gh pr view ${pr.n} --json mergeable,mergeStateStatus), integrate main FIRST with a forward merge: git fetch origin main && git merge origin/main — resolve conflicts preserving both sides' intent (sibling PRs that appended evals/negatives: keep both), re-cut the skill version ABOVE the version now on main, and put the CHANGELOG entry under that new heading. Never rebase or force-push a contributor branch.
- ${RULINGS}
- The version/CHANGELOG gate is live: every shipped-file change bumps frontmatter version with a matching '## [x.y.z] - <date>' CHANGELOG heading. Backticked file citations in SKILL.md/references must resolve to real files in the repo; bare skill names must be live skills.
- Do not post PR comments; do not merge; do not touch other PRs' branches or worktrees.

Return the StructuredOutput JSON: what you applied, what you skipped and why, whether you pushed, commit SHAs, and anything the next review round must verify.`
}

function summarizeFindings(reviews) {
  return reviews
    .filter(Boolean)
    .flatMap((r) => r.findings.map((f) => `[${r.lens}/${f.severity}] ${f.area}: ${f.issue} | evidence: ${f.evidence} | fix: ${f.suggested_fix}`))
    .join('\n')
}

async function reviewPR(pr) {
  // one-time worktree setup for this PR (fixer/tester share it; panel reads it)
  await agent(
    `Set up a git worktree for ${PROJECT} PR #${pr.n}. Run exactly: cd ${REPO} && git fetch origin ${pr.branch} && (git worktree add ${SCRATCH}/pr-${pr.n} -b pr-${pr.n}-review origin/${pr.branch} || echo exists). Confirm ${SCRATCH}/pr-${pr.n}/skills exists, then STOP and return "ok" (or the error text verbatim). Do nothing else.`,
    { label: `worktree:#${pr.n}`, phase: 'Panel', effort: 'low' }
  )

  const rounds = []
  let clean = false
  let stalledStreak = 0
  let stalled = false
  for (let round = 1; round <= ROUND_BACKSTOP && !clean && !stalled; round++) {
    const history = rounds
      .map((r, i) => `--- round ${i + 1} findings ---\n${r.findingsBrief}\n--- round ${i + 1} fixer report ---\n${r.fixReport}`)
      .join('\n')

    const reviews = await parallel(
      Object.entries(CHARTERS).map(([lens, charter]) => () =>
        agent(lensPrompt(pr, lens, charter, round, history), {
          schema: FINDINGS_SCHEMA,
          label: `${lens}:#${pr.n}:r${round}`,
          phase: 'Panel',
        })
      )
    )
    const ok = reviews.filter(Boolean)
    const blockersOrMajors = ok.flatMap((r) => r.findings).filter((f) => f.severity !== 'minor')
    const allPass = ok.length === 4 && ok.every((r) => r.verdict === 'PASS')

    if (allPass || blockersOrMajors.length === 0) {
      rounds.push({ findingsBrief: summarizeFindings(ok) || '(no findings)', fixReport: '(no fixes needed)', reviews: ok })
      clean = true
      break
    }

    const findingsBrief = summarizeFindings(ok)
    // 2026-09-11 lesson: when every remaining blocker/major is a maintainer-only
    // item (ruling, E2E evidence, owner ack), more fixer rounds cannot converge —
    // stop and hand it to the final verdict instead of burning the backstop.
    const maintainerOnly = /\b(ESCALATE|maintainer[- ]only|not fixer[- ]addressable|R[1-9]\b|E2E_EVIDENCE|owner (ack|review))/i
    if (round >= 2 && blockersOrMajors.every((f) => maintainerOnly.test(`${f.issue} ${f.suggested_fix}`))) {
      rounds.push({ findingsBrief, fixReport: '(all remaining blocker/major findings are maintainer-only — stopped early)', reviews: ok })
      stalled = true
      log(`#${pr.n} round ${round}: only maintainer-only findings remain — escalating early`)
      break
    }
    const fix = await agent(fixerPrompt(pr, round, findingsBrief), {
      schema: FIX_SCHEMA,
      label: `fixer:#${pr.n}:r${round}`,
      phase: 'Panel',
    })
    rounds.push({ findingsBrief, fixReport: fix ? JSON.stringify(fix) : '(fixer failed)', reviews: ok })
    log(`#${pr.n} round ${round}: ${blockersOrMajors.length} blocker/major findings, fixer pushed=${fix ? fix.pushed : 'n/a'}`)

    // Stall detection: a round where the fixer made no change cannot converge
    // by repetition — after two in a row, hand the PR to the maintainer instead.
    const progressed = !!fix && (fix.applied.length > 0 || fix.pushed)
    stalledStreak = progressed ? 0 : stalledStreak + 1
    if (stalledStreak >= 2) {
      stalled = true
      log(`#${pr.n}: no fixer progress for 2 consecutive rounds — escalating`)
    }
  }

  const historyBrief = rounds
    .map((r, i) => `=== round ${i + 1} ===\nFINDINGS:\n${r.findingsBrief}\nFIXER: ${r.fixReport}`)
    .join('\n')

  const final = await agent(
    `You are ${MAINTAINER} — ${PROJECT}'s BDFL — giving the FINAL verdict on PR #${pr.n} ("${pr.title}" by ${pr.author}, branch ${pr.branch}) after ${rounds.length} panel round(s). Review loop status: ${clean ? 'converged clean' : stalled ? `STALLED — ${rounds.length} rounds, no fixer progress in the last 2` : `hit the ${ROUND_BACKSTOP}-round runaway backstop without converging`}.

REPO: ${REPO}. Verify the CURRENT branch state yourself (gh pr diff ${pr.n}, gh pr checks ${pr.n}, worktree at ${SCRATCH}/pr-${pr.n} — run git -C ${SCRATCH}/pr-${pr.n} pull --ff-only first): do not take the panel's word for anything you can check in two minutes. Non-negotiables before APPROVE: CI checks green or only informational-recall failures; zero unresolved blocker findings; confidentiality clean; conventions met.

REVIEW HISTORY:
${historyBrief}

BDFL GATE CONTEXT: Read ${pr.guidanceFile} (gate verdict + required changes + adjudication notes) and confirm every gate-required change and adjudication instruction was actually satisfied.

Verdict APPROVE only if you would put your name on this shipping to ${AUDIENCE} in 30 minutes. Otherwise ESCALATE with exactly what remains (${MAINTAINER_SHORT} reviews escalations by hand). Merge sequencing concerns (sibling PRs touching the same files, dependencies: ${JSON.stringify(pr.merge_dependencies || [])}) go in merge_notes — merging itself happens later, serialized.

summary_comment: ${MAINTAINER_SHORT}'s voice, plain English, no emojis — thank the author, summarize what the review found and what was fixed on their branch (commits pushed), state the outcome.

Boundaries: read-only — no posting, approving, merging, or pushing. Output only the StructuredOutput JSON.`,
    { schema: FINAL_SCHEMA, label: `bdfl-final:#${pr.n}`, phase: 'Final' }
  )

  return {
    pr: pr.n,
    title: pr.title,
    author: pr.author,
    branch: pr.branch,
    converged: clean,
    stalled,
    rounds: rounds.map((r, i) => ({ round: i + 1, findings: r.findingsBrief, fixer: r.fixReport })),
    final,
  }
}

phase('Panel')
log(`Panel loop over ${PRS.length} PRs (unbounded rounds; stall/backstop guards on)`)
const results = await pipeline(PRS, (pr) => reviewPR(pr))
const out = results.filter(Boolean)
log(`Panel complete: ${out.length}/${PRS.length} PRs processed`)
return { results: out }
