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
// fails, always replaces the user-scope Claude entry with exactly
// {type, url, headersHelper} (no static headers), passes the {file:...}
// reference to opencode, never puts the key in a CLI argument or stdout, and
// exits non-zero when either CLI is missing or fails, while still trying the
// other. The stored headersHelper, run by sh and bash with no
// PARALLEL_API_KEY (as the launchd-started desktop app runs it), prints the
// Authorization header from the key file, and a sentinel token when the file
// is missing or empty (an empty token would connect anonymously).
// dot_zshenv exports the file as PARALLEL_API_KEY for Codex and is silent
// without it (under bash always, under zsh when zsh is installed). A real
// `chezmoi apply` runs the script after run_once_install-claude-code and not
// again while it is unchanged. It says nothing about the Parallel server, and
// the stubs only stand in for the real CLIs (Claude Code 2.1.319 was checked
// in Docker: add-json stores the helper verbatim, `mcp get` does not show it,
// add-json on an existing user entry fails with "already exists in user
// config", and a failed or empty-token helper connects anonymously).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SOURCE = new URL('../../', import.meta.url).pathname
const TEMPLATE = 'run_onchange_after_setup-parallel-mcp.sh.tmpl'
const URL_ = 'https://search.parallel.ai/mcp'
const CLAUDE_REMOVE = 'claude mcp remove --scope user parallel'
const ADD_JSON = 'claude mcp add-json --scope user parallel '
// The logged add-json line with its JSON argument folded, so call lists stay
// readable; the JSON itself is checked through the stored entry.
const CLAUDE_ADD = `${ADD_JSON}<json>`
const foldAdd = (line) => (line.startsWith(ADD_JSON) ? CLAUDE_ADD : line)
const SENTINEL = 'missing-parallel-key-file'
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
    assert.match(t, /\[mcp_servers\.rea\]\ncommand = ".*\/bin\/rea"\nargs = \[ "mcp" \]\nstartup_timeout_sec = 30\ntool_timeout_sec = 450\n/)
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

// Any earlier user-scope entry: the old ${PARALLEL_API_KEY} header form.
const OLD_ENTRY = JSON.stringify({ type: 'http', url: URL_, headers: { Authorization: 'Bearer ${PARALLEL_API_KEY}' } })

