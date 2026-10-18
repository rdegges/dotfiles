// Parallel Search MCP on personal machines: run_onchange_after_setup-parallel-mcp.sh.tmpl
// registers it for Claude Code and opencode, and dot_codex/config.toml.tmpl
// carries the Codex entry.
//
// Run from the repo root (chezmoi and bash are needed; without chezmoi every
// test FAILS, it does not skip):
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin && node --test tests/claude/'
//
// What a pass proves: the script renders only for darwin + work=false and the
// Codex entry only for work=false (work=true renders no parallel table); the
// rendered script, run by bash against stub `op`, `claude`, and `opencode`
// CLIs in a throwaway HOME, fetches the key from 1Password only when the key
// file is missing and writes it 0600, stops before any registration when `op`
// fails, passes the ${PARALLEL_API_KEY} / {file:...} references (never the
// key) to each CLI with the exact arguments, skips the Claude add when URL and
// header already match, replaces a stale user-scope Claude entry, and exits
// non-zero when either CLI is missing or fails, while still trying the other.
// dot_zshenv exports the file as PARALLEL_API_KEY and is silent without it
// (under bash always, under zsh when zsh is installed). A real `chezmoi apply`
// runs the script after run_once_install-claude-code and not again while it is
// unchanged. The claude stub models user vs local scope the way Claude Code
// 2.1.302 does; the `mcp get` fixture is verbatim from it. It says nothing
// about the Parallel server, and the stubs only stand in for the real CLIs
// (Claude Code 2.1.302, Homebrew opencode 2.0.32, and Codex 0.163.0 were run
// against these arguments and the rendered config in Docker by the tester).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SOURCE = new URL('../../', import.meta.url).pathname
const TEMPLATE = 'run_onchange_after_setup-parallel-mcp.sh.tmpl'
const URL_ = 'https://search.parallel.ai/mcp'
const HEADER = 'Authorization: Bearer ${PARALLEL_API_KEY}'
const CLAUDE_ADD = `claude mcp add --scope user --transport http parallel ${URL_} --header ${HEADER}`
const OPENCODE_ADD = `opencode mcp add --global --url ${URL_} --header Authorization=Bearer {file:~/.config/parallel/api-key} parallel`
const KEY = 'pk_test_secret'
const OP_READ = 'op read op://Private/Parallel/credential'

function chezmoi(args, data, input) {
  const home = mkdtempSync(join(tmpdir(), 'parallel-mcp-'))
  try {
    const r = spawnSync(
      'chezmoi',
      ['--source', SOURCE, '--destination', home, '--override-data', JSON.stringify(data), ...args(home)],
      { encoding: 'utf8', input, env: { PATH: process.env.PATH, HOME: home } },
    )
    assert.ifError(r.error)
    assert.equal(r.status, 0, `chezmoi ${args(home).join(' ')} ${JSON.stringify(data)} exited ${r.status}: ${r.stderr}`)
    return r.stdout
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

const execTemplate = (data) => chezmoi(() => ['execute-template'], data, readFileSync(join(SOURCE, TEMPLATE), 'utf8'))

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
      assert.doesNotMatch(out, /\{\{|\}\}|<no value>/)
    } else {
      assert.equal(out.trim(), '', JSON.stringify(out))
    }
  })
}

const CODEX_ENTRY = `[mcp_servers.parallel]\nurl = "${URL_}"\nbearer_token_env_var = "PARALLEL_API_KEY"\n`

for (const work of [false, true]) {
  test(`codex config ${work ? 'omits' : 'has'} the parallel entry for work=${work}`, () => {
    const t = chezmoi((home) => ['cat', join(home, '.codex/config.toml')], { work })
    assert.equal(t.includes(CODEX_ENTRY), !work, t)
    assert.equal(t.includes('[mcp_servers.parallel]'), !work)
    assert.ok(!t.includes(KEY))
    // The rea entry above it must survive the new block.
    assert.match(t, /\[mcp_servers\.rea\]\ncommand = ".*\/bin\/rea"\nargs = \[ "mcp" \]\nstartup_timeout_sec = 30\n/)
  })
}

