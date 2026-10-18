// Parallel Search MCP on personal machines: run_onchange_after_add-parallel-mcp.sh.tmpl
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
// dot_zshenv exports the file as PARALLEL_API_KEY and is silent without it.
// It says nothing about the real CLIs or the Parallel server; those were
// checked by hand on the personal Mac.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SOURCE = new URL('../../', import.meta.url).pathname
const TEMPLATE = 'run_onchange_after_add-parallel-mcp.sh.tmpl'
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

// One stub, named claude or opencode: it logs "<name> <args>" to $CALLS.
// $STATE holds what `claude mcp get parallel` prints (absent = not registered).
// STUB_<NAME>_RC forces a failure exit for any call to that CLI.
const STUB = `#!/bin/bash
name="\${0##*/}"
echo "$name $*" >> "$CALLS"
rc_var="STUB_\${name^^}_RC"
if [ -n "\${!rc_var:-}" ] && [ "$2" != "get" ]; then echo "$name broke" >&2; exit "\${!rc_var}"; fi
case "$name $1 $2" in
  "claude mcp get")
    if [ -f "$STATE" ]; then cat "$STATE"; exit 0; fi
    echo "No MCP server named \\"$3\\"." >&2; exit 1 ;;
  "claude mcp remove") rm -f "$STATE" ;;
  "claude mcp add")
    printf 'parallel:\\n  Scope: ${USER}\\n  Type: http\\n  URL: %s\\n  Headers:\\n    %s\\n\\n' "$8" "${10}" > "$STATE" ;;
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
  const script = join(base, 'add-parallel-mcp.sh')
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
  return {
    home,
    keyPath,
    setEntry: (text) => writeFileSync(state, text),
    entry: () => (existsSync(state) ? readFileSync(state, 'utf8') : null),
    opencodeCwd: () => readFileSync(ocwd, 'utf8').trim(),
    calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean),
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
