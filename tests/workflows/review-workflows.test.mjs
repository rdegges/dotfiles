// Input validation for the PR review workflows (pr-panel-loop, pr-bdfl-gate).
//
// Run from the repo root:
//   docker run --rm -v "$PWD":/w -w /w node:latest node --test tests/workflows/review-workflows.test.mjs
//
// What a pass proves: under a stub runtime, these branches behave as stated;
// says nothing about real agents, git, or gh.
//
// Each script is read as text and evaluated the way the workflow runtime runs
// it: top-level await and return, so it is built as an AsyncFunction body with
// agent/parallel/pipeline/phase/log/args as parameters. One case table runs
// against both scripts, so the two duplicated validation blocks cannot drift.
// All args are canary values.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

function load(file) {
  const text = readFileSync(new URL(`../../dot_claude/workflows/${file}`, import.meta.url), 'utf8')
  const src = text.replace(/^export const meta =/m, 'const meta =')
  return new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', src)
}

// Stub runtime: records every call; agent() returns null (a failed agent), so
// a valid run goes through the whole script without doing anything real.
async function run(fn, args) {
  const calls = []
  const agent = async (prompt, opts) => {
    calls.push({ fn: 'agent', prompt, opts })
    return null
  }
  const parallel = async (thunks) => {
    calls.push({ fn: 'parallel' })
    return Promise.all(thunks.map((t) => t()))
  }
  const pipeline = async (items, f) => {
    calls.push({ fn: 'pipeline' })
    return Promise.all(items.map((x) => f(x)))
  }
  const phase = (title) => calls.push({ fn: 'phase', title })
  const log = (msg) => calls.push({ fn: 'log', msg })
  try {
    return { calls, result: await fn(agent, parallel, pipeline, phase, log, args) }
  } catch (error) {
    return { calls, error }
  }
}

const COMMON = {
  repo: '/canary/repo',
  project: 'canary-project',
  maintainer: 'Canary Maintainer',
  maintainerShort: 'Canary',
  audience: 'canary users',
}

const SCRIPTS = [
  {
    name: 'pr-panel-loop',
    file: 'pr-panel-loop.js',
    uses: new Set(['n', 'title', 'author', 'branch', 'guidanceFile', 'merge_dependencies', 'repo', 'scratch']),
    validArgs: () => ({
      ...COMMON,
      rules: 'CANARY RULES',
      rulings: 'canary rulings',
      scratch: '/canary/scratch',
      prs: [
        { n: 101, title: 'canary title', author: 'canary-author', branch: 'canary/branch-1', guidanceFile: '/canary/guidance-101.md', merge_dependencies: [100] },
        { n: 102, title: 'canary title two', author: 'canary-author-2', branch: 'canary-branch-2', guidanceFile: '/canary/guidance-102.md', merge_dependencies: [] },
      ],
    }),
  },
  {
    name: 'pr-bdfl-gate',
    file: 'pr-bdfl-gate.js',
    uses: new Set(['n', 'title', 'author', 'note', 'repo', 'today']),
    validArgs: () => ({
      ...COMMON,
      context: 'canary context dated {{today}}',
      today: '2000-01-01',
      prs: [
        { n: 101, author: 'canary-author', title: 'canary title', note: 'canary cluster note' },
        { n: 102, author: 'canary-author-2', title: 'canary title two', note: 'canary cluster note two' },
      ],
    }),
  },
]

const setPr = (key, value) => (a) => {
  a.prs[0][key] = value
}
const delPr = (key) => (a) => {
  delete a.prs[0][key]
}
const setArg = (key, value) => (a) => {
  a[key] = value
}
const delArg = (key) => (a) => {
  delete a[key]
}