// --- script behavior against stub CLIs ---------------------------------------

const SCRIPT_TEXT = (() => {
  try {
    return execTemplate({ work: false, chezmoi: { os: 'darwin' } })
  } catch {
    return null
  }
})()

const USER = 'User config (available in all your projects)'
const LOCAL = 'Local config (private to you in this project)'
const entry = (scope, url, header = HEADER) =>
  `parallel:\n  Scope: ${scope}\n  Status: ✔ Connected\n  Type: http\n  URL: ${url}\n  Headers:\n    ${header}\n\n`

// One stub, named claude, opencode, or op: it logs "<name> <args>" to $CALLS.
// It models the two scopes the way the real CLI (2.1.302, checked in Docker)
// does: $STATE is the user-scope entry, $SHADOW a local- or project-scope one
// for the cwd. `get` prints the shadow when there is one, else the user entry;
// `add --scope user` fails when a user entry exists (even a hidden one);
// `remove --scope user` fails when there is none. The add and remove error
// messages are the real ones.
// STUB_<NAME>_RC forces a failure exit for any non-get call to that CLI.
const STUB = `#!/bin/bash
name="\${0##*/}"
echo "$name $*" >> "$CALLS"
rc_var="STUB_\${name^^}_RC"
if [ -n "\${!rc_var:-}" ] && [ "$2" != "get" ]; then echo "$name broke" >&2; exit "\${!rc_var}"; fi
case "$name $1 $2" in
  "claude mcp get")
    if [ -f "$SHADOW" ]; then cat "$SHADOW"; exit 0; fi
    if [ -f "$STATE" ]; then cat "$STATE"; exit 0; fi
    echo "No MCP server named \\"$3\\"." >&2; exit 1 ;;
  "claude mcp remove")
    if [ ! -f "$STATE" ]; then echo "No MCP server named \\"$5\\" in user scope" >&2; exit 1; fi
    rm -f "$STATE" ;;
  "claude mcp add")
    if [ -f "$STATE" ]; then echo "MCP server $7 already exists in user config" >&2; exit 1; fi
    printf 'parallel:\\n  Scope: ${USER}\\n  Type: http\\n  URL: %s\\n  Headers:\\n    %s\\n\\n' "$8" "\${10}" > "$STATE" ;;
  "op read op://Private/Parallel/credential") printf '%s\\n' "${KEY}" ;;
  "opencode mcp add") pwd > "$OPENCODE_CWD" ;;
  *) echo "unexpected: $name $*" >&2; exit 99 ;;
esac
`

function sandbox({ claude = true, opencode = true, op = true, keyFile = true } = {}) {
  assert.ok(SCRIPT_TEXT, 'the script did not render for darwin + work=false')
  const base = mkdtempSync(join(tmpdir(), 'parallel-mcp-'))
  const home = join(base, 'home dir')
  const bin = join(home, '.local/bin')
  const pathBin = join(base, 'pathbin')
  mkdirSync(bin, { recursive: true })
  mkdirSync(pathBin)
  mkdirSync(join(home, 'project'))
  const script = join(base, 'setup-parallel-mcp.sh')
  writeFileSync(script, SCRIPT_TEXT)
  const keyPath = join(home, '.config/parallel/api-key')
  if (keyFile) {
    mkdirSync(join(home, '.config/parallel'), { recursive: true })
    writeFileSync(keyPath, `${KEY}\n`)
  }
  for (const [want, dir, name] of [[claude, bin, 'claude'], [opencode, pathBin, 'opencode'], [op, pathBin, 'op']]) {
    if (!want) continue
    writeFileSync(join(dir, name), STUB)
    chmodSync(join(dir, name), 0o755)
  }
  const calls = join(base, 'calls')
  const state = join(base, 'state')
  const shadow = join(base, 'shadow')
  const ocwd = join(base, 'opencode-cwd')
  writeFileSync(calls, '')
  return {
    home,
    keyPath,
    // A user-scope entry goes to $STATE; any other scope shadows it in `get`.
    setEntry: (text) => writeFileSync(text.includes(`Scope: ${USER}`) ? state : shadow, text),
    // The user-scope entry, the one the script owns.
    entry: () => (existsSync(state) ? readFileSync(state, 'utf8') : null),
    opencodeCwd: () => readFileSync(ocwd, 'utf8').trim(),
    calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    // cwd is a project dir so the test sees the script move to $HOME for opencode.
    run: (env = {}) =>
      spawnSync('bash', [script], {
        encoding: 'utf8',
        cwd: join(home, 'project'),
        env: { HOME: home, PATH: `${pathBin}:/usr/bin:/bin`, CALLS: calls, STATE: state, SHADOW: shadow, OPENCODE_CWD: ocwd, ...env },
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

test('fresh machine: adds to claude at user scope and to opencode globally from $HOME, exit 0', () =>
  withSandbox({}, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), ['claude mcp get parallel', CLAUDE_ADD, OPENCODE_ADD])
    assert.equal(sb.opencodeCwd(), sb.home)
  }))

test('claude already registered: no claude add, opencode still runs, exit 0', () =>
  withSandbox({}, (sb) => {
    sb.setEntry(entry(USER, URL_))
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), ['claude mcp get parallel', OPENCODE_ADD])
    assert.match(r.stdout, /^parallel-mcp: claude: already registered$/m)
  }))

