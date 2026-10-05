// dot_claude/CLAUDE.md.tmpl renders two targets: ~/.claude/CLAUDE.md, and
// ~/.codex/AGENTS.md through dot_codex/AGENTS.md.tmpl with reader=codex.
//
// Run from the repo root (chezmoi is needed; without it every test FAILS, it
// does not skip):
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin && node --test tests/claude/'
//
// What a pass proves: for work=false and work=true, chezmoi renders both real
// targets from this source tree with a throwaway HOME; neither render is empty;
// the Codex render ends in one newline and has no run of blank lines; every
// Claude sentence that names no Claude-only tool reaches Codex word for word
// (so a shared rule cannot drift between the two); the Codex render names no
// Claude product or Claude-only tool; Delegation is Claude-only; Work tracking
// follows the work flag in both; and Codex carries the Navia standing
// exception that the navia-fsa-claims skill cites. It says nothing about how
// either agent reads the text; that needs a live session.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SOURCE = new URL('../../', import.meta.url).pathname
const CLAUDE_ONLY = ['switch_browser', 'WebFetch', 'WebSearch', 'codex-computer-use', 'Bash tool', 'mcp__']
const DELEGATION = '## Delegation (work machine)'
const WORK_TRACKING = '## Work tracking (work machine)'

function render(target, work) {
  const home = mkdtempSync(join(tmpdir(), 'agents-md-'))
  try {
    const r = spawnSync(
      'chezmoi',
      ['--source', SOURCE, '--destination', home, '--override-data', JSON.stringify({ work }), 'cat', join(home, target)],
      { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } },
    )
    assert.ifError(r.error)
    assert.equal(r.status, 0, `chezmoi cat ${target} (work=${work}) exited ${r.status}: ${r.stderr}`)
    assert.ok(r.stdout.length > 0, `chezmoi cat ${target} (work=${work}) printed nothing`)
    return r.stdout
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function withoutDelegation(text) {
  return text.replace(/^## Delegation \(work machine\)\n[\s\S]*?(?=^## )/m, '')
}

// Lines, less list markers, cut at sentence ends. A wrong cut only makes the
// pieces smaller, which keeps the word-for-word check sound.
function sentences(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/^(- |#+ )/, '').trim())
    .filter(Boolean)
    .flatMap((l) => l.split(/(?<=[.!?])\s+(?=[A-Z*`"~])/))
}

for (const work of [false, true]) {
  const claude = () => render('.claude/CLAUDE.md', work)
  const codex = () => render('.codex/AGENTS.md', work)

  test(`work=${work}: both targets render`, () => {
    claude()
    codex()
  })

  test(`work=${work}: Codex render ends in one newline and has no run of blank lines`, () => {
    const c = codex()
    assert.ok(c.endsWith('\n') && !c.endsWith('\n\n'), JSON.stringify(c.slice(-20)))
    assert.equal(c.indexOf('\n\n\n'), -1)
  })

  test(`work=${work}: Claude render has no run of blank lines it did not already have`, () => {
    // The blank line pair before Delegation predates the Codex render; the
    // Claude target stays byte-identical, so it is the one allowed run.
    const c = claude().replace(`\n\n\n${DELEGATION}`, `\n\n${DELEGATION}`)
    assert.equal(c.indexOf('\n\n\n'), -1)
  })

  test(`work=${work}: every shared Claude sentence appears word for word in Codex`, () => {
    const c = codex()
    const shared = sentences(withoutDelegation(claude())).filter(
      (s) => !/claude/i.test(s) && !CLAUDE_ONLY.some((t) => s.includes(t)),
    )
    assert.ok(shared.length > 40, `only ${shared.length} shared sentences found`)
    const missing = shared.filter((s) => !c.includes(s))
    assert.deepEqual(missing, [])
  })

  test(`work=${work}: Codex render names no Claude product or Claude-only tool`, () => {
    const c = codex()
    assert.doesNotMatch(c, /claude/i)
    for (const t of CLAUDE_ONLY) assert.ok(!c.includes(t), `Codex render contains ${t}`)
  })

  test(`work=${work}: Delegation is Claude-only`, () => {
    assert.ok(!codex().includes(DELEGATION))
    assert.equal(claude().includes(DELEGATION), work)
  })

  test(`work=${work}: Work tracking renders in both targets only on a work machine`, () => {
    assert.equal(claude().includes(WORK_TRACKING), work)
    assert.equal(codex().includes(WORK_TRACKING), work)
  })

  test(`work=${work}: Codex carries the Navia standing exception word for word`, () => {
    const m = claude().match(/Standing exception: while you follow the `navia-fsa-claims` skill[^\n]*?needs my confirmation\./)
    assert.ok(m, 'no Navia standing exception in the Claude render')
    assert.ok(codex().includes(m[0]))
  })
}

// Tester additions. The checks above prove the Codex side drops Claude-only
// text; these prove each side still says what it should, so a swapped or
// emptied {{ if $codex }} branch cannot pass silently.
const CODEX_ONLY = [
  'the Codex Chrome plugin (`chrome`, which drives my real Chrome through the ChatGPT Chrome Extension)',
  'or Computer Use instead',
  'Reading a public page with web search is not a browser task.',
  'none chosen: ask me which one to use.',
  'switch to the Codex Chrome plugin.',
  'the ChatGPT Chrome Extension installed and signed in to my ChatGPT account',
]

for (const work of [false, true]) {
  const claude = () => render('.claude/CLAUDE.md', work)
  const codex = () => render('.codex/AGENTS.md', work)

  test(`work=${work}: each target names its own rules file in the title and precedence line`, () => {
    const cl = claude()
    const cx = codex()
    assert.ok(cl.startsWith('# Global CLAUDE.md – Personal Defaults\n'), JSON.stringify(cl.slice(0, 60)))
    assert.ok(cx.startsWith('# Global AGENTS.md – Personal Defaults\n'), JSON.stringify(cx.slice(0, 60)))
    assert.match(cl, /Project `CLAUDE\.md` rules win on conflict\./)
    assert.match(cx, /Project `AGENTS\.md` rules win on conflict\./)
  })

  test(`work=${work}: Claude render keeps every Claude-only tool clause`, () => {
    const cl = claude()
    for (const t of CLAUDE_ONLY) assert.ok(cl.includes(t), `Claude render lost ${t}`)
    assert.ok(cl.includes('and the Bash tool runs every command inside one.'))
    assert.ok(cl.includes('`/chrome` in Claude Code to connect or reconnect'))
  })

  test(`work=${work}: Claude render carries no Codex-only replacement text`, () => {
    const cl = claude()
    for (const t of CODEX_ONLY) assert.ok(!cl.includes(t), `Claude render contains ${t}`)
  })

  test(`work=${work}: Codex render carries every Codex replacement clause`, () => {
    const cx = codex()
    for (const t of CODEX_ONLY) assert.ok(cx.includes(t), `Codex render lacks ${t}`)
    assert.ok(cx.includes('`set -e` is no guard: it is off inside `&&`/`||` lists and `if` tests.\n'))
  })

  test(`work=${work}: neither render leaks template syntax`, () => {
    for (const r of [claude(), codex()]) assert.doesNotMatch(r, /\{\{|\}\}|\$codex|<no value>/)
  })
}