// field: which input the case exercises; a case runs against every script
// that uses that field. error: the message must name the field (and PR index).
const P0 = (k) => new RegExp(`args\\.prs\\[0\\]\\.${k}\\b`)
const REJECT = [
  // branch: shell metacharacters and git-ref traps
  { field: 'branch', name: 'branch x;id', mutate: setPr('branch', 'x;id'), error: P0('branch') },
  { field: 'branch', name: 'branch $(id)', mutate: setPr('branch', '$(id)'), error: P0('branch') },
  { field: 'branch', name: 'branch with a backtick', mutate: setPr('branch', 'a`id`'), error: P0('branch') },
  { field: 'branch', name: 'branch with a space', mutate: setPr('branch', 'a b'), error: P0('branch') },
  { field: 'branch', name: 'branch with a newline', mutate: setPr('branch', 'a\nb'), error: P0('branch') },
  { field: 'branch', name: 'branch with a leading -', mutate: setPr('branch', '-x'), error: P0('branch') },
  { field: 'branch', name: 'branch with ..', mutate: setPr('branch', 'a..b'), error: P0('branch') },
  { field: 'branch', name: 'branch with //', mutate: setPr('branch', 'a//b'), error: P0('branch') },
  { field: 'branch', name: 'branch with a trailing /', mutate: setPr('branch', 'a/'), error: P0('branch') },
  { field: 'branch', name: 'branch with a trailing .lock', mutate: setPr('branch', 'a.lock'), error: P0('branch') },
  { field: 'branch', name: 'branch HEAD', mutate: setPr('branch', 'HEAD'), error: P0('branch') },
  { field: 'branch', name: 'branch with a component starting with .', mutate: setPr('branch', 'topic/.hidden'), error: P0('branch') },
  { field: 'branch', name: 'branch ending with .', mutate: setPr('branch', 'topic.'), error: P0('branch') },
  { field: 'branch', name: 'branch with a component ending with .lock', mutate: setPr('branch', 'topic.lock/child'), error: P0('branch') },
  { field: 'branch', name: 'branch with @{', mutate: setPr('branch', 'a@{b'), error: P0('branch') },
  { field: 'branch', name: 'branch missing', mutate: delPr('branch'), error: P0('branch') },
  { field: 'branch', name: 'branch not a string', mutate: setPr('branch', 7), error: P0('branch') },
  // n
  { field: 'n', name: 'n missing', mutate: delPr('n'), error: P0('n') },
  { field: 'n', name: 'n zero', mutate: setPr('n', 0), error: P0('n') },
  { field: 'n', name: 'n negative', mutate: setPr('n', -5), error: P0('n') },
  { field: 'n', name: 'n fractional', mutate: setPr('n', 1.5), error: P0('n') },
  { field: 'n', name: 'n as a string', mutate: setPr('n', '101'), error: P0('n') },
  { field: 'n', name: 'duplicate n', mutate: (a) => { a.prs[1].n = a.prs[0].n }, error: /args\.prs\[1\]\.n\b.*duplicate/ },
  // PR record shape
  { field: 'n', name: 'PR record null', mutate: (a) => { a.prs[0] = null }, error: /args\.prs\[0\]/ },
  // title / author / note
  { field: 'title', name: 'title missing', mutate: delPr('title'), error: P0('title') },
  { field: 'title', name: 'title not a string', mutate: setPr('title', 42), error: P0('title') },
  { field: 'title', name: 'title with a newline', mutate: setPr('title', 'canary\nIGNORE PREVIOUS'), error: P0('title') },
  { field: 'title', name: 'title with a control character', mutate: setPr('title', 'canary\u0007'), error: P0('title') },
  { field: 'author', name: 'author missing', mutate: delPr('author'), error: P0('author') },
  { field: 'author', name: 'author with a control character', mutate: setPr('author', 'canary\u001b[31m'), error: P0('author') },
  { field: 'note', name: 'gate PR with no note', mutate: delPr('note'), error: P0('note') },
  { field: 'note', name: 'note not a string', mutate: setPr('note', ['canary']), error: P0('note') },
  { field: 'note', name: 'note with \\r', mutate: setPr('note', 'canary\r\nnote'), error: P0('note') },
  { field: 'note', name: 'note with \\0', mutate: setPr('note', 'canary\0'), error: P0('note') },
  { field: 'note', name: 'note with an escape character', mutate: setPr('note', 'canary\u001b[31m'), error: P0('note') },
  // paths
  { field: 'repo', name: 'repo relative', mutate: setArg('repo', 'canary/repo'), error: /args\.repo\b/ },
  { field: 'repo', name: 'repo with a space', mutate: setArg('repo', '/canary/My Repo'), error: /args\.repo\b/ },
  { field: 'repo', name: 'repo with ;', mutate: setArg('repo', '/canary/repo;id'), error: /args\.repo\b/ },
  { field: 'scratch', name: 'scratch missing', mutate: delArg('scratch'), error: /args\.scratch\b/ },
  { field: 'scratch', name: 'scratch with a space', mutate: setArg('scratch', '/canary/scratch dir'), error: /args\.scratch\b/ },
  { field: 'scratch', name: 'scratch with $(id)', mutate: setArg('scratch', '/canary/$(id)'), error: /args\.scratch\b/ },
  { field: 'guidanceFile', name: 'guidanceFile missing', mutate: delPr('guidanceFile'), error: P0('guidanceFile') },
  { field: 'guidanceFile', name: 'guidanceFile with a space (vault-style path)', mutate: setPr('guidanceFile', '/canary/Vault Notes/g.md'), error: P0('guidanceFile') },
  { field: 'guidanceFile', name: 'guidanceFile relative', mutate: setPr('guidanceFile', 'guidance.md'), error: P0('guidanceFile') },
  // merge_dependencies
  { field: 'merge_dependencies', name: 'merge_dependencies not an array', mutate: setPr('merge_dependencies', '100'), error: P0('merge_dependencies') },
  { field: 'merge_dependencies', name: 'merge_dependencies with a string', mutate: setPr('merge_dependencies', ['100']), error: P0('merge_dependencies') },
  { field: 'merge_dependencies', name: 'merge_dependencies with a fraction', mutate: setPr('merge_dependencies', [1.5]), error: P0('merge_dependencies') },
  // today
  { field: 'today', name: 'today missing', mutate: delArg('today'), error: /args\.today\b/ },
  { field: 'today', name: 'today not zero-padded', mutate: setArg('today', '2000-1-1'), error: /args\.today\b/ },
  { field: 'today', name: 'today with a time', mutate: setArg('today', '2000-01-01T00:00'), error: /args\.today\b/ },
  { field: 'today', name: 'today not a string', mutate: setArg('today', 20000101), error: /args\.today\b/ },
]