test('stale user-scope claude entry: removed at user scope, then added', () =>
  withSandbox({}, (sb) => {
    sb.setEntry(entry(USER, `${URL_}/old`))
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), ['claude mcp get parallel', 'claude mcp remove --scope user parallel', CLAUDE_ADD, OPENCODE_ADD])
    assert.ok(sb.entry().includes(`URL: ${URL_}\n`))
    assert.ok(sb.entry().includes(`    ${HEADER}\n`), sb.entry())
  }))

test('stale header on a user-scope claude entry (keyless): removed, then added with the key header', () =>
  withSandbox({}, (sb) => {
    sb.setEntry(entry(USER, URL_).replace(/  Headers:\n.*\n/, ''))
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), ['claude mcp get parallel', 'claude mcp remove --scope user parallel', CLAUDE_ADD, OPENCODE_ADD])
  }))

test('no key file: reads it from 1Password first, writes it 0600, then registers', () =>
  withSandbox({ keyFile: false }, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), [OP_READ, 'claude mcp get parallel', CLAUDE_ADD, OPENCODE_ADD])
    assert.equal(readFileSync(sb.keyPath, 'utf8'), `${KEY}\n`)
    assert.equal(statSync(sb.keyPath).mode & 0o777, 0o600)
  }))

test('key file present: 1Password is not called', () =>
  withSandbox({}, (sb) => {
    assert.equal(sb.run().status, 0)
    assert.ok(!sb.calls().some((c) => c.startsWith('op ')), JSON.stringify(sb.calls()))
  }))

for (const [why, opts, env] of [['op fails', { keyFile: false }, { STUB_OP_RC: '6' }], ['op missing', { keyFile: false, op: false }, {}]]) {
  test(`no key file and ${why}: exit 1 with a fix hint, no key file, nothing registered`, () =>
    withSandbox(opts, (sb) => {
      const r = sb.run(env)
      assert.equal(r.status, 1, r.stdout + r.stderr)
      assert.match(r.stderr, /parallel-mcp: could not read op:\/\/Private\/Parallel\/credential/)
      assert.ok(!existsSync(sb.keyPath))
      assert.ok(!sb.calls().some((c) => !c.startsWith('op ')), JSON.stringify(sb.calls()))
    }))
}

test('the key itself never reaches a CLI argument or stdout', () =>
  withSandbox({ keyFile: false }, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.ok(!sb.calls().some((c) => c.includes(KEY) && !c.startsWith('op ')))
    assert.ok(!(r.stdout + r.stderr).includes(KEY))
  }))

test('local-scope claude entry with another URL: left alone, user scope added', () =>
  withSandbox({}, (sb) => {
    sb.setEntry(entry(LOCAL, 'https://old.example.com/mcp'))
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), ['claude mcp get parallel', CLAUDE_ADD, OPENCODE_ADD])
  }))

