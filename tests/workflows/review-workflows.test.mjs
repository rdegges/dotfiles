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
