// Skill bodies must survive Claude Code's argument substitution, and the
// session-trace hill-climb listing must parse every mined: entry form.
//
// Run from the repo root (each extra awk is optional; without it its test
// skips; original-awk is the BWK awk that macOS ships as /usr/bin/awk):
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'apt-get update -qq && apt-get install -y -qq gawk original-awk busybox >/dev/null && node --test tests/skills/'
//
// What a pass proves: no SKILL.md body contains a dollar-digit token that
// Claude Code (as of 2.1.288, regex copied below) would replace with skill
// arguments, and the session-trace listing heredoc, run as written and as it
// loads after a `/session-trace <args>` call, reports exactly the unmined
// traces of a fixture vault whose Hill-climbs record uses bare, quoted, and
// [[wikilink]] entries (plus single-quoted, commented, path-prefixed,
// suffixless, and CRLF entries). It runs the listing under the image's awk
// (mawk) and, when installed, gawk, original-awk (BWK, the macOS awk family)
// and busybox awk. It does not run macOS /usr/bin/awk itself, the `$name`
// substitution for skills that declare `arguments:` in frontmatter, or
// substitution forms Claude Code may add later.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, mkdirSync, writeFileSync, mkdtempSync, existsSync, symlinkSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SKILLS = new URL('../../dot_claude/skills/', import.meta.url)
const SUBSTITUTION = /\$(\d+)(?!\w)/g

test('no SKILL.md body contains a token Claude Code replaces with skill arguments', () => {
  const hits = []
  const scanned = []
  for (const dir of readdirSync(SKILLS, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const file = new URL(`${dir.name}/SKILL.md`, SKILLS)
    if (!existsSync(file)) continue
    scanned.push(dir.name)
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (line.match(SUBSTITUTION)) hits.push(`dot_claude/skills/${dir.name}/SKILL.md:${i + 1}: ${line.trim()}`)
    })
  }
  // An empty scan would pass vacuously (moved dir, chezmoi rename to .tmpl).
  assert.ok(scanned.includes('session-trace'), `scanned only: ${scanned.join(', ')}`)
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
// Claude Code leaves `$N` alone when there is no Nth argument.
function substituted(script) {
  const args = 'NAS container update pass'.split(' ')
  return script.replace(SUBSTITUTION, (m, n) => args[Number(n)] ?? m)
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

function run(script, home, env = {}) {
  return execFileSync('bash', [], { input: script, env: { ...process.env, HOME: home, ...env }, encoding: 'utf8' })
}

function emptyTraces({ traces = [], record }) {
  const home = mkdtempSync(join(tmpdir(), 'session-trace-'))
  const dir = join(home, 'Vault/Personal/Resources/Personal/Session Traces')
  mkdirSync(join(dir, 'Hill-climbs'), { recursive: true })
  for (const t of [...traces, '_template.md']) writeFileSync(join(dir, t), '# trace\n')
  if (record) writeFileSync(join(dir, 'Hill-climbs', '2026-08-01 1200 — hill-climb.md'), record)
  return home
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

test('listing: single-quoted, commented, path-prefixed, and suffixless entries all count as mined', () => {
  const traces = ['2026-07-01 — a.md', "2026-07-02 — b's.md", '2026-07-03 — c.md', '2026-07-04 — d.md', '2026-07-05 — e.md']
  const record = [
    '---',
    'mined:',
    "  - '2026-07-01 — a.md'",
    "  - 2026-07-02 — b's.md   # had an apostrophe",
    '  - Resources/Personal/Session Traces/2026-07-03 — c.md',
    '  - 2026-07-04 — d',
    '---',
    '',
  ].join('\n')
  assert.equal(run(listing(), emptyTraces({ traces, record })), `${traces[4]}\nunmined: 1\n`)
})

test('listing: a CRLF record parses the same as LF', () => {
  const traces = ['2026-07-01 — a.md', '2026-07-02 — b.md', '2026-07-03 — c.md']
  const record = ['---', 'mined:', `  - ${traces[0]}`, `  - "${traces[1]}"`, '---', ''].join('\r\n')
  assert.equal(run(listing(), emptyTraces({ traces, record })), `${traces[2]}\nunmined: 1\n`)
})

test('listing: no traces at all reports unmined: 0 and exits 0', () => {
  assert.equal(run(listing(), emptyTraces({})), 'unmined: 0\n')
})

test('listing: every trace mined reports unmined: 0 with no blank list line', () => {
  const traces = ['2026-07-01 — a.md', '2026-07-02 — b.md']
  const record = ['---', 'mined:', ...traces.map((t) => `  - ${t}`), '---', ''].join('\n')
  assert.equal(run(listing(), emptyTraces({ traces, record })), 'unmined: 0\n')
})

// The listing must parse the same under every awk family it may meet; the
// archivist runs it on macOS, whose /usr/bin/awk is BWK awk.
for (const [name, argv] of [
  ['gawk', ['gawk']],
  ['original-awk', ['original-awk']],
  ['busybox awk', ['busybox', 'awk']],
]) {
  const found = spawnSync('sh', ['-c', `command -v ${argv[0]}`], { encoding: 'utf8' })
  const bin = found.status === 0 ? found.stdout.trim() : null
  const skip = bin ? false : `${argv[0]} not installed (see the run command at the top)`
  test(`listing under ${name}: same unmined list as mawk, as written and after substitution`, { skip }, () => {
    const shim = mkdtempSync(join(tmpdir(), 'awk-shim-'))
    if (argv.length === 1) symlinkSync(bin, join(shim, 'awk'))
    else {
      writeFileSync(join(shim, 'awk'), `#!/bin/sh\nexec ${bin} ${argv.slice(1).join(' ')} "$@"\n`, { mode: 0o755 })
    }
    const env = { PATH: `${shim}:${process.env.PATH}` }
    const used = execFileSync('bash', ['-c', 'readlink -f "$(command -v awk)"'], { env, encoding: 'utf8' }).trim()
    assert.ok(used.startsWith(shim) || used === bin, `awk resolved to ${used}, not ${bin}`)
    for (const transform of [(s) => s, substituted]) {
      assert.equal(run(transform(listing()), vault({ record: true }), env), `${TRACES[3]}\nunmined: 1\n`)
      assert.equal(run(transform(listing()), vault({ record: false }), env), `${TRACES.join('\n')}\nunmined: 4\n`)
    }
  })
}