test('no claude: exit 1 with a fix hint, opencode still registered', () =>
  withSandbox({ claude: false }, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stderr, /parallel-mcp: .*\/\.local\/bin\/claude not found/)
    assert.deepEqual(sb.calls(), [OPENCODE_ADD])
  }))

test('no opencode: exit 1 with a fix hint, claude still registered', () =>
  withSandbox({ opencode: false }, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stderr, /parallel-mcp: opencode not found on PATH/)
    assert.deepEqual(sb.calls(), ['claude mcp get parallel', CLAUDE_ADD])
  }))

for (const [cli, env] of [['claude', { STUB_CLAUDE_RC: '4' }], ['opencode', { STUB_OPENCODE_RC: '5' }]]) {
  test(`${cli} add fails: exit non-zero, the other CLI is still tried`, () =>
    withSandbox({}, (sb) => {
      const r = sb.run(env)
      assert.notEqual(r.status, 0, r.stdout + r.stderr)
      assert.deepEqual(sb.calls(), ['claude mcp get parallel', CLAUDE_ADD, OPENCODE_ADD])
    }))
}

test('claude remove fails: no claude add, exit non-zero, opencode still tried', () =>
  withSandbox({}, (sb) => {
    sb.setEntry(entry(USER, 'https://old.example.com/mcp'))
    const r = sb.run({ STUB_CLAUDE_RC: '3' })
    assert.notEqual(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), ['claude mcp get parallel', 'claude mcp remove --scope user parallel', OPENCODE_ADD])
  }))

// --- dot_zshenv: the PARALLEL_API_KEY export ----------------------------------

for (const present of [true, false]) {
  test(`zshenv ${present ? 'exports the key file as PARALLEL_API_KEY' : 'is silent and sets nothing without the key file'}`, () => {
    const home = mkdtempSync(join(tmpdir(), 'parallel-zshenv-'))
    try {
      if (present) {
        mkdirSync(join(home, '.config/parallel'), { recursive: true })
        writeFileSync(join(home, '.config/parallel/api-key'), `${KEY}\n`)
      }
      // bash, not zsh: the suite's Docker image has no zsh, and this line uses
      // only syntax both shells read the same way.
      const r = spawnSync('bash', ['-c', `source ${JSON.stringify(join(SOURCE, 'dot_zshenv'))}; printf '[%s]\\n' "\${PARALLEL_API_KEY-unset}"`], {
        encoding: 'utf8',
        env: { HOME: home, PATH: '/usr/bin:/bin' },
      })
      assert.ifError(r.error)
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stderr, '')
      assert.equal(r.stdout, present ? `[${KEY}]\n` : '[unset]\n')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
}

// --- tester additions: real-CLI output, scope shadowing, key-file edge cases --

// Verbatim `claude mcp get parallel` from Claude Code 2.1.302 in a throwaway
// HOME (PARALLEL_API_KEY unset, so the health check failed): it adds Status and
// Issue lines and a trailing hint the hand-written entry() above does not have.
const REAL_GET = `parallel:
  Scope: ${USER}
  Status: ✘ Failed to connect
  Issue: Server rejected the configured Authorization header (HTTP 401). Check that the token is valid for this MCP endpoint — OAuth fallback is disabled when headers.Authorization is set. Error detail: {"code":16,"message":"Invalid API key (C.1)"}
  Type: http
  URL: ${URL_}
  Headers:
    ${HEADER}

To remove this server, run: claude mcp remove parallel -s user
`

test('real claude 2.1.302 `mcp get` output for a correct entry counts as already registered', () =>
  withSandbox({}, (sb) => {
    sb.setEntry(REAL_GET)
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), ['claude mcp get parallel', OPENCODE_ADD])
  }))

