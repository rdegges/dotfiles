// WorkOS on personal machines: run_onchange_after_add-workos-mcp.sh.tmpl
// registers the WorkOS MCP server at user scope, and dot_claude/CLAUDE.md.tmpl
// tells both agents to use WorkOS for auth in personal and side projects.
//
// Run from the repo root (chezmoi and bash are needed; without chezmoi every
// test FAILS, it does not skip):
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin && node --test tests/claude/'
//
// What a pass proves: the script renders only for darwin + work=false; the
// rendered script, run by bash against a stub `claude` in a throwaway HOME,
// adds the server with the exact `claude mcp add` arguments when it is absent,
// does nothing when `claude mcp get` shows it (fixture copied from the real
// CLI, 2.1.296), replaces a stale user-scope entry, leaves other scopes alone,
// and exits non-zero on every failure; a real `chezmoi apply` runs it after
// run_once_install-claude-code and does not re-run it on a second apply. The
// CLAUDE.md checks prove the WorkOS bullet renders in both targets, and the
// MCP sentence (a Claude-only tool) only in the work=false Claude render. It
// says nothing about the real `claude mcp add`, the WorkOS server, or OAuth;
// those were checked by hand on the personal Mac.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SOURCE = new URL('../../', import.meta.url).pathname
const TEMPLATE = 'run_onchange_after_add-workos-mcp.sh.tmpl'
const URL_ = 'https://mcp.workos.com/mcp'
const ADD = `mcp add --scope user --transport http workos ${URL_}`

function execTemplate(data) {
  const home = mkdtempSync(join(tmpdir(), 'workos-mcp-'))
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
  ['darwin', true, false],
  ['linux', false, false],
  ['linux', true, false],
]) {
  test(`script renders ${renders ? 'a bash script' : 'empty (chezmoi skips it)'} for os=${os} work=${work}`, () => {
    const out = execTemplate({ work, chezmoi: { os } })
    if (renders) {
      assert.ok(out.startsWith('#!/bin/bash\n'), JSON.stringify(out.slice(0, 40)))
      assert.ok(out.includes(ADD.replace(URL_, '"$URL"').replace('mcp add', '"$CLAUDE" mcp add')))
      assert.doesNotMatch(out, /\{\{|\}\}|<no value>/)
    } else {
      // chezmoi skips a script that renders to only whitespace.
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

// --- script behavior against a stub `claude` ---------------------------------

// Output of `claude mcp get workos` from the real CLI (2.1.296) on the personal
// Mac after the script registered the server.
const REAL_USER_ENTRY = `workos:
  Scope: User config (available in all your projects)
  Status: ! Needs authentication
  Type: http
  URL: https://mcp.workos.com/mcp

To remove this server, run: claude mcp remove workos -s user
`

const entry = (scope, url, type = 'http') =>
  `workos:\n  Scope: ${scope}\n  Status: ! Needs authentication\n  Type: ${type}\n  URL: ${url}\n\n`
const USER = 'User config (available in all your projects)'
const LOCAL = 'Local config (private to you in this project)'
const PROJECT = 'Project config (shared via .mcp.json)'

// A stateful stand-in for the CLI: $STATE holds what `mcp get workos` prints
// (absent = not registered); add writes a user-scope entry, remove deletes it.
// STUB_*_RC force a failure exit for one subcommand.
const STUB = `#!/bin/bash
echo "$*" >> "$CALLS"
case "$1 $2" in
  "mcp get")
    if [ -n "\${STUB_GET_RC:-}" ]; then echo "get broke" >&2; exit "$STUB_GET_RC"; fi
    if [ -f "$STATE" ]; then cat "$STATE"; exit 0; fi
    echo "No MCP server named \\"$3\\". Configured servers: railway" >&2; exit 1 ;;
  "mcp remove")
    if [ -n "\${STUB_REMOVE_RC:-}" ]; then echo "remove broke" >&2; exit "$STUB_REMOVE_RC"; fi
    rm -f "$STATE"; echo "Removed MCP server $*" ;;
  "mcp add")
    if [ -n "\${STUB_ADD_RC:-}" ]; then echo "add broke" >&2; exit "$STUB_ADD_RC"; fi
    printf 'workos:\\n  Scope: ${USER}\\n  Status: ! Needs authentication\\n  Type: http\\n  URL: %s\\n\\n' "\${@: -1}" > "$STATE"
    echo "Added HTTP MCP server workos" ;;
  *) echo "unexpected: $*" >&2; exit 99 ;;
esac
`

function sandbox({ claude = true, homeName = 'home' } = {}) {
  assert.ok(SCRIPT_TEXT, 'the script did not render for darwin + work=false')
  const base = mkdtempSync(join(tmpdir(), 'workos-mcp-'))
  const home = join(base, homeName)
  const bin = join(home, '.local/bin')
  mkdirSync(bin, { recursive: true })
  const script = join(base, 'add-workos-mcp.sh')
  writeFileSync(script, SCRIPT_TEXT)
  if (claude) {
    writeFileSync(join(bin, 'claude'), STUB)
    chmodSync(join(bin, 'claude'), 0o755)
  }
  const calls = join(base, 'calls')
  const state = join(base, 'state')
  writeFileSync(calls, '')
  return {
    home,
    setEntry: (text) => writeFileSync(state, text),
    entry: () => (existsSync(state) ? readFileSync(state, 'utf8') : null),
    calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    clearCalls: () => writeFileSync(calls, ''),
    // System PATH only: no real `claude` can answer in place of the stub.
    run: (env = {}) =>
      spawnSync('bash', [script], {
        encoding: 'utf8',
        cwd: home,
        env: { HOME: home, PATH: '/usr/bin:/bin', CALLS: calls, STATE: state, ...env },
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

test('not registered: adds the server at user scope with the exact arguments, exit 0', () =>
  withSandbox({}, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), ['mcp get workos', ADD])
    assert.match(r.stdout, /^workos-mcp: registered; run \/mcp in Claude Code to sign in$/m)
  }))

test('already registered (real CLI output): no remove, no add, exit 0', () =>
  withSandbox({}, (sb) => {
    sb.setEntry(REAL_USER_ENTRY)
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), ['mcp get workos'])
    assert.equal(r.stdout, 'workos-mcp: already registered\n')
    assert.equal(sb.entry(), REAL_USER_ENTRY)
  }))

test('idempotent: a second run after a first registration changes nothing', () =>
  withSandbox({}, (sb) => {
    assert.equal(sb.run().status, 0)
    const after1 = sb.entry()
    assert.ok(after1.includes(`URL: ${URL_}\n`))
    sb.clearCalls()
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), ['mcp get workos'])
    assert.equal(sb.entry(), after1)
  }))

test('stale user-scope entry (other URL): removes it at user scope, then adds', () =>
  withSandbox({}, (sb) => {
    sb.setEntry(entry(USER, 'https://old.example.com/mcp'))
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), ['mcp get workos', 'mcp remove --scope user workos', ADD])
    assert.ok(sb.entry().includes(`URL: ${URL_}\n`))
  }))