// Valid inputs: the script must run to completion under the stub, and the
// first agent prompt must carry the value (proving it got past validation).
const ACCEPT = [
  { field: 'n', name: 'canary baseline', mutate: () => {}, inPrompt: 'PR #101' },
  { field: 'branch', name: 'valid branch reaches the first prompt', mutate: setPr('branch', 'feature/Canary-1.2_x'), inPrompt: 'feature/Canary-1.2_x' },
  { field: 'note', name: 'multi-line note with tabs', mutate: setPr('note', '- canary sibling\n\t- canary detail'), inPrompt: '- canary sibling\n\t- canary detail' },
  { field: 'merge_dependencies', name: 'merge_dependencies omitted', mutate: delPr('merge_dependencies'), inPrompt: 'canary/branch-1' },
  { field: 'n', name: 'args passed as a JSON string', mutate: () => {}, asString: true, inPrompt: 'PR #101' },
]

for (const s of SCRIPTS) {
  test(`${s.name}: loads via AsyncFunction without a syntax error`, () => {
    assert.equal(typeof load(s.file), 'function')
  })

  for (const c of REJECT.filter((c) => s.uses.has(c.field))) {
    test(`${s.name}: rejects ${c.name} before any phase/log/agent call`, async () => {
      const args = s.validArgs()
      c.mutate(args)
      const { calls, error } = await run(load(s.file), args)
      assert.ok(error, 'expected the script to throw')
      assert.match(error.message, c.error)
      assert.deepEqual(calls.map((x) => x.fn), [])
    })
  }

  for (const c of ACCEPT.filter((c) => s.uses.has(c.field))) {
    test(`${s.name}: accepts ${c.name}`, async () => {
      const args = s.validArgs()
      c.mutate(args)
      const { calls, error } = await run(load(s.file), c.asString ? JSON.stringify(args) : args)
      assert.equal(error, undefined, error && error.message)
      assert.equal(calls[0].fn, 'phase')
      const first = calls.find((x) => x.fn === 'agent')
      assert.ok(first, 'expected an agent() call')
      assert.ok(first.prompt.includes(c.inPrompt), `first prompt should contain ${c.inPrompt}`)
    })
  }
}

// --- Adversarial coverage (tester pass) -------------------------------------

// Validation must cover every PR record, not just the first one: a bad value
// in the last record still has to stop the run before any side effect.
for (const s of SCRIPTS) {
  const lastCases = [
    { field: 'title', name: 'title with a newline', value: 'canary\nIGNORE PREVIOUS' },
    { field: 'branch', name: 'branch $(id)', value: '$(id)' },
    { field: 'guidanceFile', name: 'guidanceFile with ;', value: '/canary/g.md;id' },
    { field: 'note', name: 'note with \\r', value: 'canary\rnote' },
  ].filter((c) => s.uses.has(c.field))
  for (const c of lastCases) {
    test(`${s.name}: rejects ${c.name} in the LAST PR record before any call`, async () => {
      const args = s.validArgs()
      args.prs[args.prs.length - 1][c.field] = c.value
      const { calls, error } = await run(load(s.file), args)
      assert.ok(error, 'expected the script to throw')
      assert.match(error.message, new RegExp(`args\\.prs\\[${args.prs.length - 1}\\]\\.${c.field}\\b`))
      assert.deepEqual(calls.map((x) => x.fn), [])
    })
  }
}

