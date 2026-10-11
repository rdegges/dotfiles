// opencode Browser Control: run_onchange_after_add-opencode-browser-control.sh.tmpl
// installs the plugin with `opencode plugin`, and dot_claude/CLAUDE.md.tmpl
// renders a per-agent ### Browser section for Claude, Codex, and opencode.
//
// Run from the repo root (chezmoi and bash are needed; without chezmoi every
// test FAILS, it does not skip):
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin && node --test tests/claude/'
//
// What a pass proves: the script renders for darwin (work=false and true) and
// is empty elsewhere; the rendered script, run by bash against a stub
// `opencode` on PATH in a throwaway HOME, adds the plugin with the exact
// arguments when `plugin list` lacks it, skips the add when the list shows it
// (list format taken from opencode v2.0.25 packages/cli/src/commands/handlers/
// plugin/list.ts), and exits non-zero with a message when opencode is missing
// or either subcommand fails; a real `chezmoi apply` runs it after
// run_onchange_install-packages and does not re-run it while unchanged. The
// render checks prove each target's Browser section is a clean bullet list
// with its own tool and no other agent's, and no template syntax leaks.
// It says nothing about the real opencode CLI or whether the published npm
// package is an opencode plugin; see the tester report for that check.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SOURCE = new URL('../../', import.meta.url).pathname
const TEMPLATE = 'run_onchange_after_add-opencode-browser-control.sh.tmpl'
const PLUGIN = '@opencode-ai/browser-control'
const ADD = `plugin add ${PLUGIN}`

function execTemplate(data) {
  const home = mkdtempSync(join(tmpdir(), 'opencode-bc-'))
  try {
    const r = spawnSync(
      'chezmoi',
      ['--source', SOURCE, '--destination', home, '--override-data', JSON.stringify(data), 'execute-template'],
      { encoding: 'utf8', input: readFileSync(join(SOURCE, TEMPLATE), 'utf8'), env: { PATH: process.env.PATH, HOME: home } },
    )
    assert.ifError(r.error)
    assert.equal(r.status, 0, `chezmoi execute-template ${JSON.stringify(data)} exited ${r.status}: ${r.stderr}`)
    return r.stdout
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

// --- template gating ---------------------------------------------------------

for (const [os, work, renders] of [
  ['darwin', false, true],
  ['darwin', true, true],
  ['linux', false, false],
  ['linux', true, false],
]) {
  test(`script renders ${renders ? 'a bash script' : 'empty (chezmoi skips it)'} for os=${os} work=${work}`, () => {
    const out = execTemplate({ work, chezmoi: { os } })
    if (renders) {
      assert.ok(out.startsWith('#!/bin/bash\n'), JSON.stringify(out.slice(0, 40)))
      assert.doesNotMatch(out, /\{\{|\}\}|<no value>/)
    } else {
      assert.equal(out.trim(), '', JSON.stringify(out))
    }
  })
}

const SCRIPT_TEXT = (() => {
  try {
    return execTemplate({ work: false, chezmoi: { os: 'darwin' } })
  } catch {
    return null
  }
})()

// --- script behavior against a stub `opencode` -------------------------------

// `opencode plugin list` output shape from v2.0.25 list.ts: an ID/VERSION/SOURCE
// table, or "No plugins found". SOURCE is the configured package target.
const table = (...rows) =>
  ['ID                VERSION  SOURCE', ...rows.map(([id, v, src]) => `${id.padEnd(16)}  ${v.padEnd(7)}  ${src}`)].join('\n') + '\n'
const INSTALLED = table(['browser-control', '0.8.4', PLUGIN])

// Stateful stand-in: $STATE holds what `plugin list` prints (absent = "No
// plugins found"); add writes a row for its argument. STUB_*_RC force a failure.
const STUB = `#!/bin/bash
echo "$*" >> "$CALLS"
case "$1 $2" in
  "plugin list")
    if [ -n "\${STUB_LIST_RC:-}" ]; then echo "list broke: server unreachable"; exit "$STUB_LIST_RC"; fi
    if [ -f "$STATE" ]; then cat "$STATE"; else echo "No plugins found"; fi ;;
  "plugin add")
    if [ -n "\${STUB_ADD_RC:-}" ]; then echo "add broke" >&2; exit "$STUB_ADD_RC"; fi
    printf 'ID                VERSION  SOURCE\\nbrowser-control   0.8.4    %s\\n' "$3" > "$STATE"
    echo "Plugin \\"$3\\" installed and added to $HOME/.config/opencode/opencode.json" ;;
  *) echo "unexpected: $*" >&2; exit 99 ;;
esac
`

function sandbox({ opencode = true } = {}) {
  assert.ok(SCRIPT_TEXT, 'the script did not render for darwin')
  const base = mkdtempSync(join(tmpdir(), 'opencode-bc-'))
  const home = join(base, 'home')
  const bin = join(base, 'bin')
  mkdirSync(home)
  mkdirSync(bin)
  const script = join(base, 'add-opencode-browser-control.sh')
  writeFileSync(script, SCRIPT_TEXT)
  if (opencode) {
    writeFileSync(join(bin, 'opencode'), STUB)
    chmodSync(join(bin, 'opencode'), 0o755)
  }
  const calls = join(base, 'calls')
  const state = join(base, 'state')
  writeFileSync(calls, '')
  return {
    setList: (text) => writeFileSync(state, text),
    list: () => readFileSync(state, 'utf8'),
    calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    clearCalls: () => writeFileSync(calls, ''),
    // Stub bin plus system PATH only: no real `opencode` can answer for the stub.
    run: (env = {}) =>
      spawnSync('bash', [script], {
        encoding: 'utf8',
        cwd: home,
        env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, CALLS: calls, STATE: state, ...env },
      }),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

function withSandbox(opts, fn) {
  const sb = sandbox(opts)
  try {
    return fn(sb)
  } finally {
    sb.cleanup()
  }
}

test('no plugins: lists, then adds the exact package with no version pin, exit 0', () =>
  withSandbox({}, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), ['plugin list', ADD])
    assert.match(r.stdout, /^opencode-browser-control: installed; ask @browser in opencode to finish the extension setup$/m)
  }))

