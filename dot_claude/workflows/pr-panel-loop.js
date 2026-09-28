export const meta = {
  name: 'pr-panel-loop',
  description: 'Phase B: per-PR evaluate-optimize review loop — 4 parallel lenses, fixer applies blockers on the PR branch, re-review until clean (exits early on a 2-round fixer stall or when only maintainer-only findings remain; 12-round runaway backstop), then a BDFL final verdict. Escalates without a final verdict when worktree setup fails, when a fixer push does not land (push-failed), or when the PR head moves away from the reviewed head (head-mismatch); fork PRs escalate for manual handling. The project-specific inputs (repo, project, maintainer persona, audience, rules, rulings) are required args: the orchestrator reads them from the maintainer context note and passes them in.',
  whenToUse: 'After the pr-bdfl-gate phase: pass the ADVANCE PRs as args.prs (each with a guidanceFile holding its gate verdict and panel_guidance), plus args.scratch (a fresh, empty directory for each run: setup fails if a PR worktree path already exists), and args.repo, args.project, args.maintainer, args.maintainerShort, args.audience, args.rules, args.rulings from the maintainer context note. args.repo, args.scratch, and each guidanceFile must be absolute paths of letters, digits, and . _ / - only: paths with spaces (e.g. vault paths) are rejected.',
  phases: [
    { title: 'Panel', detail: 'engineer + tester + red-team + security lenses per PR, looped with a fixer' },
    { title: 'Final', detail: 'BDFL final verdict per PR' },
  ],
}

// args: { prs: [{ n, title, author, branch, guidanceFile, merge_dependencies }], scratch: '<abs path for worktrees>',
//   repo, project, maintainer, maintainerShort, audience, rules, rulings }
// No fixed round limit — loop until clean. Exit only on convergence, a stall
// (two consecutive rounds with zero fixer progress => escalate to the
// maintainer), a fix that was made but not pushed, a PR head that differs from
// the head under review, or the runaway backstop below.
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

// Head SHAs are agent-reported, so these checks catch drift and mistakes (a
// push landing mid-review, a fixer push that did not land), not a hostile agent.
// The input validation above is the security boundary.
const SHA_RE = /^[0-9a-fA-F]{40}$/
const isSha = (v) => typeof v === 'string' && SHA_RE.test(v)

const SETUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'error', 'head_ref', 'head_sha', 'pr_head_sha', 'cross_repository'],
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string', description: 'the failing command and its error text verbatim; empty when ok' },
    head_ref: { type: 'string', description: 'headRefName from gh pr view' },
    head_sha: { type: 'string', description: 'git rev-parse HEAD inside the new worktree' },
    pr_head_sha: { type: 'string', description: 'headRefOid from gh pr view' },
    cross_repository: { type: 'boolean', description: 'isCrossRepository from gh pr view' },
  },
}

const HEAD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pr_head_sha'],
  properties: { pr_head_sha: { type: 'string', description: 'headRefOid from gh pr view' } },
}

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
  required: ['applied', 'skipped', 'pushed', 'commits', 'local_head', 'remote_head', 'notes'],
  properties: {
    applied: { type: 'array', items: { type: 'string' } },
    skipped: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['finding', 'why'], properties: { finding: { type: 'string' }, why: { type: 'string' } } } },
    pushed: { type: 'boolean' },
    commits: { type: 'array', items: { type: 'string' } },
    local_head: { type: 'string', description: 'git rev-parse HEAD in the worktree after your last step; empty if the worktree is missing' },
    remote_head: { type: 'string', description: 'the SHA from git ls-remote origin for the PR branch after your last step' },
    notes: { type: 'string' },
  },
}

const FINAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pr', 'head_sha', 'final', 'summary_comment', 'merge_notes', 'residual_risks'],
  properties: {
    pr: { type: 'number' },
    head_sha: { type: 'string', description: 'headRefOid from gh pr view at the time of your verdict' },
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

A working checkout of the PR head exists at ${SCRATCH}/pr-${pr.n} (git worktree on a detached HEAD at the last reviewed head of origin/${pr.branch} — verify with git status). If the worktree is missing, do not create it: change nothing, return pushed false with local_head "" and remote_head "", and say so in notes.

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
- Push to the CONTRIBUTOR'S PR branch: git push origin HEAD:refs/heads/${pr.branch}. Never force-push, never rewrite their commits, never push to main.
- If the branch is behind or CONFLICTING with origin/main (gh pr view ${pr.n} --json mergeable,mergeStateStatus), integrate main FIRST with a forward merge: git fetch origin main && git merge origin/main — resolve conflicts preserving both sides' intent (sibling PRs that appended evals/negatives: keep both), re-cut the skill version ABOVE the version now on main, and put the CHANGELOG entry under that new heading. Never rebase or force-push a contributor branch.
- ${RULINGS}
- The version/CHANGELOG gate is live: every shipped-file change bumps frontmatter version with a matching '## [x.y.z] - <date>' CHANGELOG heading. Backticked file citations in SKILL.md/references must resolve to real files in the repo; bare skill names must be live skills.
- Do not post PR comments; do not merge; do not touch other PRs' branches or worktrees.

Before you return, record both heads, pushed or not: local_head = git -C ${SCRATCH}/pr-${pr.n} rev-parse HEAD; remote_head = the SHA from git -C ${SCRATCH}/pr-${pr.n} ls-remote origin refs/heads/${pr.branch}.

Return the StructuredOutput JSON: what you applied, what you skipped and why, whether you pushed, commit SHAs, local_head, remote_head, and anything the next review round must verify.`
}

function summarizeFindings(reviews) {
  return reviews
    .filter(Boolean)
    .flatMap((r) => r.findings.map((f) => `[${r.lens}/${f.severity}] ${f.area}: ${f.issue} | evidence: ${f.evidence} | fix: ${f.suggested_fix}`))
    .join('\n')
}

// An ESCALATE verdict in FINAL_SCHEMA's shape, built here instead of by the
// final agent: on these exits the PR branch is not the code the panel
// reviewed, so an agent verdict would judge the wrong head.
// head is the last verified head, or '' when setup never verified one.
function escalation(pr, reason, risks, head) {
  return {
    pr: pr.n,
    head_sha: head || '',
    final: 'ESCALATE',
    summary_comment: `Thanks for this PR. The review loop stopped before a final verdict: ${reason}. ${MAINTAINER_SHORT} will review it by hand.`,
    merge_notes: `Do not merge: ${reason}. Re-run the panel on the current branch head first.`,
    residual_risks: risks,
  }
}

// Why setup's report cannot start a review, or null when it can.
function setupProblem(pr, s) {
  if (!s || s.ok !== true) return 'worktree setup failed'
  if (s.cross_repository !== false) return 'the PR comes from a fork (cross-repository), which this loop does not review or push to'
  if (!isSha(s.head_sha) || s.head_sha !== s.pr_head_sha) return 'the checked-out head does not match the PR head on GitHub'
  if (s.head_ref !== pr.branch) return `the PR head branch on GitHub is not ${pr.branch}`
  return null
}

async function reviewPR(pr) {
  // one-time worktree setup for this PR (fixer/tester share it; panel reads it).
  // Detached, so no local branch collides on a rerun; an existing path fails.
  const setup = await agent(
    `Set up a git worktree for ${PROJECT} PR #${pr.n}. Run exactly: cd ${REPO} && test ! -e ${SCRATCH}/pr-${pr.n} && git fetch origin ${pr.branch} && git worktree add --detach ${SCRATCH}/pr-${pr.n} origin/${pr.branch} && test -d ${SCRATCH}/pr-${pr.n}/skills && git -C ${SCRATCH}/pr-${pr.n} rev-parse HEAD && gh pr view ${pr.n} --json headRefName,headRefOid,isCrossRepository. If any command fails, STOP and return ok false with the failing command and its error text verbatim in error. Never remove or reuse an existing path. Otherwise return ok true, error "", head_sha = the rev-parse output, head_ref = headRefName, pr_head_sha = headRefOid, cross_repository = isCrossRepository. Do nothing else.`,
    { schema: SETUP_SCHEMA, label: `worktree:#${pr.n}`, phase: 'Panel', effort: 'low' }
  )

  const rounds = []
  let clean = false
  let stalledStreak = 0
  let stalled = false
  let status = 'backstop'
  let escalated = null
  let stopDetail = ''
  // expectedHead: the head the PR branch must be at now. reviewedHead: the head
  // the last lens round reviewed; the final verdict must see the same one.
  let expectedHead = null
  let reviewedHead = null
  const stop = (s, detail, reason, risks) => {
    status = s
    stopDetail = detail
    escalated = escalation(pr, reason, risks, expectedHead)
    log(`#${pr.n}: ${detail} — escalating`)
  }
  const setupWhy = setupProblem(pr, setup)
  if (setupWhy) {
    stop('setup-failed', `SETUP FAILED — ${setupWhy}`, setupWhy, [`Setup report: ${JSON.stringify(setup)}`])
  } else {
    expectedHead = setup.head_sha
  }
  for (let round = 1; round <= ROUND_BACKSTOP && !clean && !stalled && !escalated; round++) {
    const history = rounds
      .map((r, i) => `--- round ${i + 1} findings ---\n${r.findingsBrief}\n--- round ${i + 1} fixer report ---\n${r.fixReport}`)
      .join('\n')

    // Review only the expected head: if the PR moved (a push outside this loop),
    // the lenses would judge code nobody verified.
    const head = await agent(
      `Check the head of ${PROJECT} PR #${pr.n}. Run exactly: cd ${REPO} && gh pr view ${pr.n} --json headRefOid. Return pr_head_sha = headRefOid (or "" if the command fails). Do nothing else.`,
      { schema: HEAD_SCHEMA, label: `head:#${pr.n}:r${round}`, phase: 'Panel', effort: 'low' }
    )
    if (!head || head.pr_head_sha !== expectedHead) {
      stop(
        'head-mismatch',
        `HEAD MISMATCH — before round ${round}, the PR head is not the expected head`,
        `the PR head changed before round ${round} (expected ${expectedHead})`,
        [`Head check report: ${JSON.stringify(head)}`]
      )
      break
    }
    reviewedHead = expectedHead

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
    // Name lenses by charter key: a failed lens agent returns null, so it has no
    // self-reported name.
    const lenses = Object.keys(CHARTERS)
    const missing = lenses.filter((_, i) => !reviews[i])
    const failing = lenses.filter((_, i) => reviews[i] && reviews[i].verdict !== 'PASS')

    // Clean needs all four lenses, all PASS, and no blocker/major finding: a
    // PASS that lists a major is not clean, and neither is a round of failed agents.
    if (missing.length === 0 && failing.length === 0 && blockersOrMajors.length === 0) {
      rounds.push({ findingsBrief: summarizeFindings(ok) || '(no findings)', fixReport: '(no fixes needed)', reviews: ok })
      clean = true
      status = 'converged'
      break
    }

    const findingsBrief = summarizeFindings(ok)
    // Not clean, but nothing the fixer can act on (a lens is missing, or failed
    // on minors only): skip the fixer and count the round toward the stall.
    if (blockersOrMajors.length === 0) {
      const lensNote = [
        missing.length > 0 && `missing lens(es): ${missing.join(', ')}`,
        failing.length > 0 && `FAIL with only minor findings: ${failing.join(', ')}`,
      ].filter(Boolean).join('; ')
      rounds.push({ findingsBrief: findingsBrief || '(no findings)', fixReport: `(fixer skipped, nothing fixable — ${lensNote})`, reviews: ok, lensNote })
      log(`#${pr.n} round ${round}: not clean, nothing fixable — ${lensNote}`)
      stalledStreak++
      if (stalledStreak >= 2) {
        stalled = true
        status = 'stalled'
        log(`#${pr.n}: no fixer progress for 2 consecutive rounds — escalating`)
      }
      continue
    }
    // 2026-09-11 lesson: when every remaining blocker/major is a maintainer-only
    // item (ruling, E2E evidence, owner ack), more fixer rounds cannot converge —
    // stop and hand it to the final verdict instead of burning the backstop.
    const maintainerOnly = /\b(ESCALATE|maintainer[- ]only|not fixer[- ]addressable|R[1-9]\b|E2E_EVIDENCE|owner (ack|review))/i
    if (round >= 2 && blockersOrMajors.length > 0 && blockersOrMajors.every((f) => maintainerOnly.test(`${f.issue} ${f.suggested_fix}`))) {
      rounds.push({ findingsBrief, fixReport: '(all remaining blocker/major findings are maintainer-only — stopped early)', reviews: ok })
      stalled = true
      status = 'maintainer-only'
      log(`#${pr.n} round ${round}: only maintainer-only findings remain — escalating early`)
      break
    }
    const fix = await agent(fixerPrompt(pr, round, findingsBrief), {
      schema: FIX_SCHEMA,
      label: `fixer:#${pr.n}:r${round}`,
      phase: 'Panel',
    })
    // The report feeds later prompts; leave out the heads so no agent can echo a
    // SHA back into a field JS compares. JS checks the real values below.
    rounds.push({ findingsBrief, fixReport: fix ? JSON.stringify({ ...fix, local_head: undefined, remote_head: undefined }) : '(fixer failed)', reviews: ok })
    log(`#${pr.n} round ${round}: ${blockersOrMajors.length} blocker/major findings, fixer pushed=${fix ? fix.pushed : 'n/a'}`)

    // Applied but not pushed: the PR branch lacks the fixes, so another round
    // would review code that is not on GitHub. Stop and escalate.
    if (fix && (fix.applied.length > 0 || fix.commits.length > 0) && !fix.pushed) {
      stop(
        'push-failed',
        `PUSH FAILED — round ${round} fixer made changes but did not push them`,
        `the round ${round} fixer made changes (${fix.applied.length} applied, ${fix.commits.length} commit(s)) but did not push them, so the PR branch does not have them`,
        [`Unpushed fixer changes are in ${SCRATCH}/pr-${pr.n} only.`, `Fixer notes: ${fix.notes}`]
      )
      break
    }
    // A push counts only when the branch on GitHub is at the fixer's local head;
    // that head is what the next round must review.
    if (fix && fix.pushed) {
      if (!isSha(fix.local_head) || fix.local_head !== fix.remote_head) {
        stop(
          'push-failed',
          `PUSH FAILED — round ${round} fixer reported a push, but the PR branch is not at its local head`,
          `the round ${round} fixer reported a push, but the PR branch head on GitHub does not match the fixer's local head`,
          [`Fixer heads: local ${JSON.stringify(fix.local_head)}, remote ${JSON.stringify(fix.remote_head)}.`, `Fixer notes: ${fix.notes}`]
        )
        break
      }
      expectedHead = fix.local_head
    } else if (fix && !isSha(fix.local_head)) {
      stop(
        'setup-failed',
        `SETUP FAILED — round ${round} fixer could not read the worktree head`,
        `the round ${round} fixer could not read the worktree head at ${SCRATCH}/pr-${pr.n} (missing worktree?)`,
        [`Fixer notes: ${fix.notes}`]
      )
      break
    } else if (fix && fix.local_head !== expectedHead) {
      stop(
        'push-failed',
        `PUSH FAILED — round ${round} fixer worktree head differs from the verified PR head without a push`,
        `the round ${round} fixer worktree holds changes that are not on the PR branch`,
        [`local ${JSON.stringify(fix.local_head)}`, `expected ${JSON.stringify(expectedHead)}`, `Fixer notes: ${fix.notes}`]
      )
      break
    }

    // Stall detection: a round where the fixer made no change cannot converge
    // by repetition — after two in a row, hand the PR to the maintainer instead.
    const progressed = !!fix && (fix.applied.length > 0 || fix.pushed)
    stalledStreak = progressed ? 0 : stalledStreak + 1
    if (stalledStreak >= 2) {
      stalled = true
      status = 'stalled'
      log(`#${pr.n}: no fixer progress for 2 consecutive rounds — escalating`)
    }
  }

  // A fixer push after the last lens round leaves a head no lens reviewed; JS
  // knows this, so do not ask the final agent to notice it.
  if (!escalated && expectedHead !== reviewedHead) {
    stop(
      'head-mismatch',
      `HEAD MISMATCH — the PR head moved to ${expectedHead} after the last panel round reviewed ${reviewedHead}`,
      `the PR head moved after the last panel round reviewed ${reviewedHead}; no lens reviewed ${expectedHead}`,
      []
    )
  }

  const historyBrief = rounds
    .map((r, i) => `=== round ${i + 1} ===\nFINDINGS:\n${r.findingsBrief}\nFIXER: ${r.fixReport}`)
    .join('\n')

  // Name the lenses that kept the last two rounds from converging.
  const lensNotes = rounds.map((r, i) => r.lensNote && `round ${i + 1} ${r.lensNote}`).slice(-2).filter(Boolean)
  let statusDetail = clean
    ? 'converged clean'
    : escalated
      ? stopDetail
      : status === 'maintainer-only'
        ? `STOPPED EARLY — round ${rounds.length}: only maintainer-only blocker/major findings remain`
        : stalled
          ? `STALLED — ${rounds.length} rounds, no fixer progress in the last 2${lensNotes.length > 0 ? ` (${lensNotes.join('; ')})` : ''}`
          : `hit the ${ROUND_BACKSTOP}-round runaway backstop without converging`

  let final = escalated || await agent(
    `You are ${MAINTAINER} — ${PROJECT}'s BDFL — giving the FINAL verdict on PR #${pr.n} ("${pr.title}" by ${pr.author}, branch ${pr.branch}) after ${rounds.length} panel round(s). Review loop status: ${statusDetail}.

HEAD CHECK FIRST: run cd ${REPO} && gh pr view ${pr.n} --json headRefOid and return headRefOid verbatim as head_sha.

REPO: ${REPO}. Verify the CURRENT branch state yourself (gh pr diff ${pr.n}, gh pr checks ${pr.n}, worktree at ${SCRATCH}/pr-${pr.n}): do not take the panel's word for anything you can check in two minutes. Non-negotiables before APPROVE: CI checks green or only informational-recall failures; zero unresolved blocker findings; confidentiality clean; conventions met.

REVIEW HISTORY:
${historyBrief}

BDFL GATE CONTEXT: Read ${pr.guidanceFile} (gate verdict + required changes + adjudication notes) and confirm every gate-required change and adjudication instruction was actually satisfied.

Verdict APPROVE only if you would put your name on this shipping to ${AUDIENCE} in 30 minutes. Otherwise ESCALATE with exactly what remains (${MAINTAINER_SHORT} reviews escalations by hand). Merge sequencing concerns (sibling PRs touching the same files, dependencies: ${JSON.stringify(pr.merge_dependencies || [])}) go in merge_notes — merging itself happens later, serialized.

summary_comment: ${MAINTAINER_SHORT}'s voice, plain English, no emojis — thank the author, summarize what the review found and what was fixed on their branch (commits pushed), state the outcome.

Boundaries: read-only — no posting, approving, merging, or pushing. Output only the StructuredOutput JSON.`,
    { schema: FINAL_SCHEMA, label: `bdfl-final:#${pr.n}`, phase: 'Final' }
  )
  // An APPROVE counts only for the head the panel reviewed.
  if (!escalated && final && final.final === 'APPROVE' && final.head_sha !== reviewedHead) {
    status = 'head-mismatch'
    statusDetail = `HEAD MISMATCH — the final verdict saw a head other than the last reviewed head ${reviewedHead}`
    final = escalation(
      pr,
      `the PR head moved after the last panel round reviewed ${reviewedHead}`,
      [`Final verdict head: ${JSON.stringify(final.head_sha)}.`, ...(Array.isArray(final.residual_risks) ? final.residual_risks : [])],
      reviewedHead
    )
    log(`#${pr.n}: ${statusDetail} — APPROVE downgraded to ESCALATE`)
  }

  return {
    pr: pr.n,
    title: pr.title,
    author: pr.author,
    branch: pr.branch,
    status,
    statusDetail,
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