// Checked with the real CLI (2.1.302, Docker, throwaway HOME): with a
// local-scope `parallel` for the cwd (chezmoi runs scripts from $HOME), `get`
// shows only the local entry, so the script never sees the user entry. It then
// runs `add --scope user`, which fails with "already exists in user config".
// The invariants: a correct user entry must not fail every apply, and a stale
// one must not stay stale.
test('local-scope entry shadows a correct user-scope entry: exit 0, user entry unchanged', () =>
  withSandbox({}, (sb) => {
    sb.setEntry(entry(USER, URL_))
    sb.setEntry(entry(LOCAL, 'https://old.example.com/mcp'))
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.ok(sb.entry().includes(`URL: ${URL_}\n`) && sb.entry().includes(`    ${HEADER}\n`), sb.entry())
  }))

test('local-scope entry shadows a stale user-scope entry: the user entry ends up correct', () =>
  withSandbox({}, (sb) => {
    sb.setEntry(entry(USER, 'https://old.example.com/mcp'))
    sb.setEntry(entry(LOCAL, 'https://old.example.com/mcp'))
    sb.run()
    assert.ok(sb.entry().includes(`URL: ${URL_}\n`) && sb.entry().includes(`    ${HEADER}\n`), sb.entry())
  }))

// chezmoi apply inherits the shell's environment, and after the first run
// dot_zshenv exports the key: the header must still go to the CLI unexpanded.
test('PARALLEL_API_KEY set in the environment: claude still gets the literal ${PARALLEL_API_KEY} reference', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({ PARALLEL_API_KEY: KEY })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), ['claude mcp get parallel', CLAUDE_ADD, OPENCODE_ADD])
    assert.ok(!sb.calls().some((c) => c.includes(KEY)), JSON.stringify(sb.calls()))
    assert.ok(!sb.entry().includes(KEY), sb.entry())
  }))

test('empty key file left with mode 0644: after the run the key is not group/world-readable', () =>
  withSandbox({ keyFile: false }, (sb) => {
    mkdirSync(join(sb.home, '.config/parallel'), { recursive: true })
    writeFileSync(sb.keyPath, '')
    chmodSync(sb.keyPath, 0o644)
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.equal(readFileSync(sb.keyPath, 'utf8'), `${KEY}\n`)
    assert.equal(statSync(sb.keyPath).mode & 0o077, 0, `mode ${(statSync(sb.keyPath).mode & 0o777).toString(8)}`)
  }))

// `op read` of an item whose credential field is empty exits 0 with no output.
// A newline-only key file passes `[ -s ]`, so every later run would skip 1Password
// and sign requests with an empty key forever.
test('op read succeeds with empty output: no empty key is persisted', () =>
  withSandbox({ keyFile: false, op: false }, (sb) => {
    const opDir = join(sb.home, '..', 'pathbin')
    writeFileSync(join(opDir, 'op'), '#!/bin/bash\necho "op $*" >> "$CALLS"\nexit 0\n')
    chmodSync(join(opDir, 'op'), 0o755)
    sb.run()
    assert.ok(!existsSync(sb.keyPath) || readFileSync(sb.keyPath, 'utf8').trim() !== '', JSON.stringify(existsSync(sb.keyPath) && readFileSync(sb.keyPath, 'utf8')))
  }))

test('key dir cannot be created (~/.config/parallel is a file): exit 1, op and CLIs not called', () =>
  withSandbox({ keyFile: false }, (sb) => {
    mkdirSync(join(sb.home, '.config'), { recursive: true })
    writeFileSync(join(sb.home, '.config/parallel'), 'not a dir\n')
    const r = sb.run()
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), [])
  }))

test('second run after a fresh first run: no op call, no claude add, exit 0', () =>
  withSandbox({ keyFile: false }, (sb) => {
    assert.equal(sb.run().status, 0)
    const first = sb.calls().length
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls().slice(first), ['claude mcp get parallel', OPENCODE_ADD])
  }))