test('other plugins only: still adds Browser Control', () =>
  withSandbox({}, (sb) => {
    sb.setList(table(['notify', '1.2.0', 'opencode-notify'], ['-', 'local', '/Users/me/.config/opencode/plugins/mine']))
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), ['plugin list', ADD])
  }))

test('already in the list: no add, exit 0', () =>
  withSandbox({}, (sb) => {
    sb.setList(INSTALLED)
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), ['plugin list'])
    assert.equal(r.stdout, 'opencode-browser-control: already installed\n')
    assert.equal(sb.list(), INSTALLED)
  }))

test('a version-pinned entry counts as installed (no second, unpinned add)', () =>
  withSandbox({}, (sb) => {
    sb.setList(table(['browser-control', '0.8.4', `${PLUGIN}@0.8.4`]))
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), ['plugin list'])
  }))

test('idempotent: a second run after the first add changes nothing', () =>
  withSandbox({}, (sb) => {
    assert.equal(sb.run().status, 0)
    const after1 = sb.list()
    sb.clearCalls()
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), ['plugin list'])
    assert.equal(sb.list(), after1)
  }))

test('opencode not on PATH: exit 1 with a fix-it message, nothing called', () =>
  withSandbox({ opencode: false }, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), [])
    assert.match(r.stderr, /^opencode-browser-control: opencode not found; install it, then re-run chezmoi apply$/m)
    assert.equal(r.stdout, '')
  }))

test('plugin list fails: exit 1, no add, and the list output is shown on stderr', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({ STUB_LIST_RC: '3' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), ['plugin list'])
    assert.match(r.stderr, /opencode-browser-control: opencode plugin list failed: list broke: server unreachable/)
  }))

test('plugin add fails: non-zero exit and no success line', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({ STUB_ADD_RC: '4' })
    assert.notEqual(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), ['plugin list', ADD])
    assert.doesNotMatch(r.stdout, /installed/)
  }))

// The check is a substring match (grep -qF), so any SOURCE that merely contains
// the package name reads as installed. Upstream's own `plugin add` is already
// idempotent (add.ts: "is already configured"), so the list gate is not needed.
test('a different package whose name contains this one is not treated as installed', { todo: 'grep -qF substring match; see tester report' }, () =>
  withSandbox({}, (sb) => {
    sb.setList(table(['bc-fork', '0.1.0', `${PLUGIN}-fork`]))
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), ['plugin list', ADD])
  }))

// --- real chezmoi apply: ordering and run_onchange ---------------------------

