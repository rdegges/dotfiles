// Skill bodies must survive Claude Code's argument substitution, and the
// session-trace hill-climb listing must parse every mined: entry form.
//
// Run from the repo root:
//   docker run --rm -v "$PWD":/w -w /w node:latest node --test tests/skills/
//
// What a pass proves: no SKILL.md body contains a dollar-digit token that
// Claude Code (as of 2.1.288, regex copied below) would replace with skill
// arguments, and the session-trace listing heredoc, run as written and as it
// loads after a `/session-trace <args>` call, reports exactly the unmined
// traces of a fixture vault whose Hill-climbs record uses bare, quoted, and
// [[wikilink]] entries. It runs the listing under the awk in node:latest
// (mawk), not the BSD /usr/bin/awk on the Mac, and it says nothing about
// substitution forms Claude Code may add later.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SKILLS = new URL('../../dot_claude/skills/', import.meta.url)
const SUBSTITUTION = /\$(\d+)(?!\w)/g

test('no SKILL.md body contains a token Claude Code replaces with skill arguments', () => {
  const hits = []
  for (const dir of readdirSync(SKILLS, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    let text
    try {
      text = readFileSync(new URL(`${dir.name}/SKILL.md`, SKILLS), 'utf8')
    } catch {
      continue
    }
    text.split('\n').forEach((line, i) => {
      if (line.match(SUBSTITUTION)) hits.push(`dot_claude/skills/${dir.name}/SKILL.md:${i + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(
    hits,
    [],
    'Claude Code replaces `$`+digit in skill bodies with skill arguments; in awk write `$(N)`.\n' + hits.join('\n'),
  )
})

// The listing heredoc, dedented, exactly as the archivist is told to run it.
function listing() {
  const lines = readFileSync(new URL('session-trace/SKILL.md', SKILLS), 'utf8').split('\n')
  const start = lines.indexOf("   bash <<'SH'")
  const end = lines.indexOf('   SH', start)
  assert.ok(start >= 0 && end > start, 'listing heredoc not found in session-trace/SKILL.md')
  return lines.slice(start, end + 1).map((l) => l.replace(/^ {3}/, '')).join('\n') + '\n'
}

// What the listing becomes after `/session-trace NAS container update pass`.
function substituted(script) {
  const args = 'NAS container update pass'.split(' ')
  return script.replace(SUBSTITUTION, (_, n) => args[Number(n)] ?? '')
}

const TRACES = [
  '2026-07-01 — alpha.md',
  '2026-07-02 — beta.md',
  "2026-07-03 — gamma's.md",
  '2026-07-04 — delta.md',
]

function vault({ record }) {
  const home = mkdtempSync(join(tmpdir(), 'session-trace-'))
  const dir = join(home, 'Vault/Personal/Resources/Personal/Session Traces')
  mkdirSync(dir, { recursive: true })
  for (const t of [...TRACES, '_template.md']) writeFileSync(join(dir, t), '# trace\n')
  if (record) {
    mkdirSync(join(dir, 'Hill-climbs'))
    writeFileSync(
      join(dir, 'Hill-climbs', '2026-08-01 1200 — hill-climb.md'),
      [
        '---',
        'date: 2026-08-01',
        'mined:',
        `  - ${TRACES[0]}`,
        `  - "${TRACES[1]}"`,
        `  - "[[${TRACES[2].replace(/\.md$/, '')}]]"`,
        'status: filed',
        '---',
        '',
        'mined:',
        `  - ${TRACES[3]}`,
        '',
      ].join('\n'),
    )
  }
  return home
}

function run(script, home) {
  return execFileSync('bash', [], { input: script, env: { ...process.env, HOME: home }, encoding: 'utf8' })
}

for (const [name, transform] of [
  ['as written', (s) => s],
  ['after /session-trace is called with arguments', substituted],
]) {
  test(`listing ${name}: a record's bare, quoted, and wikilink entries all count as mined`, () => {
    const out = run(transform(listing()), vault({ record: true }))
    assert.equal(out, `${TRACES[3]}\nunmined: 1\n`)
  })

  test(`listing ${name}: with no Hill-climbs folder every trace is unmined`, () => {
    const out = run(transform(listing()), vault({ record: false }))
    assert.equal(out, `${TRACES.join('\n')}\nunmined: 4\n`)
  })
}
