// acceptance-gate workflow: arg validation, gate order, and the rerun-once
// rule for a gate agent whose report is missing or cut off.
//
// Run from the repo root:
//   docker run --rm -v "$PWD":/w -w /w node:latest node --test tests/workflows/acceptance-gate.test.mjs
//
// What a pass proves: under a stub runtime (scripted agent() results), the
// script validates its args, runs tester -> red-team -> bdfl in order, reruns a
// gate agent exactly once on an invalid result, and stops with no verdict on a
// second one. It says nothing about real agents or whether the runtime's
// agent() returns null or throws when an agent drops.
//
// The script is evaluated the way the workflow runtime runs it (top-level await
// and return), as an AsyncFunction body. All args are canary values.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

function load() {
  const text = readFileSync(new URL('../../dot_claude/workflows/acceptance-gate.js', import.meta.url), 'utf8')
  const src = text.replace(/^export const meta =/m, 'const meta =')
  return new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', src)
}

const ARGS = () => ({
  repo: '/canary/repo',
  change: 'canary-branch, commit range origin/main..HEAD',
  spec: 'CANARY SPEC: do the canary thing',
  runNotes: 'canary run notes',
})

const TESTER_OK = 'TESTS: PASS — canary 3/3, 1 added, 0 modified — canary read.\n\nWhat ran: canary'
const REDTEAM_OK = 'CANARY RED-TEAM REPORT'
const BDFL_OK = { verdict: 'APPROVE', reason: 'canary reason', conditions: [], guidance: '', report: 'CANARY BDFL REPORT' }

// Each script entry is a list of results returned in call order for that
// label; a function entry is called (and may throw). Unscripted calls fail the
// test loudly, so an extra agent call cannot hide.
// args is taken from the arguments list so an explicit undefined stays undefined.
async function run(script = {}, ...rest) {
  const args = rest.length ? rest[0] : ARGS()
  const calls = []
  const seen = {}
  const agent = async (prompt, opts) => {
    calls.push({ fn: 'agent', label: opts && opts.label, prompt, opts })
    const label = opts && opts.label
    const list = script[label] ?? [{ tester: TESTER_OK, 'red-team': REDTEAM_OK, bdfl: BDFL_OK }[label]]
    const i = seen[label] ?? 0
    seen[label] = i + 1
    if (i >= list.length) throw new Error(`unscripted agent call #${i + 1} for ${label}`)
    const r = list[i]
    return typeof r === 'function' ? r() : r
  }
  const phase = (title) => calls.push({ fn: 'phase', title })
  const log = (msg) => calls.push({ fn: 'log', msg })
  const parallel = async () => assert.fail('acceptance-gate must not use parallel()')
  const pipeline = async () => assert.fail('acceptance-gate must not use pipeline()')
  try {
    return { calls, result: await load()(agent, parallel, pipeline, phase, log, args), labels: agents(calls) }
  } catch (error) {
    return { calls, error, labels: agents(calls) }
  }
}
const agents = (calls) => calls.filter((c) => c.fn === 'agent').map((c) => c.label)
const logs = (calls) => calls.filter((c) => c.fn === 'log').map((c) => c.msg)
const promptOf = (calls, label, nth = 0) => calls.filter((c) => c.label === label)[nth].prompt

// --- Load and arg validation -------------------------------------------------

test('acceptance-gate: loads via AsyncFunction without a syntax error', () => {
  assert.equal(typeof load(), 'function')
})

for (const key of ['repo', 'change', 'spec']) {
  for (const [how, mutate] of [
    ['missing', (a) => delete a[key]],
    ['empty', (a) => (a[key] = '')],
  ]) {
    test(`acceptance-gate: ${key} ${how} throws before any phase/log/agent call`, async () => {
      const args = ARGS()
      mutate(args)
      const { calls, error } = await run({}, args)
      assert.ok(error, 'expected the script to throw')
      assert.match(error.message, /args\.repo, args\.change, and args\.spec are required/)
      assert.deepEqual(calls, [])
    })
  }
}