// The script's own comment: "A user-scope `workos` entry with another URL is
// stale; replace it." A URL that merely starts with the right one is another
// URL. grep -qF matches it as a substring, so the stale entry stays.
for (const other of [`${URL_}/v2`, `${URL_}-beta`, `${URL_}?team=old`]) {
  test(`stale user-scope entry whose URL only starts with ${URL_} (${other}) is replaced`, () =>
    withSandbox({}, (sb) => {
      sb.setEntry(entry(USER, other))
      const r = sb.run()
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.deepEqual(sb.calls(), ['mcp get workos', 'mcp remove --scope user workos', ADD])
    }))
}

for (const scope of [LOCAL, PROJECT]) {
  test(`${scope.split(' ')[0]}-scope entry with another URL: left alone, user scope still added`, () =>
    withSandbox({}, (sb) => {
      sb.setEntry(entry(scope, 'https://old.example.com/mcp'))
      const r = sb.run()
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.deepEqual(sb.calls(), ['mcp get workos', ADD])
      assert.ok(!sb.calls().some((c) => c.startsWith('mcp remove')), 'removed an entry outside user scope')
    }))

  // Proposal, not an agreed contract: the script's goal is a user-scope entry
  // usable "from any project", but a local or project entry with the same URL
  // (what `mcp get` shows first) makes it report "already registered" and skip
  // the user scope. chezmoi runs the script with cwd=$HOME, so a local entry
  // for $HOME is enough. Fixing it means asking for the user scope directly.
  test(`PROPOSED CONTRACT: ${scope.split(' ')[0]}-scope entry with the right URL still gets a user-scope entry`, { todo: true }, () =>
    withSandbox({}, (sb) => {
      sb.setEntry(entry(scope, URL_))
      sb.run()
      assert.ok(sb.calls().includes(ADD), `calls: ${JSON.stringify(sb.calls())}`)
    }))
}

test('no claude at ~/.local/bin/claude: exit 1 with a fix hint, nothing runs', () =>
  withSandbox({ claude: false }, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stderr, /workos-mcp: .*\/\.local\/bin\/claude not found; install Claude Code, then re-run chezmoi apply/)
    assert.deepEqual(sb.calls(), [])
  }))

test('a claude on PATH does not stand in for ~/.local/bin/claude', () =>
  withSandbox({ claude: false }, (sb) => {
    const bin = join(sb.home, 'elsewhere')
    mkdirSync(bin)
    writeFileSync(join(bin, 'claude'), STUB)
    chmodSync(join(bin, 'claude'), 0o755)
    const r = sb.run({ PATH: `${bin}:/usr/bin:/bin` })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), [])
  }))

