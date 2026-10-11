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
// Claude Code read the same rules except for browsers. opencode has no browser
// tool, so its Browser section is exactly the two hand-back bullets and names
// no browser tool at all.
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

// Every browser tool any agent has, plus Claude-only Browser text.
const FORBIDDEN = ['mcp__claude-in-chrome', 'claude-in-chrome', 'Claude in Chrome', 'switch_browser', '/chrome', 'claude.ai', 'tester.md', 'codex-computer-use', 'Codex Chrome plugin', 'ChatGPT', 'Browser Control', 'browser-control', '@browser']
const OPENCODE_BROWSER = `### Browser

- You have no browser tool. For a browser task, or when a skill or rule tells you to use a browser tool, tell me the task needs a browser and stop. Never use headless Chrome, Playwright, Puppeteer, \`curl\` scraping, or another agent's browser tool.
- Reading a public page with web search or web fetch is not a browser task.

`

for (const work of [false, true]) {
  test(`work=${work}: opencode AGENTS.md is byte-identical to CLAUDE.md outside the Browser section`, () => {
    const claude = render('.claude/CLAUDE.md', work)
    const opencode = render('.config/opencode/AGENTS.md', work)
    assert.ok(claude.startsWith('# Global CLAUDE.md'), JSON.stringify(claude.slice(0, 40)))
    assert.notEqual(browser(opencode), browser(claude))
    assert.ok(opencode.replace(BROWSER, '').length > 1000, 'nothing left outside the Browser section')
    assert.equal(opencode.replace(BROWSER, ''), claude.replace(BROWSER, ''))
  })

  test(`work=${work}: opencode Browser section is exactly the two hand-back bullets`, () => {
    const b = browser(render('.config/opencode/AGENTS.md', work))
    assert.equal(b, OPENCODE_BROWSER)
    for (const t of FORBIDDEN) assert.ok(!b.includes(t), `opencode Browser section contains ${t}`)
  })

  test(`work=${work}: Claude render has no opencode Browser text`, () => {
    const b = browser(render('.claude/CLAUDE.md', work))
    for (const t of ['opencode', 'You have no browser tool', 'Use only your own browser tool']) assert.ok(!b.includes(t), `Claude Browser section contains ${t}`)
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
        assert.equal(browser(body), OPENCODE_BROWSER, `pass ${pass}: applied Browser section is not the hand-back text`)
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

// Tester additions (agent-native-browsers). The checks above pin the opencode
// render; these pin that each reader's Browser text stays in its own target
// (Codex and the whole Claude render, not only its Browser section), that a
// `reader` key in machine data cannot flip a target to another reader, that
// one real apply renders all three readers side by side, and that opencode is
// never also told the opposite rule (do not stop, do not hand back).
const OPENCODE_BULLET = '- You have no browser tool.'
const CODEX_BULLET = "- Use only your own browser tool. When a skill or rule names another agent's browser tool, use yours in its place.\n"
const NO_HANDBACK = 'Do not stop and do not hand the task back to me.'

function renderData(target, data) {
  const home = mkdtempSync(join(tmpdir(), 'opencode-rules-'))
  try {
    const r = spawnSync(
      'chezmoi',
      ['--source', SOURCE, '--destination', home, '--override-data', JSON.stringify(data), 'cat', join(home, target)],
      { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } },
    )
    assert.ifError(r.error)
    assert.equal(r.status, 0, `chezmoi cat ${target} (${JSON.stringify(data)}) exited ${r.status}: ${r.stderr}`)
    assert.ok(r.stdout.length > 0, `chezmoi cat ${target} printed nothing`)
    return r.stdout
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

for (const work of [false, true]) {
  test(`work=${work}: no opencode Browser text anywhere in the Claude or Codex render`, () => {
    for (const target of ['.claude/CLAUDE.md', '.codex/AGENTS.md']) {
      const text = render(target, work)
      for (const t of [OPENCODE_BULLET, 'tell me the task needs a browser and stop', 'web search or web fetch']) {
        assert.ok(!text.includes(t), `${target} contains ${JSON.stringify(t)}`)
      }
    }
  })

  test(`work=${work}: opencode is told to hand browser tasks back exactly once and never told not to`, () => {
    const oc = render('.config/opencode/AGENTS.md', work)
    assert.equal(oc.split('tell me the task needs a browser and stop').length, 2)
    assert.ok(!oc.includes(NO_HANDBACK), 'opencode render also says do not hand the task back')
    assert.ok(!oc.includes(CODEX_BULLET), 'opencode render carries the Codex own-tool bullet')
    // The Claude and Codex renders keep their own no-hand-back rule.
    assert.ok(render('.claude/CLAUDE.md', work).includes(NO_HANDBACK), 'Claude render lost the no-hand-back rule')
    assert.ok(render('.codex/AGENTS.md', work).includes(NO_HANDBACK), 'Codex render lost the no-hand-back rule')
  })

  // merge (dict "reader" ...) . gives the target's own reader precedence over
  // machine data. Swapping the merge arguments would let a stray `reader` key
  // in chezmoi data turn opencode's file into Codex's (or the reverse).
  for (const reader of ['codex', 'opencode', 'claude']) {
    test(`work=${work}: a reader=${reader} key in machine data does not change the opencode or Codex target`, () => {
      const oc = renderData('.config/opencode/AGENTS.md', { work, reader })
      assert.ok(oc.startsWith('# Global CLAUDE.md'), JSON.stringify(oc.slice(0, 40)))
      assert.equal(browser(oc), OPENCODE_BROWSER)
      const cx = renderData('.codex/AGENTS.md', { work, reader })
      assert.ok(cx.startsWith('# Global AGENTS.md'), JSON.stringify(cx.slice(0, 40)))
      assert.ok(browser(cx).includes(CODEX_BULLET), 'Codex Browser section lacks its own-tool bullet')
      assert.ok(!cx.includes(OPENCODE_BULLET), 'Codex render carries opencode text')
    })
  }

  test(`work=${work}: one apply writes each reader's own Browser section to its own file`, () => {
    applied(
      work,
      () => {},
      (home, pass) => {
        const cl = browser(readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8'))
        const cx = browser(readFileSync(join(home, '.codex/AGENTS.md'), 'utf8'))
        const oc = browser(readFileSync(join(home, OPENCODE_DIR, 'AGENTS.md'), 'utf8'))
        assert.ok(cl.includes('Claude in Chrome (`mcp__claude-in-chrome__*`'), `pass ${pass}: Claude Browser section lost Claude in Chrome`)
        assert.ok(!cl.includes(OPENCODE_BULLET) && !cl.includes(CODEX_BULLET), `pass ${pass}: Claude Browser section has another reader's text`)
        assert.ok(cx.includes('the Codex Chrome plugin (`chrome`') && cx.includes(CODEX_BULLET), `pass ${pass}: Codex Browser section is not Codex's`)
        assert.ok(!cx.includes(OPENCODE_BULLET), `pass ${pass}: Codex Browser section has opencode text`)
        assert.equal(oc, OPENCODE_BROWSER, `pass ${pass}: opencode Browser section is not the hand-back text`)
      },
    )
  })
}