test('acceptance-gate: args null or undefined throws before any call', async () => {
  for (const a of [null, undefined]) {
    const { calls, error } = await run({}, a)
    assert.ok(error, `expected a throw for ${a}`)
    assert.deepEqual(calls, [])
  }
})

test('acceptance-gate: args as a JSON string behave like the object', async () => {
  const { result, error, labels } = await run({}, JSON.stringify(ARGS()))
  assert.equal(error, undefined, error && error.message)
  assert.deepEqual(labels, ['tester', 'red-team', 'bdfl'])
  assert.equal(result.verdict, 'APPROVE')
})

// --- Happy path ----------------------------------------------------------------

test('acceptance-gate: valid first results run tester -> red-team -> bdfl once each, with no rerun', async () => {
  const { calls, result, error } = await run()
  assert.equal(error, undefined, error && error.message)
  assert.deepEqual(
    calls.filter((c) => c.fn !== 'log').map((c) => (c.fn === 'phase' ? `phase:${c.title}` : c.label)),
    ['phase:Test', 'tester', 'phase:Review', 'red-team', 'phase:Gate', 'bdfl'],
  )
  assert.deepEqual(logs(calls), ['BDFL: APPROVE — canary reason'])
  assert.deepEqual(result, {
    verdict: 'APPROVE',
    reason: 'canary reason',
    conditions: [],
    guidance: '',
    bdflReport: 'CANARY BDFL REPORT',
    testerReport: TESTER_OK,
    redTeamReport: REDTEAM_OK,
    reruns: [],
  })
})

test('acceptance-gate: each gate gets its agentType, and only bdfl gets the verdict schema', async () => {
  const { calls } = await run()
  const opts = Object.fromEntries(calls.filter((c) => c.fn === 'agent').map((c) => [c.label, c.opts]))
  assert.equal(opts.tester.agentType, 'tester')
  assert.equal(opts['red-team'].agentType, 'red-team-reviewer')
  assert.equal(opts.bdfl.agentType, 'bdfl')
  assert.equal(opts.tester.schema, undefined)
  assert.equal(opts['red-team'].schema, undefined)
  assert.deepEqual(opts.bdfl.schema.properties.verdict.enum, ['APPROVE', 'APPROVE WITH CONDITIONS', 'REVISE', 'REJECT'])
})

test('acceptance-gate: prompts carry the args, red-team never sees the tester report, bdfl sees both', async () => {
  const { calls } = await run()
  const t = promptOf(calls, 'tester')
  const r = promptOf(calls, 'red-team')
  const b = promptOf(calls, 'bdfl')
  for (const p of [t, r, b]) {
    assert.ok(p.includes('/canary/repo'))
    assert.ok(p.includes('origin/main..HEAD'))
    assert.doesNotMatch(p, /undefined|\[object Object\]|null/)
  }
  assert.ok(t.includes('Notes: canary run notes'))
  assert.ok(r.includes('CANARY SPEC') && b.includes('CANARY SPEC'))
  assert.ok(!r.includes(TESTER_OK), 'red-team must stay blind to the tester report')
  assert.ok(b.includes(TESTER_OK) && b.includes(REDTEAM_OK))
})

test('acceptance-gate: no runNotes means no Notes: clause in the tester prompt', async () => {
  const args = ARGS()
  delete args.runNotes
  const { calls } = await run({}, args)
  assert.ok(!promptOf(calls, 'tester').includes('Notes:'))
})

for (const verdict of ['APPROVE', 'APPROVE WITH CONDITIONS', 'REVISE', 'REJECT']) {
  test(`acceptance-gate: bdfl verdict ${verdict} is accepted first time and returned`, async () => {
    const { result, error, labels } = await run({ bdfl: [{ ...BDFL_OK, verdict }] })
    assert.equal(error, undefined, error && error.message)
    assert.deepEqual(labels, ['tester', 'red-team', 'bdfl'])
    assert.equal(result.verdict, verdict)
    assert.deepEqual(result.reruns, [])
  })
}