// A source tree with the real template and a stand-in for
// run_onchange_install-packages (the real one runs brew bundle, which installs
// opencode). The stand-in drops the stub into a PATH dir, so the script only
// passes if chezmoi runs it after the install script.
test('chezmoi apply runs the script after install-packages, and only once while it is unchanged', () => {
  const base = mkdtempSync(join(tmpdir(), 'opencode-bc-'))
  try {
    const src = join(base, 'src')
    const home = join(base, 'home')
    const bin = join(base, 'bin')
    for (const d of [src, home, bin]) mkdirSync(d)
    cpSync(join(SOURCE, TEMPLATE), join(src, TEMPLATE))
    writeFileSync(join(base, 'stub'), STUB)
    writeFileSync(
      join(src, 'run_onchange_install-packages.sh.tmpl'),
      `#!/bin/bash\nset -eu\ncp "${join(base, 'stub')}" "${join(bin, 'opencode')}"\nchmod 755 "${join(bin, 'opencode')}"\n`,
    )
    const calls = join(base, 'calls')
    writeFileSync(calls, '')
    const apply = () =>
      spawnSync(
        'chezmoi',
        ['--source', src, '--destination', home, '--override-data', JSON.stringify({ work: false, chezmoi: { os: 'darwin' } }), '--no-tty', 'apply', '--force'],
        { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, CALLS: calls, STATE: join(base, 'state') } },
      )
    const r1 = apply()
    assert.ifError(r1.error)
    assert.equal(r1.status, 0, `apply 1 exited ${r1.status}: ${r1.stdout}${r1.stderr}`)
    assert.deepEqual(readFileSync(calls, 'utf8').split('\n').filter(Boolean), ['plugin list', ADD])
    const r2 = apply()
    assert.equal(r2.status, 0, `apply 2 exited ${r2.status}: ${r2.stdout}${r2.stderr}`)
    assert.deepEqual(readFileSync(calls, 'utf8').split('\n').filter(Boolean), ['plugin list', ADD], 'apply 2 re-ran the script')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// --- rules renders: the per-agent Browser section ----------------------------

function render(target, work) {
  const home = mkdtempSync(join(tmpdir(), 'opencode-bc-'))
  try {
    const r = spawnSync(
      'chezmoi',
      ['--source', SOURCE, '--destination', home, '--override-data', JSON.stringify({ work }), 'cat', join(home, target)],
      { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } },
    )
    assert.ifError(r.error)
    assert.equal(r.status, 0, `chezmoi cat ${target} (work=${work}) exited ${r.status}: ${r.stderr}`)
    return r.stdout
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function browserSection(text) {
  const m = text.match(/^### Browser\n([\s\S]*?)(?=^### )/m)
  assert.ok(m, 'no ### Browser section')
  return m[1]
}

// Each render's own tool, and the tools it must never name.
const TARGETS = {
  '.claude/CLAUDE.md': { bullets: 5, own: 'Claude in Chrome (`mcp__claude-in-chrome__*`', foreign: ['Browser Control', '@opencode-ai', 'opencode plugin', 'Codex Chrome plugin', 'Use only your own browser tool'] },
  '.codex/AGENTS.md': { bullets: 6, own: 'the Codex Chrome plugin (`chrome`', foreign: ['Browser Control', '@opencode-ai', 'opencode plugin', 'claude-in-chrome', 'Claude in Chrome', 'switch_browser'] },
  '.config/opencode/AGENTS.md': { bullets: 6, own: 'Browser Control (the `browser` skill', foreign: ['claude-in-chrome', 'Claude in Chrome', 'Codex Chrome plugin', 'ChatGPT', 'switch_browser', 'Computer Use'] },
}

for (const work of [false, true]) {
  for (const [target, { bullets, own, foreign }] of Object.entries(TARGETS)) {
    test(`work=${work}: ${target} Browser section is ${bullets} clean bullets naming only its own tool`, () => {
      const text = render(target, work)
      assert.doesNotMatch(text, /\{\{|\}\}|\$codex|\$opencode|<no value>/)
      const body = browserSection(text)
      // One blank line after the heading, one before the next heading, and every
      // line in between a bullet: a mis-trimmed {{- if }} would merge or split them.
      assert.ok(body.startsWith('\n') && body.endsWith('\n\n'), JSON.stringify(body.slice(0, 20)))
      const lines = body.slice(1, -2).split('\n')
      assert.equal(lines.length, bullets, lines.join('\n'))
      for (const l of lines) assert.match(l, /^- \S/, `not a bullet: ${JSON.stringify(l.slice(0, 60))}`)
      assert.ok(body.includes(own), `lacks its own tool: ${own}`)
      for (const t of foreign) assert.ok(!body.includes(t), `names ${t}`)
    })
  }

  // The new bullet sits between "Several browsers" and "When a connector".
  test(`work=${work}: Codex and opencode put the own-tool rule right after the browser-choice bullet`, () => {
    for (const target of ['.codex/AGENTS.md', '.config/opencode/AGENTS.md']) {
      const lines = browserSection(render(target, work)).trim().split('\n')
      const i = lines.findIndex((l) => l.startsWith('- Several browsers connected'))
      assert.ok(i >= 0, target)
      assert.equal(lines[i + 1], "- Use only your own browser tool. When a skill or rule names another agent's browser tool, use yours in its place.", target)
      assert.ok(lines[i + 2].startsWith('- When a connector is missing'), target)
    }
  })
}