// A real `chezmoi apply` over a source tree with the real template and a
// stand-in for run_once_install-claude-code that drops the stub at
// ~/.local/bin/claude: the script only passes if chezmoi runs it after that
// install, and a second apply must not run it again while it is unchanged.
test('chezmoi apply: runs after install-claude-code, writes the key 0600, and does not re-run unchanged', () => {
  assert.ok(SCRIPT_TEXT, 'the script did not render for darwin + work=false')
  const base = mkdtempSync(join(tmpdir(), 'parallel-mcp-'))
  try {
    const src = join(base, 'src')
    const home = join(base, 'home')
    const pathBin = join(base, 'pathbin')
    for (const d of [src, home, pathBin]) mkdirSync(d)
    writeFileSync(join(src, TEMPLATE), readFileSync(join(SOURCE, TEMPLATE), 'utf8'))
    writeFileSync(join(base, 'stub'), STUB)
    for (const name of ['op', 'opencode']) {
      writeFileSync(join(pathBin, name), STUB)
      chmodSync(join(pathBin, name), 0o755)
    }
    writeFileSync(
      join(src, 'run_once_install-claude-code.sh.tmpl'),
      `#!/bin/bash\nset -eu\nmkdir -p "$HOME/.local/bin"\ncp "${join(base, 'stub')}" "$HOME/.local/bin/claude"\nchmod 755 "$HOME/.local/bin/claude"\n`,
    )
    const calls = join(base, 'calls')
    writeFileSync(calls, '')
    const env = {
      PATH: `${pathBin}:${process.env.PATH}`, HOME: home, CALLS: calls,
      STATE: join(base, 'state'), SHADOW: join(base, 'shadow'), OPENCODE_CWD: join(base, 'ocwd'),
    }
    const apply = () =>
      spawnSync(
        'chezmoi',
        ['--source', src, '--destination', home, '--override-data', JSON.stringify({ work: false, chezmoi: { os: 'darwin' } }), '--no-tty', 'apply', '--force'],
        { encoding: 'utf8', env },
      )
    const read = () => readFileSync(calls, 'utf8').split('\n').filter(Boolean)
    const r1 = apply()
    assert.ifError(r1.error)
    assert.equal(r1.status, 0, `apply 1 exited ${r1.status}: ${r1.stdout}${r1.stderr}`)
    assert.deepEqual(read(), [OP_READ, 'claude mcp get parallel', CLAUDE_ADD, OPENCODE_ADD])
    const keyPath = join(home, '.config/parallel/api-key')
    assert.equal(readFileSync(keyPath, 'utf8'), `${KEY}\n`)
    assert.equal(statSync(keyPath).mode & 0o777, 0o600)
    assert.equal(readFileSync(env.OPENCODE_CWD, 'utf8').trim(), home)
    const r2 = apply()
    assert.equal(r2.status, 0, `apply 2 exited ${r2.status}: ${r2.stdout}${r2.stderr}`)
    assert.equal(read().length, 4, `apply 2 re-ran the script: ${JSON.stringify(read())}`)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// The suite's bash check above stands in for zsh; this runs the real shell the
// file is for, the way a non-interactive `zsh -c` (agent shells) loads it.
const hasZsh = spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).status === 0
for (const present of [true, false]) {
  test(`zsh: .zshenv ${present ? 'hands PARALLEL_API_KEY to child processes' : 'leaves PARALLEL_API_KEY unset and prints nothing'}`, { skip: hasZsh ? false : 'zsh not installed (see the run command at the top)' }, () => {
    const home = mkdtempSync(join(tmpdir(), 'parallel-zsh-'))
    try {
      writeFileSync(join(home, '.zshenv'), readFileSync(join(SOURCE, 'dot_zshenv'), 'utf8'))
      if (present) {
        mkdirSync(join(home, '.config/parallel'), { recursive: true })
        writeFileSync(join(home, '.config/parallel/api-key'), `${KEY}\n`)
      }
      const r = spawnSync('zsh', ['-c', `sh -c 'printf "[%s]\\n" "\${PARALLEL_API_KEY-unset}"'`], {
        encoding: 'utf8',
        env: { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin' },
      })
      assert.ifError(r.error)
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stderr, '')
      assert.equal(r.stdout, present ? `[${KEY}]\n` : '[unset]\n')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
}

// --- CLAUDE.md / AGENTS.md: the web-search rule ------------------------------
// What a pass proves: each agent's rendered rules name its own Parallel tool
// exactly where the server is registered (Codex: work=false on any OS; Claude
// Code and opencode: darwin + work=false), sit right after the Email bullet in
// Environment, and are absent everywhere else.

function renderRules(target, work, os) {
  const home = mkdtempSync(join(tmpdir(), 'parallel-rules-'))
  try {
    const r = spawnSync(
      'chezmoi',
      ['--source', SOURCE, '--destination', home, '--override-data', JSON.stringify({ work, chezmoi: { os } }), 'cat', join(home, target)],
      { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } },
    )
    assert.ifError(r.error)
    assert.equal(r.status, 0, `chezmoi cat ${target} (work=${work} os=${os}) exited ${r.status}: ${r.stderr}`)
    return r.stdout
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

const EMAIL = '- Email: `himalaya` CLI (personal and work accounts) unless I ask otherwise.\n'
const FALLBACK = 'If the `parallel` server is not connected or a call fails, tell me, then use the built-in tool for that search.'
const SEARCH_RULE = {
  claude: `- Web search: use Parallel (\`mcp__parallel__web_search\`), not your built-in WebSearch. ${FALLBACK}\n`,
  codex: `- Web search: use Parallel (the \`parallel\` MCP server's \`web_search\` tool), not your built-in web search. ${FALLBACK}\n`,
  opencode: `- Web search: use Parallel (\`parallel_web_search\`), not your built-in \`websearch\` tool. ${FALLBACK}\n`,
}

for (const [reader, target, everyOs] of [
  ['claude', '.claude/CLAUDE.md', false],
  ['codex', '.codex/AGENTS.md', true],
  ['opencode', '.config/opencode/AGENTS.md', false],
]) {
  for (const os of ['darwin', 'linux']) {
    for (const work of [false, true]) {
      const renders = !work && (everyOs || os === 'darwin')
      test(`${reader} os=${os} work=${work}: web-search rule ${renders ? 'renders once after Email' : 'is absent'}`, () => {
        const t = renderRules(target, work, os)
        assert.doesNotMatch(t, /\{\{|\}\}|<no value>/)
        const lines = t.split('\n').filter((l) => /Web search|Parallel \(|mcp__parallel|parallel_web_search|`parallel`/.test(l))
        if (renders) {
          assert.deepEqual(lines, [SEARCH_RULE[reader].trimEnd()])
          assert.ok(t.includes(EMAIL + SEARCH_RULE[reader]), 'web-search rule is not right after the Email bullet')
        } else {
          assert.deepEqual(lines, [])
          assert.ok(t.includes(EMAIL + '- A new or changed scheduled job'), 'Email bullet no longer runs straight into the next bullet')
        }
      })
    }
  }
}

// The matrix above is hardcoded, so it would stay green if the registration
// gates moved and the rule's gate did not. What a pass proves: for every
// os/work pair, each agent gets the rule exactly when its server is
// registered there, read from the real registration templates (the setup
// script for Claude Code and opencode, config.toml for Codex), so an agent is
// never told to use a server it lacks, nor left on built-in search where it
// has one. It says nothing about whether the server works on that machine.
for (const os of ['darwin', 'linux']) {
  for (const work of [false, true]) {
    test(`os=${os} work=${work}: web-search rule renders exactly where Parallel is registered`, () => {
      const scriptRegisters = execTemplate({ work, chezmoi: { os } }).trim() !== ''
      const codexRegisters = chezmoi((home) => ['cat', join(home, '.codex/config.toml')], { work, chezmoi: { os } }).includes('[mcp_servers.parallel]')
      for (const [reader, target, registered] of [
        ['claude', '.claude/CLAUDE.md', scriptRegisters],
        ['codex', '.codex/AGENTS.md', codexRegisters],
        ['opencode', '.config/opencode/AGENTS.md', scriptRegisters],
      ]) {
        const hasRule = renderRules(target, work, os).includes(SEARCH_RULE[reader])
        assert.equal(hasRule, registered, `${reader}: rule=${hasRule} but server registered=${registered}`)
      }
    })
  }
}