// --- Tester status-line check -------------------------------------------------

const TESTER_VALID = [
  ['TESTS: PASS alone', 'TESTS: PASS'],
  ['TESTS: FAIL with the full line', 'TESTS: FAIL — 3/4, 1 added, 0 modified — one defect.'],
  ['leading blank lines and spaces', '\n\n   TESTS: PASS — canary'],
  ['TESTS: PASS followed by a comma', 'TESTS: PASS, canary'],
]
for (const [name, report] of TESTER_VALID) {
  test(`acceptance-gate: tester report accepted without rerun: ${name}`, async () => {
    const { result, error, labels } = await run({ tester: [report] })
    assert.equal(error, undefined, error && error.message)
    assert.deepEqual(labels, ['tester', 'red-team', 'bdfl'])
    assert.deepEqual(result.reruns, [])
    assert.equal(result.testerReport, report)
  })
}

const TESTER_INVALID = [
  ['null (dropped agent)', null],
  ['undefined', undefined],
  ['empty string', ''],
  ['whitespace only', ' \n\t '],
  ['cut off before the status line', 'Running the baseline suite now...'],
  ['status line not on line 1', 'Summary first.\nTESTS: PASS — canary'],
  ['TESTS: PASSED (no word boundary)', 'TESTS: PASSED — canary'],
  ['lowercase tests: pass', 'tests: pass — canary'],
  ['unknown status TESTS: SKIP', 'TESTS: SKIP — canary'],
  ['status line prefixed with other text', 'Report: TESTS: PASS — canary'],
  ['a non-string object', { report: 'TESTS: PASS' }],
]
for (const [name, bad] of TESTER_INVALID) {
  test(`acceptance-gate: tester ${name} reruns the tester once, logs it, and the valid rerun goes on`, async () => {
    const { calls, result, error, labels } = await run({ tester: [bad, TESTER_OK] })
    assert.equal(error, undefined, error && error.message)
    assert.deepEqual(labels, ['tester', 'tester', 'red-team', 'bdfl'])
    assert.deepEqual(result.reruns, ['tester'])
    assert.equal(result.testerReport, TESTER_OK)
    assert.ok(logs(calls).some((m) => m.startsWith('tester:') && /rerunning once/.test(m)), 'rerun must be logged')
  })
}

test('acceptance-gate: the tester rerun uses the identical prompt and opts', async () => {
  const { calls } = await run({ tester: [null, TESTER_OK] })
  const [a, b] = calls.filter((c) => c.label === 'tester')
  assert.equal(a.prompt, b.prompt)
  assert.deepEqual(a.opts, b.opts)
})

test('acceptance-gate: bdfl gets the rerun tester report, never the cut-off first one', async () => {
  const cut = 'CANARY CUT-OFF PARTIAL TESTER OUTPUT'
  const { calls } = await run({ tester: [cut, TESTER_OK] })
  const b = promptOf(calls, 'bdfl')
  assert.ok(b.includes(TESTER_OK))
  assert.ok(!b.includes(cut))
})

test('acceptance-gate: tester invalid twice stops with no verdict and never reaches red-team or bdfl', async () => {
  const { calls, error, labels } = await run({ tester: [null, 'still cut off'] })
  assert.ok(error, 'expected the script to throw')
  assert.match(error.message, /^tester returned no valid report twice; the gate has no verdict$/)
  assert.deepEqual(labels, ['tester', 'tester'])
  assert.ok(!calls.some((c) => c.fn === 'phase' && c.title !== 'Test'))
  assert.ok(!logs(calls).some((m) => m.startsWith('BDFL:')))
})

// --- Red-team non-empty check -------------------------------------------------