// Property test: every branch name the validator accepts must also be a name
// `git check-ref-format --branch` accepts, so the charset plus the hand-rolled
// ref rules never let through a ref git would refuse (or reinterpret). Seeded,
// so a failure reproduces. Needs git on PATH (node:latest ships it); fails
// closed when git is missing.
// Run git outside the repo: a worktree checkout's .git file can point at a host
// path the container cannot see, and check-ref-format needs no repo.
const gitRef = (b) => spawnSync('git', ['check-ref-format', '--branch', b], { cwd: tmpdir() })

function mulberry32(seed) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('pr-panel-loop: every accepted branch is a valid git branch (seeded fuzz vs git check-ref-format)', async () => {
  assert.equal(gitRef('canary').status, 0, 'git check-ref-format must work here (fail closed)')
  assert.notEqual(gitRef('a..b').status, 0, 'git check-ref-format must reject a..b (fail closed)')
  const rand = mulberry32(25)
  const tokens = ['a', 'b', 'Z', 'Q', '9', '0', 'ab', 'x1', 'a', 'Z', '9', '.', '_', '/', '-', '.lock', 'HEAD', '..', '@', '{']
  const seen = new Set()
  let accepted = 0
  let rejected = 0
  const mismatches = []
  const fn = load('pr-panel-loop.js')
  for (let i = 0; i < 5000; i++) {
    const len = 1 + Math.floor(rand() * 8)
    let b = ''
    for (let j = 0; j < len; j++) b += tokens[Math.floor(rand() * tokens.length)]
    if (seen.has(b)) continue
    seen.add(b)
    const args = SCRIPTS[0].validArgs()
    args.prs[0].branch = b
    const { error } = await run(fn, args)
    if (error) {
      rejected++
      continue
    }
    accepted++
    if (gitRef(b).status !== 0) mismatches.push(b)
  }
  // Guard against a vacuous pass: the generator must hit both sides.
  assert.ok(accepted >= 100, `only ${accepted} accepted names; generator too narrow`)
  assert.ok(rejected >= 100, `only ${rejected} rejected names; generator too narrow`)
  assert.deepEqual(mismatches, [], 'validator accepted names git refuses')
})

// Drive the panel loop through lens -> fixer -> stall -> final so every prompt
// template renders, then check that no field reached a prompt as undefined /
// [object Object] / NaN and that the shell lines carry the exact values.
function scriptedAgent(calls) {
  return async (prompt, opts) => {
    calls.push({ fn: 'agent', prompt, opts })
    const label = opts && opts.label ? opts.label : ''
    if (label.startsWith('fixer:')) return { applied: [], skipped: [], pushed: false, commits: [], notes: 'canary' }
    if (/^(engineer|tester|redteam|security):/.test(label)) {
      return { lens: label.split(':')[0], verdict: 'FAIL', findings: [{ severity: 'blocker', area: 'canary', issue: 'canary issue', evidence: 'canary', suggested_fix: 'canary fix' }], evidence_of_checks: 'canary' }
    }
    return null
  }
}

async function runScripted(fn, args) {
  const calls = []
  const agent = scriptedAgent(calls)
  const parallel = async (thunks) => Promise.all(thunks.map((t) => t()))
  const pipeline = async (items, f) => Promise.all(items.map((x) => f(x)))
  const phase = () => {}
  const log = () => {}
  const result = await fn(agent, parallel, pipeline, phase, log, args)
  return { calls, result }
}

const BAD_RENDER = /undefined|\[object Object\]|NaN/

test('pr-panel-loop: every rendered prompt is free of undefined/[object Object]/NaN across lens, fixer, and final', async () => {
  const args = SCRIPTS[0].validArgs()
  delete args.prs[1].merge_dependencies
  const { calls } = await runScripted(load('pr-panel-loop.js'), args)
  const labels = calls.map((c) => c.opts.label)
  // Non-vacuous: all three prompt templates rendered for both PRs.
  for (const n of [101, 102]) {
    assert.ok(labels.includes(`worktree:#${n}`), `worktree:#${n} missing`)
    assert.ok(labels.includes(`fixer:#${n}:r1`), `fixer:#${n}:r1 missing`)
    assert.ok(labels.includes(`bdfl-final:#${n}`), `bdfl-final:#${n} missing`)
  }
  for (const c of calls) assert.doesNotMatch(c.prompt, BAD_RENDER, `bad render in ${c.opts.label}`)
})