// One stub, named claude, opencode, or op: it logs "<name> <args>" to $CALLS.
// $STATE holds the user-scope entry's JSON. As in the real CLI (2.1.319,
// checked in Docker), `add-json --scope user` fails when a user entry exists
// and `remove --scope user` fails when there is none, with the real messages.
// Local- and project-scope entries do not affect either call, so the stub
// does not model them.
// STUB_<NAME>_RC forces a failure exit for any call to that CLI;
// STUB_CLAUDE_REMOVE_RC fails only `claude mcp remove`, leaving the entry;
// STUB_CLAUDE_ADD_RC fails only `claude mcp add-json`.
const STUB = `#!/bin/bash
name="\${0##*/}"
echo "$name $*" >> "$CALLS"
rc_var="STUB_\${name^^}_RC"
if [ -n "\${!rc_var:-}" ]; then echo "$name broke" >&2; exit "\${!rc_var}"; fi
case "$name $1 $2" in
  "claude mcp remove")
    if [ -n "\${STUB_CLAUDE_REMOVE_RC:-}" ]; then echo "remove broke" >&2; exit "$STUB_CLAUDE_REMOVE_RC"; fi
    if [ ! -f "$STATE" ]; then echo "No MCP server named \\"$5\\" in user scope" >&2; exit 1; fi
    rm -f "$STATE" ;;
  "claude mcp add-json")
    if [ -n "\${STUB_CLAUDE_ADD_RC:-}" ]; then echo "add-json broke" >&2; exit "$STUB_CLAUDE_ADD_RC"; fi
    if [ -f "$STATE" ]; then echo "MCP server $5 already exists in user config" >&2; exit 1; fi
    printf '%s' "$6" > "$STATE"
    echo "Added http MCP server $5 to user config" ;;
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
  const ocwd = join(base, 'opencode-cwd')
  writeFileSync(calls, '')
  const rawCalls = () => readFileSync(calls, 'utf8').split('\n').filter(Boolean)
  return {
    home,
    keyPath,
    setEntry: (json) => writeFileSync(state, json),
    // The user-scope entry, the one the script owns, as stored text.
    entry: () => (existsSync(state) ? readFileSync(state, 'utf8') : null),
    opencodeCwd: () => readFileSync(ocwd, 'utf8').trim(),
    rawCalls,
    calls: () => rawCalls().map(foldAdd),
    // cwd is a project dir so the test sees the script move to $HOME for opencode.
    run: (env = {}) =>
      spawnSync('bash', [script], {
        encoding: 'utf8',
        cwd: join(home, 'project'),
        env: { HOME: home, PATH: `${pathBin}:/usr/bin:/bin`, CALLS: calls, STATE: state, OPENCODE_CWD: ocwd, ...env },
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

// The user-scope entry the script stored, parsed.
const stored = (sb) => {
  assert.ok(sb.entry(), 'no user-scope claude entry')
  return JSON.parse(sb.entry())
}

// Run a stored headersHelper the way the launchd-started desktop app does: in
// a shell, cwd ~/.claude, with no PARALLEL_API_KEY in the environment.
function runHelper(helper, home, shell) {
  mkdirSync(join(home, '.claude'), { recursive: true })
  const r = spawnSync(shell, ['-c', helper], { encoding: 'utf8', cwd: join(home, '.claude'), env: { HOME: home, PATH: '/usr/bin:/bin' } })
  assert.ifError(r.error)
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

test('fresh machine: adds to claude at user scope and to opencode globally from $HOME, exit 0', () =>
  withSandbox({}, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), [CLAUDE_REMOVE, CLAUDE_ADD, OPENCODE_ADD])
    assert.equal(sb.opencodeCwd(), sb.home)
    // The remove of a missing entry is expected; its error must not leak.
    assert.doesNotMatch(r.stderr, /No MCP server named/)
  }))

test('stored claude entry is exactly {type, url, headersHelper}: no static headers', () =>
  withSandbox({}, (sb) => {
    assert.equal(sb.run().status, 0)
    const e = stored(sb)
    assert.deepEqual(Object.keys(e).sort(), ['headersHelper', 'type', 'url'])
    assert.equal(e.type, 'http')
    assert.equal(e.url, URL_)
    assert.equal(typeof e.headersHelper, 'string')
  }))

for (const shell of ['sh', 'bash']) {
  for (const [why, content, token] of [
    ['key file present', `${KEY}\n`, KEY],
    ['key file missing', null, SENTINEL],
    ['key file empty', '', SENTINEL],
  ]) {
    test(`headersHelper under ${shell}, ${why}: prints Authorization: Bearer ${token === KEY ? '<key>' : 'the sentinel'}`, () =>
      withSandbox({}, (sb) => {
        assert.equal(sb.run().status, 0)
        const helper = stored(sb).headersHelper
        if (content === null) rmSync(sb.keyPath)
        else writeFileSync(sb.keyPath, content)
        assert.deepEqual(runHelper(helper, sb.home, shell), { Authorization: `Bearer ${token}` })
      }))
  }
}

test('existing user-scope claude entry (old ${PARALLEL_API_KEY} header): replaced by the helper entry', () =>
  withSandbox({}, (sb) => {
    sb.setEntry(OLD_ENTRY)
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), [CLAUDE_REMOVE, CLAUDE_ADD, OPENCODE_ADD])
    assert.deepEqual(Object.keys(stored(sb)).sort(), ['headersHelper', 'type', 'url'])
  }))

test('no key file: reads it from 1Password first, writes it 0600, then registers', () =>
  withSandbox({ keyFile: false }, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), [OP_READ, CLAUDE_REMOVE, CLAUDE_ADD, OPENCODE_ADD])
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

test('the key itself never reaches a CLI argument, the stored entry, or stdout', () =>
  withSandbox({ keyFile: false }, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.ok(!sb.rawCalls().some((c) => c.includes(KEY) && !c.startsWith('op ')))
    assert.ok(!sb.entry().includes(KEY), sb.entry())
    assert.ok(!(r.stdout + r.stderr).includes(KEY))
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
    assert.deepEqual(sb.calls(), [CLAUDE_REMOVE, CLAUDE_ADD])
  }))

for (const [cli, env] of [['claude', { STUB_CLAUDE_RC: '4' }], ['opencode', { STUB_OPENCODE_RC: '5' }]]) {
  test(`${cli} fails: exit non-zero with its error on stderr, the other CLI is still tried`, () =>
    withSandbox({}, (sb) => {
      const r = sb.run(env)
      assert.notEqual(r.status, 0, r.stdout + r.stderr)
      assert.match(r.stderr, new RegExp(`${cli} broke`))
      assert.deepEqual(sb.calls(), [CLAUDE_REMOVE, CLAUDE_ADD, OPENCODE_ADD])
    }))
}

test('claude remove fails and leaves the old entry: add-json fails, exit non-zero, old entry kept, opencode still tried', () =>
  withSandbox({}, (sb) => {
    sb.setEntry(OLD_ENTRY)
    const r = sb.run({ STUB_CLAUDE_REMOVE_RC: '3' })
    assert.notEqual(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stderr, /already exists in user config/)
    assert.deepEqual(sb.calls(), [CLAUDE_REMOVE, CLAUDE_ADD, OPENCODE_ADD])
    assert.equal(sb.entry(), OLD_ENTRY)
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

// --- tester additions: key-file edge cases ------------------------------------

// chezmoi apply inherits the shell's environment, and after the first run
// dot_zshenv exports the key: neither the key nor a ${PARALLEL_API_KEY}
// reference may reach the claude entry.
test('PARALLEL_API_KEY set in the environment: claude entry has neither the key nor ${PARALLEL_API_KEY}', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({ PARALLEL_API_KEY: KEY })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), [CLAUDE_REMOVE, CLAUDE_ADD, OPENCODE_ADD])
    assert.ok(!sb.rawCalls().some((c) => c.includes(KEY)), JSON.stringify(sb.rawCalls()))
    assert.ok(!sb.entry().includes(KEY), sb.entry())
    assert.ok(!sb.entry().includes('${PARALLEL_API_KEY}'), sb.entry())
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

test('second run after a fresh first run: no op call, user entry replaced with the same content, exit 0', () =>
  withSandbox({ keyFile: false }, (sb) => {
    assert.equal(sb.run().status, 0)
    const first = sb.calls().length
    const before = sb.entry()
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls().slice(first), [CLAUDE_REMOVE, CLAUDE_ADD, OPENCODE_ADD])
    assert.equal(sb.entry(), before)
    assert.doesNotMatch(r.stderr, /already exists/)
  }))

// The remove succeeds and only the add fails: the run must still fail loudly
// with the add's own error, and opencode must still be tried.
test('claude remove succeeds but add-json fails: exit non-zero with the add error, opencode still tried', () =>
  withSandbox({}, (sb) => {
    sb.setEntry(OLD_ENTRY)
    const r = sb.run({ STUB_CLAUDE_ADD_RC: '7' })
    assert.notEqual(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stderr, /add-json broke/)
    assert.deepEqual(sb.calls(), [CLAUDE_REMOVE, CLAUDE_ADD, OPENCODE_ADD])
  }))

// Claude Code 2.1.319 (checked in Docker against search.parallel.ai) connects
// anonymously with "Connected" when the helper's stdout is not valid JSON (it
// sends no Authorization header) or its Bearer token is blank (it sends a bare
// `Authorization: Bearer`). The helper
// guards a missing or empty file with a sentinel; these are key files that
// pass `[ -s ]` (so the script never re-fetches them) but still break it: a
// CRLF line ending puts a raw CR (invalid in a JSON string) in the output, and
// a whitespace-only file gives a blank token. Invariant, whatever the fix:
// stdout parses, and the token is non-blank with no whitespace or control
// characters, so Parallel gets a credential it can reject with a 401.
for (const shell of ['sh', 'bash']) {
  for (const [why, content] of [
    ['CRLF line ending', `${KEY}\r\n`],
    ['whitespace-only', '   \n'],
    ['newlines only', '\n\n'],
  ]) {
    test(`headersHelper under ${shell}, key file ${why}: valid JSON with a non-blank Bearer token (never anonymous)`, () =>
      withSandbox({}, (sb) => {
        assert.equal(sb.run().status, 0)
        const helper = stored(sb).headersHelper
        writeFileSync(sb.keyPath, content)
        mkdirSync(join(sb.home, '.claude'), { recursive: true })
        const r = spawnSync(shell, ['-c', helper], { encoding: 'utf8', cwd: join(sb.home, '.claude'), env: { HOME: sb.home, PATH: '/usr/bin:/bin' } })
        assert.ifError(r.error)
        assert.equal(r.status, 0, r.stderr)
        let out
        assert.doesNotThrow(() => (out = JSON.parse(r.stdout)), `helper stdout is not JSON: ${JSON.stringify(r.stdout)}`)
        assert.match(out.Authorization, /^Bearer [^\s\x00-\x1f]+$/, JSON.stringify(out))
      }))
  }
}

// A key file with a JSON-special character (" or \) would make the helper
// print invalid JSON, which connects anonymously. The helper keeps only
// [A-Za-z0-9_-] (Parallel's key alphabet), so the output stays valid JSON.
test('headersHelper output stays valid JSON for a key file with " or \\', () =>
  withSandbox({}, (sb) => {
    assert.equal(sb.run().status, 0)
    const helper = stored(sb).headersHelper
    writeFileSync(sb.keyPath, 'pk_"q\\\n')
    const out = runHelper(helper, sb.home, 'sh')
    assert.match(out.Authorization, /^Bearer [A-Za-z0-9_-]+$/)
  }))

// `cat` fails on a directory even as root (the image runs tests as root, so a
// mode-000 file would still be readable): the helper must still exit 0 and
// send the sentinel, never a blank token.
for (const shell of ['sh', 'bash']) {
  test(`headersHelper under ${shell}, key path is unreadable (a directory): prints the sentinel, exit 0`, () =>
    withSandbox({}, (sb) => {
      assert.equal(sb.run().status, 0)
      const helper = stored(sb).headersHelper
      rmSync(sb.keyPath)
      mkdirSync(sb.keyPath)
      assert.deepEqual(runHelper(helper, sb.home, shell), { Authorization: `Bearer ${SENTINEL}` })
    }))

  // The helper reads ~/..., so a HOME with a space must not split the path.
  test(`headersHelper under ${shell}, HOME contains a space: still reads the key file`, () =>
    withSandbox({}, (sb) => {
      assert.equal(sb.run().status, 0)
      const helper = stored(sb).headersHelper
      const spaced = join(sb.home, 'with space')
      mkdirSync(join(spaced, '.config/parallel'), { recursive: true })
      writeFileSync(join(spaced, '.config/parallel/api-key'), `${KEY}\n`)
      assert.deepEqual(runHelper(helper, spaced, shell), { Authorization: `Bearer ${KEY}` })
    }))
}

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
      STATE: join(base, 'state'), OPENCODE_CWD: join(base, 'ocwd'),
    }
    const apply = () =>
      spawnSync(
        'chezmoi',
        ['--source', src, '--destination', home, '--override-data', JSON.stringify({ work: false, chezmoi: { os: 'darwin' } }), '--no-tty', 'apply', '--force'],
        { encoding: 'utf8', env },
      )
    const read = () => readFileSync(calls, 'utf8').split('\n').filter(Boolean).map(foldAdd)
    const r1 = apply()
    assert.ifError(r1.error)
    assert.equal(r1.status, 0, `apply 1 exited ${r1.status}: ${r1.stdout}${r1.stderr}`)
    assert.deepEqual(read(), [OP_READ, CLAUDE_REMOVE, CLAUDE_ADD, OPENCODE_ADD])
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