for (const [name, bad] of [
  ['null', null],
  ['empty string', ''],
  ['whitespace only', '\n  \n'],
  ['a non-string object', { report: 'x' }],
]) {
  test(`acceptance-gate: red-team ${name} reruns red-team once and the rerun report reaches bdfl`, async () => {
    const { calls, result, error, labels } = await run({ 'red-team': [bad, REDTEAM_OK] })
    assert.equal(error, undefined, error && error.message)
    assert.deepEqual(labels, ['tester', 'red-team', 'red-team', 'bdfl'])
    assert.deepEqual(result.reruns, ['red-team'])
    assert.equal(result.redTeamReport, REDTEAM_OK)
    assert.ok(promptOf(calls, 'bdfl').includes(REDTEAM_OK))
  })
}

test('acceptance-gate: red-team invalid twice stops with no verdict and never calls bdfl', async () => {
  const { error, labels } = await run({ 'red-team': [null, ''] })
  assert.ok(error)
  assert.match(error.message, /^red-team returned no valid report twice/)
  assert.deepEqual(labels, ['tester', 'red-team', 'red-team'])
})

// --- BDFL verdict check -------------------------------------------------------

for (const [name, bad] of [
  ['null', null],
  ['a string instead of the schema object', 'APPROVE'],
  ['an object with no verdict', { ...BDFL_OK, verdict: undefined }],
  ['a lowercase verdict', { ...BDFL_OK, verdict: 'approve' }],
  ['an unknown verdict', { ...BDFL_OK, verdict: 'LGTM' }],
  ['a verdict with trailing space', { ...BDFL_OK, verdict: 'APPROVE ' }],
]) {
  test(`acceptance-gate: bdfl ${name} reruns bdfl once and returns the rerun verdict`, async () => {
    const rerun = { ...BDFL_OK, verdict: 'REVISE', reason: 'canary rerun reason' }
    const { calls, result, error, labels } = await run({ bdfl: [bad, rerun] })
    assert.equal(error, undefined, error && error.message)
    assert.deepEqual(labels, ['tester', 'red-team', 'bdfl', 'bdfl'])
    assert.equal(result.verdict, 'REVISE')
    assert.equal(result.reason, 'canary rerun reason')
    assert.deepEqual(result.reruns, ['bdfl'])
    assert.deepEqual(logs(calls).filter((m) => m.startsWith('BDFL:')), ['BDFL: REVISE — canary rerun reason'])
  })
}

test('acceptance-gate: bdfl invalid twice throws instead of returning a verdict', async () => {
  const { calls, error, result } = await run({ bdfl: [null, { ...BDFL_OK, verdict: 'MAYBE' }] })
  assert.ok(error)
  assert.equal(result, undefined)
  assert.match(error.message, /^bdfl returned no valid report twice/)
  assert.ok(!logs(calls).some((m) => m.startsWith('BDFL:')))
})

// --- Cross-gate behavior ------------------------------------------------------

test('acceptance-gate: reruns in several gates are all listed, in gate order', async () => {
  const { result, labels } = await run({ tester: [null, TESTER_OK], 'red-team': ['', REDTEAM_OK], bdfl: [null, BDFL_OK] })
  assert.deepEqual(labels, ['tester', 'tester', 'red-team', 'red-team', 'bdfl', 'bdfl'])
  assert.deepEqual(result.reruns, ['tester', 'red-team', 'bdfl'])
})

test('acceptance-gate: a rerun in one run does not leak into the next run', async () => {
  const first = await run({ tester: [null, TESTER_OK] })
  assert.deepEqual(first.result.reruns, ['tester'])
  const second = await run()
  assert.deepEqual(second.result.reruns, [])
})

test('acceptance-gate: an agent() that throws stops the run with no verdict', async () => {
  const boom = () => {
    throw new Error('canary runtime failure')
  }
  const { error, result, labels } = await run({ tester: [boom, boom] })
  assert.ok(error)
  assert.equal(result, undefined)
  assert.ok(!labels.includes('red-team') && !labels.includes('bdfl'))
})
