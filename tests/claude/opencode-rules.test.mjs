// dot_config/opencode/AGENTS.md.tmpl renders ~/.config/opencode/AGENTS.md from
// dot_claude/CLAUDE.md.tmpl with reader=opencode.
//
// Run from the repo root (chezmoi is needed; without it every test FAILS, it
// does not skip):
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin && node --test tests/claude/'
//
// What a pass proves: for work=false and work=true, chezmoi renders both
// targets from this source tree with a throwaway HOME, neither is empty, and
// they are byte-identical outside the ### Browser section, so opencode and
// Claude Code read the same rules except which browser tool to drive; that
// section names opencode's Browser Control and no Claude browser tool. It
// also proves the install script renders the plugin add. It says nothing about
// whether opencode can drive Chrome; that needs the plugin, its extension, and
// a live session.
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

// The ### Browser section up to the next ### heading.
const BROWSER = /^### Browser\n[\s\S]*?(?=^### )/m

function browser(text) {
  // A missing or doubled heading would make the outside-Browser comparison vacuous.
  for (const h of ['### Browser\n', '### Code locations\n']) assert.equal(text.split(`\n${h}`).length, 2, `${h.trim()} does not appear exactly once`)
  const m = text.match(BROWSER)
  assert.ok(m, 'no ### Browser section')
  return m[0]
}

const CLAUDE_BROWSER = ['mcp__claude-in-chrome', 'claude-in-chrome', 'Claude in Chrome', 'switch_browser', '/chrome', 'claude.ai', 'tester.md', 'codex-computer-use', 'Codex Chrome plugin', 'ChatGPT']
const OPENCODE_BROWSER = [
  'Every browser task goes through Browser Control (the `browser` skill from the `@opencode-ai/browser-control` plugin',
  'Several browsers connected and none chosen: ask me which one to use.',
  'Use only your own browser tool. When a skill or rule names another agent\'s browser tool, use yours in its place.',
  'or the task needs a web UI, switch to Browser Control.',
  '`opencode plugin add @opencode-ai/browser-control`',
]

for (const work of [false, true]) {
  test(`work=${work}: opencode AGENTS.md is byte-identical to CLAUDE.md outside the Browser section`, () => {
    const claude = render('.claude/CLAUDE.md', work)
    const opencode = render('.config/opencode/AGENTS.md', work)
    assert.ok(claude.startsWith('# Global CLAUDE.md'), JSON.stringify(claude.slice(0, 40)))
    assert.notEqual(browser(opencode), browser(claude))
    assert.ok(opencode.replace(BROWSER, '').length > 1000, 'nothing left outside the Browser section')
    assert.equal(opencode.replace(BROWSER, ''), claude.replace(BROWSER, ''))
  })

  test(`work=${work}: opencode Browser section names Browser Control and no other agent's browser tool`, () => {
    const b = browser(render('.config/opencode/AGENTS.md', work))
    for (const t of OPENCODE_BROWSER) assert.ok(b.includes(t), `opencode Browser section lacks ${t}`)
    for (const t of CLAUDE_BROWSER) assert.ok(!b.includes(t), `opencode Browser section contains ${t}`)
    assert.ok(b.includes('Standing exception: while you follow the `navia-fsa-claims` skill'))
  })

  test(`work=${work}: Claude render has no opencode Browser text`, () => {
    const b = browser(render('.claude/CLAUDE.md', work))
    for (const t of ['Browser Control', 'opencode', 'Use only your own browser tool']) assert.ok(!b.includes(t), `Claude Browser section contains ${t}`)
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
  test(`work=${work}: apply writes ~/.config/opencode/AGENTS.md equal to ~/.claude/CLAUDE.md outside the Browser section and keeps the user's opencode files`, () => {
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
        assert.equal(body.replace(BROWSER, ''), readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8').replace(BROWSER, ''), `pass ${pass}: applied files differ`)
        assert.ok(browser(body).includes('Browser Control'), `pass ${pass}: applied file lacks Browser Control`)
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

test('opencode Browser Control script adds the plugin on darwin only, after checking the list', () => {
  const src = readFileSync(join(SOURCE, 'run_onchange_after_add-opencode-browser-control.sh.tmpl'), 'utf8')
  for (const os of ['darwin', 'linux']) {
    const home = mkdtempSync(join(tmpdir(), 'opencode-rules-'))
    try {
      const r = spawnSync(
        'chezmoi',
        ['--source', SOURCE, '--destination', home, '--override-data', JSON.stringify({ work: false, chezmoi: { os } }), 'execute-template'],
        { encoding: 'utf8', input: src, env: { PATH: process.env.PATH, HOME: home } },
      )
      assert.equal(r.status, 0, `chezmoi execute-template (${os}) exited ${r.status}: ${r.stderr}`)
      if (os !== 'darwin') {
        assert.equal(r.stdout.trim(), '', `script renders on ${os}`)
        continue
      }
      assert.ok(r.stdout.startsWith('#!/bin/bash\n'), JSON.stringify(r.stdout.slice(0, 40)))
      assert.ok(r.stdout.includes('set -uo pipefail'))
      const list = r.stdout.indexOf('plugin list')
      const add = r.stdout.indexOf('plugin add "$PLUGIN" || exit 1')
      assert.ok(list > 0 && add > list, 'script must check the plugin list before adding')
      assert.ok(r.stdout.includes('PLUGIN="@opencode-ai/browser-control"\n'), 'plugin name is not exact or carries a version pin')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
})