test('pr-panel-loop: shell lines carry the exact validated values', async () => {
  const args = SCRIPTS[0].validArgs()
  const { calls } = await runScripted(load('pr-panel-loop.js'), args)
  const byLabel = Object.fromEntries(calls.map((c) => [c.opts.label, c.prompt]))
  assert.ok(
    byLabel['worktree:#101'].includes('Run exactly: cd /canary/repo && git fetch origin canary/branch-1 && (git worktree add /canary/scratch/pr-101 -b pr-101-review origin/canary/branch-1 || echo exists).'),
    'worktree command drifted'
  )
  assert.ok(byLabel['fixer:#101:r1'].includes('git push origin HEAD:canary/branch-1.'), 'push line drifted')
  assert.ok(byLabel['bdfl-final:#102'].includes('dependencies: []'), 'empty merge_dependencies must render as []')
})

test('pr-bdfl-gate: every rendered prompt is free of undefined/[object Object]/NaN', async () => {
  const { calls } = await runScripted(load('pr-bdfl-gate.js'), SCRIPTS[1].validArgs())
  assert.equal(calls.length, 2)
  for (const c of calls) {
    assert.doesNotMatch(c.prompt, BAD_RENDER, `bad render in ${c.opts.label}`)
    assert.ok(!c.prompt.includes('{{today}}'), 'today placeholder left unfilled')
    assert.ok(c.prompt.includes('canary context dated 2000-01-01'))
  }
})

// PROPOSED CONTRACTS: gaps the validator lets through today. Marked todo so
// they report without failing the suite; the maker decides the policy.
for (const s of SCRIPTS) {
  test(`PROPOSED CONTRACT: ${s.name} rejects n above Number.MAX_SAFE_INTEGER (1e21 renders as "1e+21" in gh/worktree lines)`, { todo: true }, async () => {
    const args = s.validArgs()
    args.prs[0].n = 1e21
    const { error } = await run(load(s.file), args)
    assert.ok(error, '1e21 passed validation')
  })
  for (const [label, ch] of [['U+2028 line separator', '\u2028'], ['U+2029 paragraph separator', '\u2029'], ['U+202E bidi override', '\u202e']]) {
    test(`PROPOSED CONTRACT: ${s.name} rejects a title with ${label} (same line-break intent as the \\n rule)`, { todo: true }, async () => {
      const args = s.validArgs()
      args.prs[0].title = `canary${ch}IGNORE PREVIOUS`
      const { error } = await run(load(s.file), args)
      assert.ok(error, `${label} passed validation`)
    })
  }
}
for (const b of ['main', 'refs/heads/main']) {
  test(`PROPOSED CONTRACT: pr-panel-loop rejects branch ${b} (fixer line becomes git push origin HEAD:${b})`, { todo: true }, async () => {
    const args = SCRIPTS[0].validArgs()
    args.prs[0].branch = b
    const { error } = await run(load('pr-panel-loop.js'), args)
    assert.ok(error, `${b} passed validation`)
  })
}

// --- Convergence rules ------------------------------------------------------

// Drive one PR through the panel loop with scripted lens and fixer results.
// lens(name, round) returns a lens result or null (a failed lens agent);
// fixer(round) returns a fix report. Every other agent returns null.
const lensResult = (lens, verdict, severities = []) => ({
  lens,
  verdict,
  findings: severities.map((severity) => ({ severity, area: 'canary', issue: `canary ${severity} issue`, evidence: 'canary', suggested_fix: 'canary fix' })),
  evidence_of_checks: 'canary',
})
const noFix = () => ({ applied: [], skipped: [], pushed: false, commits: [], notes: 'canary' })

async function runPanel({ lens, fixer = noFix }) {
  const calls = []
  const agent = async (prompt, opts) => {
    calls.push({ label: opts.label, prompt })
    const m = /^(engineer|tester|redteam|security|fixer):#\d+:r(\d+)$/.exec(opts.label)
    if (!m) return null
    return m[1] === 'fixer' ? fixer(Number(m[2])) : lens(m[1], Number(m[2]))
  }
  const args = SCRIPTS[0].validArgs()
  args.prs = [args.prs[0]]
  const { results } = await load('pr-panel-loop.js')(agent, async (t) => Promise.all(t.map((f) => f())), async (xs, f) => Promise.all(xs.map(f)), () => {}, () => {}, args)
  const labels = calls.map((c) => c.label)
  return { calls, labels, out: results[0], finalPrompt: (calls.find((c) => c.label === 'bdfl-final:#101') || {}).prompt }
}

test('pr-panel-loop: a missing lens with no findings does not converge, skips the fixer, and is named', async () => {
  const { labels, out, finalPrompt } = await runPanel({ lens: (l) => (l === 'engineer' ? null : lensResult(l, 'PASS')) })
  assert.equal(out.converged, false)
  assert.equal(out.status, 'stalled')
  assert.ok(!labels.some((l) => l.startsWith('fixer:')), 'fixer must not run with nothing fixable')
  assert.equal(out.rounds.length, 2)
  assert.match(out.rounds[0].fixer, /missing lens\(es\): engineer/)
  assert.match(out.statusDetail, /engineer/)
  assert.match(finalPrompt, /STALLED.*missing lens\(es\): engineer/)
})