test('`mcp get` fails for another reason: falls through to add (and add decides)', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({ STUB_GET_RC: '2' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), ['mcp get workos', ADD])
  }))

test('remove fails: exit non-zero, no add, stale entry untouched', () =>
  withSandbox({}, (sb) => {
    const stale = entry(USER, 'https://old.example.com/mcp')
    sb.setEntry(stale)
    const r = sb.run({ STUB_REMOVE_RC: '3' })
    assert.notEqual(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), ['mcp get workos', 'mcp remove --scope user workos'])
    assert.equal(sb.entry(), stale)
    assert.doesNotMatch(r.stdout, /registered/)
  }))

test('add fails: exit non-zero and no "registered" message', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({ STUB_ADD_RC: '4' })
    assert.notEqual(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), ['mcp get workos', ADD])
    assert.doesNotMatch(r.stdout, /registered/)
    assert.equal(sb.entry(), null)
  }))

test('a HOME with spaces and unicode still finds and runs claude', () =>
  withSandbox({ homeName: 'Ran dall — ü' }, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), ['mcp get workos', ADD])
  }))

// --- real chezmoi apply: ordering and run_onchange ---------------------------

// A source tree with the real WorkOS template and a stand-in for
// run_once_install-claude-code (the real one curls the installer). The
// stand-in drops the stub at ~/.local/bin/claude, so the WorkOS script only
// passes if chezmoi runs it after the install script.
test('chezmoi apply runs the script after install-claude-code, and only once while it is unchanged', () => {
  const base = mkdtempSync(join(tmpdir(), 'workos-mcp-'))
  try {
    const src = join(base, 'src')
    const home = join(base, 'home')
    mkdirSync(src)
    mkdirSync(home)
    cpSync(join(SOURCE, TEMPLATE), join(src, TEMPLATE))
    writeFileSync(join(base, 'stub'), STUB)
    writeFileSync(
      join(src, 'run_once_install-claude-code.sh.tmpl'),
      `#!/bin/bash\nset -eu\nmkdir -p "$HOME/.local/bin"\ncp "${join(base, 'stub')}" "$HOME/.local/bin/claude"\nchmod 755 "$HOME/.local/bin/claude"\n`,
    )
    const calls = join(base, 'calls')
    const state = join(base, 'state')
    writeFileSync(calls, '')
    const apply = () =>
      spawnSync(
        'chezmoi',
        ['--source', src, '--destination', home, '--override-data', JSON.stringify({ work: false, chezmoi: { os: 'darwin' } }), '--no-tty', 'apply', '--force'],
        { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, CALLS: calls, STATE: state } },
      )
    const r1 = apply()
    assert.ifError(r1.error)
    assert.equal(r1.status, 0, `apply 1 exited ${r1.status}: ${r1.stdout}${r1.stderr}`)
    assert.deepEqual(readFileSync(calls, 'utf8').split('\n').filter(Boolean), ['mcp get workos', ADD])
    const r2 = apply()
    assert.equal(r2.status, 0, `apply 2 exited ${r2.status}: ${r2.stdout}${r2.stderr}`)
    assert.deepEqual(readFileSync(calls, 'utf8').split('\n').filter(Boolean), ['mcp get workos', ADD], 'apply 2 re-ran the script')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// --- CLAUDE.md: the WorkOS auth rule -----------------------------------------

function render(target, work) {
  const home = mkdtempSync(join(tmpdir(), 'workos-mcp-'))
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

const AUTH = '- Auth in my personal and side projects: WorkOS (AuthKit), unless the project already uses something else. '
const MCP = 'Manage my WorkOS teams through the `workos` MCP server (`mcp__workos__*`); if it is not signed in, ask me to run `/mcp`. '
const CLI = 'For app setup, ask me to run `npx workos@latest install` in the project; it is interactive and signs in through the browser, so never run it yourself.\n'

for (const work of [false, true]) {
  for (const [target, reader] of [['.claude/CLAUDE.md', 'claude'], ['.codex/AGENTS.md', 'codex']]) {
    const expected = AUTH + (reader === 'claude' && !work ? MCP : '') + CLI
    test(`work=${work} ${reader}: WorkOS bullet renders exactly once, ${expected.includes(MCP) ? 'with' : 'without'} the MCP sentence, in Environment`, () => {
      const t = render(target, work)
      const lines = t.split('\n').filter((l) => l.includes('WorkOS'))
      assert.deepEqual(lines, [expected.trimEnd()])
      const env = t.match(/^## Environment\n\n([\s\S]*?)\n### /m)
      assert.ok(env, 'no Environment section')
      assert.ok(env[1].includes(expected), 'WorkOS bullet is not in Environment')
      assert.ok(t.includes('`cf auth login`; never run it yourself.\n' + expected), 'WorkOS bullet moved away from the Cloudflare bullet')
    })
  }
}
