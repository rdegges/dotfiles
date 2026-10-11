// dot_config/opencode/AGENTS.md.tmpl renders ~/.config/opencode/AGENTS.md from
// dot_claude/CLAUDE.md.tmpl with no reader override.
//
// Run from the repo root (chezmoi is needed; without it every test FAILS, it
// does not skip):
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin && node --test tests/claude/'
//
// What a pass proves: for work=false and work=true, chezmoi renders both
// targets from this source tree with a throwaway HOME, neither is empty, and
// they are byte-identical, so opencode and Claude Code read the same rules.
// It also proves the Brewfile installs opencode from homebrew-core only. It says
// nothing about how opencode reads the file; that needs a live session.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const SOURCE = new URL('../../', import.meta.url).pathname

function render(target, work) {
  const home = mkdtempSync(join(tmpdir(), 'opencode-rules-'))
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

for (const work of [false, true]) {
  test(`work=${work}: opencode AGENTS.md is byte-identical to CLAUDE.md`, () => {
    const claude = render('.claude/CLAUDE.md', work)
    assert.ok(claude.startsWith('# Global CLAUDE.md'), JSON.stringify(claude.slice(0, 40)))
    assert.equal(render('.config/opencode/AGENTS.md', work), claude)
  })
}

test('Brewfile installs opencode from homebrew-core, not the v1 tap', () => {
  const lines = readFileSync(join(SOURCE, 'dot_brew/Brewfile'), 'utf8').split('\n')
  assert.ok(lines.includes('brew "opencode"'))
  assert.ok(!lines.some((l) => !l.startsWith('#') && l.includes('anomalyco/tap')), 'anomalyco/tap ships OpenCode 1 and would install a second copy')
})

// Tester additions. The checks above use `chezmoi cat`, which renders a target
// but never writes it. These prove a real apply puts the file in place next to
// the user's own opencode config, that the Brewfile names opencode exactly once
// from one source, and that the Brewfile change re-triggers the install script.

function applied(work, seed, check) {
  const home = mkdtempSync(join(tmpdir(), 'opencode-rules-'))
  try {
    seed(home)
    for (const pass of [1, 2]) {
      const r = spawnSync(
        'chezmoi',
        ['--source', SOURCE, '--destination', home, '--override-data', JSON.stringify({ work }), '--no-tty', 'apply', '--force', '--exclude=scripts,externals'],
        { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } },
      )
      assert.ifError(r.error)
      assert.equal(r.status, 0, `chezmoi apply pass ${pass} (work=${work}) exited ${r.status}: ${r.stderr}`)
      check(home, pass)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

const OPENCODE_DIR = '.config/opencode'
const USER_FILES = { 'opencode.json': '{"theme":"mine"}\n', 'agent/review.md': 'my agent\n', 'AGENTS.md.bak': 'old\n' }

for (const work of [false, true]) {
  test(`work=${work}: apply writes ~/.config/opencode/AGENTS.md equal to ~/.claude/CLAUDE.md and keeps the user's opencode files`, () => {
    applied(
      work,
      (home) => {
        mkdirSync(join(home, OPENCODE_DIR, 'agent'), { recursive: true })
        for (const [f, body] of Object.entries(USER_FILES)) writeFileSync(join(home, OPENCODE_DIR, f), body)
        writeFileSync(join(home, OPENCODE_DIR, 'AGENTS.md'), 'stale hand-written rules\n')
      },
      (home, pass) => {
        const path = join(home, OPENCODE_DIR, 'AGENTS.md')
        const st = lstatSync(path)
        assert.ok(st.isFile(), `pass ${pass}: AGENTS.md is not a regular file`)
        assert.equal(st.mode & 0o111, 0, `pass ${pass}: AGENTS.md is executable`)
        const body = readFileSync(path, 'utf8')
        assert.ok(body.startsWith('# Global CLAUDE.md'), `pass ${pass}: ${JSON.stringify(body.slice(0, 40))}`)
        assert.equal(body, readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8'), `pass ${pass}: applied files differ`)
        for (const [f, b] of Object.entries(USER_FILES)) {
          assert.equal(readFileSync(join(home, OPENCODE_DIR, f), 'utf8'), b, `pass ${pass}: ${f} changed`)
        }
        // Only the rules file is managed: no .tmpl or other stray entry appears.
        assert.deepEqual(readdirSync(join(home, OPENCODE_DIR)).sort(), ['AGENTS.md', 'AGENTS.md.bak', 'agent', 'opencode.json'])
      },
    )
  })

  test(`work=${work}: apply replaces a ~/.config/opencode/AGENTS.md symlink instead of writing through it`, () => {
    applied(
      work,
      (home) => {
        mkdirSync(join(home, 'Code/rdegges/site'), { recursive: true })
        writeFileSync(join(home, 'Code/rdegges/site/AGENTS.md'), 'project rules\n')
        mkdirSync(join(home, OPENCODE_DIR), { recursive: true })
        symlinkSync(join(home, 'Code/rdegges/site/AGENTS.md'), join(home, OPENCODE_DIR, 'AGENTS.md'))
      },
      (home, pass) => {
        assert.equal(readFileSync(join(home, 'Code/rdegges/site/AGENTS.md'), 'utf8'), 'project rules\n', `pass ${pass}: apply wrote through the link`)
        assert.ok(lstatSync(join(home, OPENCODE_DIR, 'AGENTS.md')).isFile(), `pass ${pass}: link survived`)
      },
    )
  })

  test(`work=${work}: chezmoi manages ~/.config/opencode/AGENTS.md and nothing else under ~/.config/opencode`, () => {
    const home = mkdtempSync(join(tmpdir(), 'opencode-rules-'))
    try {
      const r = spawnSync(
        'chezmoi',
        ['--source', SOURCE, '--destination', home, '--override-data', JSON.stringify({ work }), 'managed', '--include=files'],
        { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } },
      )
      assert.ifError(r.error)
      assert.equal(r.status, 0, `chezmoi managed exited ${r.status}: ${r.stderr}`)
      const lines = r.stdout.split('\n')
      assert.ok(lines.includes('.claude/CLAUDE.md'), 'list is missing a known target')
      assert.deepEqual(lines.filter((l) => l.startsWith(`${OPENCODE_DIR}/`)), [`${OPENCODE_DIR}/AGENTS.md`])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
}

// Every brew/cask/tap entry that could put an `opencode` binary on PATH. The
// tap's opencode-v2 formula declares conflicts_with "opencode", and the old
// sst/tap name redirects to the same tap, so either would break `brew bundle`.
test('Brewfile has exactly one opencode entry and no tap that also ships one', () => {
  const entries = readFileSync(join(SOURCE, 'dot_brew/Brewfile'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => !l.startsWith('#'))
    .map((l) => l.match(/^(brew|cask|tap)\s+"([^"]+)"/))
    .filter(Boolean)
    .map(([, kind, name]) => ({ kind, name }))
  assert.ok(entries.length > 20, `only ${entries.length} entries parsed`)
  const opencode = entries.filter(({ kind, name }) => kind !== 'tap' && /(^|\/)opencode(-v\d+)?$/.test(name))
  assert.deepEqual(opencode, [{ kind: 'brew', name: 'opencode' }])
  const taps = entries.filter(({ kind, name }) => kind === 'tap' && /^(anomalyco|sst)\//.test(name))
  assert.deepEqual(taps, [])
})

// run_onchange_ scripts re-run only when their rendered text changes. The
// Brewfile hash in the script is what makes this Brewfile edit install opencode.
test('install-packages script embeds the current Brewfile hash and bundles ~/.brew/Brewfile on darwin', () => {
  const home = mkdtempSync(join(tmpdir(), 'opencode-rules-'))
  try {
    const r = spawnSync(
      'chezmoi',
      ['--source', SOURCE, '--destination', home, '--override-data', JSON.stringify({ work: false, chezmoi: { os: 'darwin' } }), 'execute-template'],
      { encoding: 'utf8', input: readFileSync(join(SOURCE, 'run_onchange_install-packages.sh.tmpl'), 'utf8'), env: { PATH: process.env.PATH, HOME: home } },
    )
    assert.ifError(r.error)
    assert.equal(r.status, 0, `chezmoi execute-template exited ${r.status}: ${r.stderr}`)
    const sha = createHash('sha256').update(readFileSync(join(SOURCE, 'dot_brew/Brewfile'))).digest('hex')
    assert.ok(r.stdout.includes(`# ~/.brew/Brewfile hash: ${sha}\n`), JSON.stringify(r.stdout.slice(0, 120)))
    assert.ok(r.stdout.includes('brew bundle --file=~/.brew/Brewfile'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// PROPOSED CONTRACT: the opencode copy is the Claude render verbatim, so it
// tells opencode to use Claude-only machinery it does not have (Claude in
// Chrome, the acceptance-gate workflow and its agents, the Skill tool). Codex
// gets a reader-specific render for the same reason. Todo until the maker
// decides whether opencode should get one too.
for (const work of [false, true]) {
  test(`PROPOSED CONTRACT: work=${work}: opencode render names no Claude-only tool or gate`, { todo: true }, () => {
    const oc = render('.config/opencode/AGENTS.md', work)
    for (const t of ['mcp__claude-in-chrome', 'acceptance-gate', 'red-team-reviewer', '`/chrome` in Claude Code', 'Bash tool']) {
      assert.ok(!oc.includes(t), `opencode render contains ${t}`)
    }
  })
}