test('pr-panel-loop: a PASS that lists a major finding runs the fixer', async () => {
  const { labels, out } = await runPanel({
    lens: (l, r) => (r === 1 && l === 'tester' ? lensResult(l, 'PASS', ['major']) : lensResult(l, 'PASS')),
    fixer: () => ({ applied: ['canary fix'], skipped: [], pushed: true, commits: ['c0ffee'], notes: 'canary' }),
  })
  assert.ok(labels.includes('fixer:#101:r1'), 'fixer must run on a major finding')
  assert.equal(out.status, 'converged')
  assert.equal(out.rounds.length, 2)
})

test('pr-panel-loop: a FAIL with only minor findings does not converge and skips the fixer', async () => {
  const { labels, out } = await runPanel({ lens: (l) => (l === 'security' ? lensResult(l, 'FAIL', ['minor']) : lensResult(l, 'PASS')) })
  assert.equal(out.converged, false)
  assert.ok(!labels.some((l) => l.startsWith('fixer:')), 'fixer must not run on minors only')
  assert.match(out.rounds[0].fixer, /FAIL with only minor findings: security/)
})

test('pr-panel-loop: two minor-only FAIL rounds end as stalled, not the maintainer-only exit', async () => {
  const { labels, out, finalPrompt } = await runPanel({ lens: (l) => (l === 'security' ? lensResult(l, 'FAIL', ['minor']) : lensResult(l, 'PASS')) })
  assert.equal(out.status, 'stalled')
  assert.equal(out.stalled, true)
  assert.equal(out.rounds.length, 2)
  assert.ok(!labels.includes('engineer:#101:r3'), 'no third round after a 2-round stall')
  for (const r of out.rounds) assert.doesNotMatch(r.fixer, /maintainer-only/)
  assert.match(finalPrompt, /STALLED.*round 1 FAIL with only minor findings: security; round 2 FAIL with only minor findings: security/)
})

test('pr-panel-loop: applied-but-not-pushed stops as push-failed with a JS-built ESCALATE and no final agent', async () => {
  const { labels, out } = await runPanel({
    lens: (l) => lensResult(l, 'FAIL', ['blocker']),
    fixer: () => ({ applied: ['canary fix'], skipped: [], pushed: false, commits: [], notes: 'canary push rejected' }),
  })
  assert.equal(out.status, 'push-failed')
  assert.equal(out.rounds.length, 1)
  assert.ok(!labels.some((l) => l.endsWith(':r2')), 'no round after a push failure')
  assert.ok(!labels.includes('bdfl-final:#101'), 'no final-agent call after a push failure')
  // Same shape as FINAL_SCHEMA: required keys only, right types, honest content.
  assert.deepEqual(Object.keys(out.final).sort(), ['final', 'merge_notes', 'pr', 'residual_risks', 'summary_comment'])
  assert.equal(out.final.pr, 101)
  assert.equal(out.final.final, 'ESCALATE')
  assert.match(out.final.summary_comment, /did not push/)
  assert.match(out.final.merge_notes, /^Do not merge/)
  assert.ok(Array.isArray(out.final.residual_risks) && out.final.residual_risks.every((x) => typeof x === 'string'))
  assert.ok(out.final.residual_risks.some((x) => x.includes('/canary/scratch/pr-101')))
})

test('pr-panel-loop: an all-clean round 1 converges without the fixer', async () => {
  const { labels, out, finalPrompt } = await runPanel({ lens: (l) => lensResult(l, 'PASS') })
  assert.equal(out.status, 'converged')
  assert.equal(out.converged, true)
  assert.equal(out.rounds.length, 1)
  assert.ok(!labels.some((l) => l.startsWith('fixer:')))
  assert.match(finalPrompt, /Review loop status: converged clean\./)
})

// --- Convergence rules: adversarial round shapes (tester gate, PR #27) ------

const progressFix = () => ({ applied: ['canary fix'], skipped: [], pushed: true, commits: ['c0ffee'], notes: 'canary' })
const fixerLabels = (labels) => labels.filter((l) => l.startsWith('fixer:'))

test('pr-panel-loop: four failed lens agents never converge and name every lens', async () => {
  const { labels, out, finalPrompt } = await runPanel({ lens: () => null })
  assert.equal(out.converged, false)
  assert.equal(out.status, 'stalled')
  assert.equal(out.rounds.length, 2)
  assert.deepEqual(fixerLabels(labels), [])
  assert.match(out.rounds[0].fixer, /missing lens\(es\): engineer, tester, redteam, security/)
  assert.ok(labels.includes('bdfl-final:#101'), 'a stall still gets a final verdict')
  assert.match(finalPrompt, /STALLED/)
})

