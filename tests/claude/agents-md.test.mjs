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
// exception that the navia-fsa-claims skill cites. It also proves the old
// ~/AGENTS.md stays retired: .chezmoiremove lists it, and no source entry
// renders a file there. It says nothing about how either agent reads the
// text; that needs a live session.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

function managed(work) {
  const home = mkdtempSync(join(tmpdir(), 'agents-md-'))
  try {
    const r = spawnSync(
      'chezmoi',
      ['--source', SOURCE, '--destination', home, '--override-data', JSON.stringify({ work }), 'managed'],
      { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } },
    )
    assert.ifError(r.error)
    assert.equal(r.status, 0, `chezmoi managed (work=${work}) exited ${r.status}: ${r.stderr}`)
    return r.stdout.split('\n')
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

test('.chezmoiremove retires the top-level ~/AGENTS.md', () => {
  const lines = readFileSync(join(SOURCE, '.chezmoiremove'), 'utf8').split('\n')
  assert.ok(lines.includes('AGENTS.md'))
})

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

  test(`work=${work}: no source entry renders a top-level ~/AGENTS.md`, () => {
    const targets = managed(work)
    // A real target proves the list is not empty for some unrelated reason.
    assert.ok(targets.includes('.codex/AGENTS.md'), 'chezmoi managed does not list .codex/AGENTS.md')
    assert.ok(!targets.includes('AGENTS.md'))
  })

  test(`work=${work}: Codex carries the Navia standing exception word for word`, () => {
    const m = claude().match(/Standing exception: while you follow the `navia-fsa-claims` skill[^\n]*?needs my confirmation\./)
    assert.ok(m, 'no Navia standing exception in the Claude render')
    assert.ok(codex().includes(m[0]))
  })
}