test('pr-panel-loop: a FAIL with zero findings does not converge', async () => {
  const { labels, out } = await runPanel({ lens: (l) => lensResult(l, l === 'redteam' ? 'FAIL' : 'PASS') })
  assert.equal(out.converged, false)
  assert.equal(out.status, 'stalled')
  assert.deepEqual(fixerLabels(labels), [])
  assert.match(out.rounds[0].fixer, /FAIL with only minor findings: redteam/)
})

test('pr-panel-loop: an unknown verdict string counts as not PASS', async () => {
  const { out } = await runPanel({ lens: (l) => lensResult(l, l === 'tester' ? 'pass' : 'PASS') })
  assert.equal(out.converged, false)
})

test('pr-panel-loop: an unknown severity counts as blocker/major, not minor', async () => {
  const { labels, out } = await runPanel({
    lens: (l, r) => lensResult(l, 'PASS', r === 1 && l === 'engineer' ? ['critical'] : []),
    fixer: progressFix,
  })
  assert.ok(labels.includes('fixer:#101:r1'))
  assert.equal(out.status, 'converged')
  assert.equal(out.rounds.length, 2)
})

test('pr-panel-loop: a missing lens plus a FAIL-on-minors names both in one round note', async () => {
  const { out } = await runPanel({
    lens: (l) => (l === 'tester' ? null : l === 'security' ? lensResult(l, 'FAIL', ['minor']) : lensResult(l, 'PASS')),
  })
  assert.match(out.rounds[0].fixer, /missing lens\(es\): tester; FAIL with only minor findings: security/)
})

test('pr-panel-loop: a missing lens alongside a major still runs the fixer, and cannot converge until the lens returns', async () => {
  const { labels, out } = await runPanel({
    lens: (l, r) => (l === 'tester' && r <= 2 ? null : lensResult(l, r === 1 && l === 'engineer' ? 'FAIL' : 'PASS', r === 1 && l === 'engineer' ? ['major'] : [])),
    fixer: progressFix,
  })
  assert.ok(labels.includes('fixer:#101:r1'))
  // round 2: majors fixed, but tester still missing -> not clean; round 3 all four PASS
  assert.match(out.rounds[1].fixer, /missing lens\(es\): tester/)
  assert.equal(out.status, 'converged')
  assert.equal(out.rounds.length, 3)
})

test('pr-panel-loop: minors under four PASS lenses converge and reach the final brief', async () => {
  const { out, finalPrompt } = await runPanel({ lens: (l) => lensResult(l, 'PASS', l === 'security' ? ['minor'] : []) })
  assert.equal(out.status, 'converged')
  assert.match(out.rounds[0].findings, /\[security\/minor\]/)
  assert.match(finalPrompt, /\[security\/minor\]/)
})

test('pr-panel-loop: a fixer that skips everything twice ends stalled and does call the final agent', async () => {
  const { labels, out, finalPrompt } = await runPanel({
    lens: (l) => lensResult(l, 'FAIL', ['blocker']),
    fixer: () => ({ applied: [], skipped: [{ finding: 'canary', why: 'canary' }], pushed: false, commits: [], notes: 'canary' }),
  })
  assert.equal(out.status, 'stalled')
  assert.equal(out.rounds.length, 2)
  assert.deepEqual(fixerLabels(labels), ['fixer:#101:r1', 'fixer:#101:r2'])
  assert.ok(labels.includes('bdfl-final:#101'))
  assert.match(finalPrompt, /STALLED/)
  assert.doesNotMatch(finalPrompt, /PUSH FAILED/)
})

test('pr-panel-loop: a failed fixer agent (null) twice ends stalled, not push-failed', async () => {
  const { labels, out } = await runPanel({ lens: (l) => lensResult(l, 'FAIL', ['blocker']), fixer: () => null })
  assert.equal(out.status, 'stalled')
  assert.equal(out.rounds[0].fixer, '(fixer failed)')
  assert.ok(labels.includes('bdfl-final:#101'))
})

test('pr-panel-loop: pushed with nothing applied is progress, not push-failed', async () => {
  const { out } = await runPanel({
    lens: (l, r) => lensResult(l, r === 1 ? 'FAIL' : 'PASS', r === 1 ? ['blocker'] : []),
    fixer: () => ({ applied: [], skipped: [], pushed: true, commits: ['merge'], notes: 'canary merged main' }),
  })
  assert.equal(out.status, 'converged')
  assert.equal(out.rounds.length, 2)
})

test('pr-panel-loop: push-failed in a later round stops there, after earlier pushed rounds', async () => {
  const { labels, out } = await runPanel({
    lens: (l) => lensResult(l, 'FAIL', ['blocker']),
    fixer: (r) => ({ applied: ['canary fix'], skipped: [], pushed: r < 3, commits: r < 3 ? ['c0ffee'] : [], notes: 'canary' }),
  })
  assert.equal(out.status, 'push-failed')
  assert.equal(out.rounds.length, 3)
  assert.ok(!labels.some((l) => l.endsWith(':r4')))
  assert.ok(!labels.includes('bdfl-final:#101'))
  assert.match(out.statusDetail, /round 3/)
  assert.match(out.final.summary_comment, /round 3 fixer/)
})

test('pr-panel-loop: a nothing-fixable round and a no-progress fixer round together stall in 2 rounds', async () => {
  const { labels, out } = await runPanel({
    lens: (l, r) => (r === 1 ? lensResult(l, 'FAIL', ['blocker']) : l === 'engineer' ? null : lensResult(l, 'PASS')),
  })
  assert.equal(out.status, 'stalled')
  assert.equal(out.rounds.length, 2)
  assert.deepEqual(fixerLabels(labels), ['fixer:#101:r1'])
})

test('pr-panel-loop: fixer progress between nothing-fixable rounds resets the stall streak', async () => {
  // r1 nothing fixable (streak 1), r2 major + fixer progress (reset), r3 nothing fixable (streak 1), r4 clean
  const { out } = await runPanel({
    lens: (l, r) =>
      r === 4 ? lensResult(l, 'PASS')
        : r === 2 ? lensResult(l, 'FAIL', l === 'engineer' ? ['major'] : [])
          : l === 'security' ? null : lensResult(l, 'PASS'),
    fixer: progressFix,
  })
  assert.equal(out.status, 'converged')
  assert.equal(out.rounds.length, 4)
})

test('pr-panel-loop: a fixer that reports progress every round runs to the 12-round backstop and no further', async () => {
  const { labels, out, finalPrompt } = await runPanel({ lens: (l) => lensResult(l, 'FAIL', ['blocker']), fixer: progressFix })
  assert.equal(out.status, 'backstop')
  assert.equal(out.converged, false)
  assert.equal(out.stalled, false)
  assert.equal(out.rounds.length, 12)
  assert.equal(fixerLabels(labels).length, 12)
  assert.ok(!labels.some((l) => l.endsWith(':r13')))
  assert.match(finalPrompt, /12-round runaway backstop/)
})

test('pr-panel-loop: maintainer-only findings in round 1 still get a fixer round; round 2 exits maintainer-only', async () => {
  const { labels, out } = await runPanel({
    lens: (l) => ({ ...lensResult(l, 'FAIL'), findings: l === 'engineer' ? [{ severity: 'blocker', area: 'canary', issue: 'needs maintainer-only ruling', evidence: 'canary', suggested_fix: 'ESCALATE' }] : [] }),
    fixer: progressFix,
  })
  assert.deepEqual(fixerLabels(labels), ['fixer:#101:r1'])
  assert.equal(out.status, 'maintainer-only')
  assert.equal(out.rounds.length, 2)
  assert.ok(labels.includes('bdfl-final:#101'))
})

// Defect proof: statusDetail is "the status line that the final agent gets",
// and here the round 1 fixer pushed a change, so the loop did not go two
// rounds without fixer progress.
test('pr-panel-loop: a maintainer-only exit after fixer progress does not tell the final agent "no fixer progress"', async () => {
  const { out, finalPrompt } = await runPanel({
    lens: (l) => ({ ...lensResult(l, 'FAIL'), findings: l === 'engineer' ? [{ severity: 'blocker', area: 'canary', issue: 'needs maintainer-only ruling', evidence: 'canary', suggested_fix: 'ESCALATE' }] : [] }),
    fixer: progressFix,
  })
  assert.equal(out.status, 'maintainer-only')
  assert.doesNotMatch(out.statusDetail, /no fixer progress/)
  assert.doesNotMatch(finalPrompt, /no fixer progress in the last 2/)
})

test('PROPOSED CONTRACT: pr-panel-loop treats commits without a push as push-failed even when applied is empty', { todo: true }, async () => {
  const { labels, out } = await runPanel({
    lens: (l) => lensResult(l, 'FAIL', ['blocker']),
    fixer: () => ({ applied: [], skipped: [], pushed: false, commits: ['c0ffee'], notes: 'canary committed, push rejected' }),
  })
  assert.equal(out.status, 'push-failed')
  assert.ok(!labels.includes('bdfl-final:#101'))
})
