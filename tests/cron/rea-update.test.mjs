// Behavior of the REA updater (dot_cron/executable_rea-update.sh), the wiring
// that runs it (crontab line, run_onchange_after_install-rea.sh.tmpl), and the
// Codex registration chezmoi owns (dot_codex/config.toml.tmpl).
//
// Run from the repo root (chezmoi is needed for the Codex render tests; without
// it they FAIL, they do not skip):
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin && node --test tests/cron/rea-update.test.mjs'
//
// What a pass proves: with stub npm/asdf/rea on a PATH that has no real ones,
// the script installs the spec, reshims, checks `rea --version`, then runs
// `rea setup` for Claude Code and OpenCode only (never Codex, whose config
// chezmoi owns) with --yes and no stdin, then `rea doctor --client codex`; it
// writes ~/.cron/logs/rea.FAILED on each failure step, a stale Codex entry
// included, and removes it on success. The Codex entry renders with the
// Node version pinned in dot_tool-versions and fails the render when none is
// pinned. It says nothing about the real npm registry or the real `rea setup`;
// a Docker probe of rea-agents 6.4.0 showed setup writes this exact Codex entry
// that a second setup run changes no file, and that `rea doctor --client codex`
// exits 0 for this entry and 1 for a stale path, a missing key, or no entry.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, chmodSync, rmSync, cpSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('../../', import.meta.url)
const SOURCE = ROOT.pathname
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8')
const SCRIPT = new URL('dot_cron/executable_rea-update.sh', ROOT).pathname
const SYS_PATH = '/usr/bin:/bin'
const SETUP = 'rea setup --client claude_code --client opencode --yes --json'

const STUBS = {
  npm: '#!/bin/sh\necho "npm $*" >> "$CALLS"\nexit "${STUB_NPM_RC:-0}"\n',
  asdf: '#!/bin/sh\necho "asdf $*" >> "$CALLS"\nexit 0\n',
  rea:
    '#!/bin/sh\n' +
    // Record whether stdin is a terminal-free empty stream for setup calls.
    'if [ "$1" = setup ]; then echo "rea $* stdin=$(cat | wc -c | tr -d " ")" >> "$CALLS"; [ -n "${STUB_SETUP_OUT:-}" ] && printf "%s\\n" "$STUB_SETUP_OUT"; exit "${STUB_SETUP_RC:-0}"; fi\n' +
    'echo "rea $*" >> "$CALLS"\n' +
    'if [ "$1" = doctor ]; then exit "${STUB_DOCTOR_RC:-0}"; fi\n' +
    'if [ "${STUB_REA_RC:-0}" != 0 ]; then echo "${STUB_REA_ERR:-boom}" >&2; exit "$STUB_REA_RC"; fi\n' +
    'printf "%s\\n" "${STUB_REA_OUT:-6.4.0}"\n',
}

function sandbox({ stubs = ['npm', 'asdf', 'rea'], homeName = 'home' } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'rea-update-'))
  const home = join(base, homeName)
  const bin = join(base, 'bin')
  mkdirSync(home, { recursive: true })
  mkdirSync(bin)
  for (const s of stubs) {
    writeFileSync(join(bin, s), STUBS[s])
    chmodSync(join(bin, s), 0o755)
  }
  const calls = join(base, 'calls')
  writeFileSync(calls, '')
  const marker = join(home, '.cron', 'logs', 'rea.FAILED')
  return {
    home,
    marker,
    calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    run: (env = {}) =>
      spawnSync('sh', [SCRIPT], {
        encoding: 'utf8',
        input: 'stdin must not reach rea setup\n',
        env: { HOME: home, PATH: `${bin}:${SYS_PATH}`, CALLS: calls, ...env },
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

function assertFailed(sb, r, reason) {
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /rea-update: FAILED: /)
  assert.ok(existsSync(sb.marker), 'no rea.FAILED marker written')
  const m = readFileSync(sb.marker, 'utf8')
  assert.match(m, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} rea update failed: /)
  assert.match(m, reason)
  assert.match(m, /see ~\/\.cron\/logs\/rea\.log/)
}

// --- rea-update.sh -------------------------------------------------------------

test('success: installs rea-agents@latest, reshims, checks rea, runs scoped setup, no marker', () =>
  withSandbox({}, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), [
      'npm install --global rea-agents@latest',
      'asdf reshim nodejs',
      'rea --version',
      `${SETUP} stdin=0`,
      'rea doctor --client codex --json',
    ])
    assert.match(r.stdout, /^rea-update: ok: 6\.4\.0$/m)
    assert.equal(existsSync(sb.marker), false)
  }))

test('setup never targets Codex (chezmoi owns ~/.codex/config.toml)', () =>
  withSandbox({}, (sb) => {
    sb.run()
    const setups = sb.calls().filter((c) => c.startsWith('rea setup'))
    assert.equal(setups.length, 1, setups.join('\n'))
    assert.doesNotMatch(setups[0], /codex/)
  }))

test('success removes a marker left by an earlier failure', () =>
  withSandbox({}, (sb) => {
    mkdirSync(join(sb.home, '.cron', 'logs'), { recursive: true })
    writeFileSync(sb.marker, 'old failure\n')
    assert.equal(sb.run().status, 0)
    assert.equal(existsSync(sb.marker), false)
  }))

test('REA_UPDATE_PACKAGE overrides the npm spec; empty falls back to latest', () =>
  withSandbox({}, (sb) => {
    sb.run({ REA_UPDATE_PACKAGE: 'rea-agents@6.3.0' })
    sb.run({ REA_UPDATE_PACKAGE: '' })
    const installs = sb.calls().filter((c) => c.startsWith('npm'))
    assert.deepEqual(installs, ['npm install --global rea-agents@6.3.0', 'npm install --global rea-agents@latest'])
  }))

test('npm missing: exit 1 with a marker, nothing runs', () =>
  withSandbox({ stubs: ['asdf', 'rea'] }, (sb) => {
    assertFailed(sb, sb.run(), /npm not found on PATH/)
    assert.deepEqual(sb.calls(), [])
  }))

test('npm install fails: exit 1, marker names the spec, no setup', () =>
  withSandbox({}, (sb) => {
    assertFailed(sb, sb.run({ STUB_NPM_RC: '1' }), /npm install --global rea-agents@latest/)
    assert.deepEqual(sb.calls(), ['npm install --global rea-agents@latest'])
  }))

test('rea --version fails: exit 1, marker carries its stderr, no setup', () =>
  withSandbox({}, (sb) => {
    assertFailed(sb, sb.run({ STUB_REA_RC: '1', STUB_REA_ERR: 'unsupported Node' }), /rea --version: unsupported Node/)
    assert.equal(sb.calls().some((c) => c.startsWith('rea setup')), false)
  }))

test('rea setup fails (e.g. needs_confirmation exits 1): exit 1 with a marker', () =>
  withSandbox({}, (sb) => {
    assertFailed(sb, sb.run({ STUB_SETUP_RC: '1' }), /rea setup --client claude_code --client opencode/)
  }))

test('rea doctor reports a stale Codex entry: exit 1 with a marker that names the template', () =>
  withSandbox({}, (sb) => {
    assertFailed(sb, sb.run({ STUB_DOCTOR_RC: '1' }), /rea doctor --client codex: dot_codex\/config\.toml\.tmpl no longer matches/)
  }))

test('a forced npm failure through REA_UPDATE_PACKAGE leaves the marker; doctor never runs', () =>
  withSandbox({}, (sb) => {
    assertFailed(sb, sb.run({ STUB_NPM_RC: '1', REA_UPDATE_PACKAGE: 'rea-agents@0.0.0-nope' }), /rea-agents@0\.0\.0-nope/)
    assert.equal(sb.calls().some((c) => c.startsWith('rea doctor')), false)
  }))

test('rea-update.sh: POSIX sh shebang, parses under sh -n', () => {
  assert.match(read('dot_cron/executable_rea-update.sh'), /^#!\/bin\/sh\n/)
  assert.equal(spawnSync('sh', ['-n', SCRIPT]).status, 0)
})

// dot_zshrc's failure-banner loop, run alone (zsh -f: no startup files).
const zshrcLine = read('dot_zshrc')
  .split('\n')
  .find((l) => l.includes('.FAILED') && !l.trimStart().startsWith('#'))
const hasZsh = spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).status === 0
const zskip = hasZsh ? false : 'zsh not installed (see the run command at the top)'
const banner = (home) => spawnSync('zsh', ['-f', '-c', zshrcLine], { encoding: 'utf8', env: { HOME: home, PATH: SYS_PATH } })

test('no asdf on PATH: still succeeds, skips the reshim, setup and doctor still run', () =>
  withSandbox({ stubs: ['npm', 'rea'] }, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), [
      'npm install --global rea-agents@latest',
      'rea --version',
      `${SETUP} stdin=0`,
      'rea doctor --client codex --json',
    ])
    assert.equal(existsSync(sb.marker), false)
  }))

test('rea missing after install (bin not linked): exit 1 with a marker, no setup', () =>
  withSandbox({ stubs: ['npm', 'asdf'] }, (sb) => {
    assertFailed(sb, sb.run(), /rea --version: /)
    assert.deepEqual(sb.calls(), ['npm install --global rea-agents@latest', 'asdf reshim nodejs'])
  }))

test('rea setup fails: doctor never runs (no success claimed past a failed step)', () =>
  withSandbox({}, (sb) => {
    assertFailed(sb, sb.run({ STUB_SETUP_RC: '1' }), /rea setup/)
    assert.equal(sb.calls().some((c) => c.startsWith('rea doctor')), false)
  }))

test('repeated failures replace the marker, they never append to it', () =>
  withSandbox({}, (sb) => {
    sb.run({ STUB_NPM_RC: '1' })
    sb.run({ STUB_SETUP_RC: '1' })
    sb.run({ STUB_DOCTOR_RC: '1' })
    const m = readFileSync(sb.marker, 'utf8')
    assert.equal(m.trimEnd().split('\n').length, 1, m)
    assert.match(m, /rea doctor --client codex/, 'marker must describe the latest failure')
  }))

test('HOME with spaces and non-ASCII: marker lands in that HOME, success clears it', () =>
  withSandbox({ homeName: 'Ränd all ☁️' }, (sb) => {
    assertFailed(sb, sb.run({ STUB_DOCTOR_RC: '1' }), /rea doctor/)
    assert.ok(sb.marker.includes('Ränd all ☁️'))
    assert.equal(sb.run().status, 0)
    assert.equal(existsSync(sb.marker), false)
  }))

// Real rea-agents 6.4.0 reports a setup failure (needs_confirmation, an
// unparsable ~/.claude.json) as JSON on stdout and nothing on stderr, observed
// in a Docker probe. The marker sends the reader to rea.log, so the cause has to
// reach the script's output; today `> /dev/null` drops it and the log holds only
// "FAILED: rea setup ...". Any fix that keeps the cause visible passes.
test('DEFECT: a rea setup failure leaves its cause in the log the marker points to', () =>
  withSandbox({}, (sb) => {
    const cause = '{"status":"failed","error":"cannot parse /h/.claude.json: Unexpected end of JSON input"}'
    const r = sb.run({ STUB_SETUP_RC: '1', STUB_SETUP_OUT: cause })
    assert.equal(r.status, 1)
    assert.ok((r.stdout + r.stderr).includes('cannot parse /h/.claude.json'), `log would hold only:\n${r.stdout}${r.stderr}`)
  }))

test('end to end: a stale Codex entry shows in the zsh banner, the next good run clears it', { skip: zskip }, () =>
  withSandbox({}, (sb) => {
    sb.run({ STUB_DOCTOR_RC: '1' })
    const shown = banner(sb.home)
    assert.equal(shown.status, 0, shown.stderr)
    assert.match(shown.stdout, /cron: .* rea update failed: rea doctor --client codex: dot_codex\/config\.toml\.tmpl no longer matches/)
    assert.equal(sb.run().status, 0)
    assert.equal(banner(sb.home).stdout, '')
  }))

// --- Wiring --------------------------------------------------------------------

test('crontab: one daily 10:25 job runs ~/.cron/rea-update.sh and logs to rea.log', () => {
  const jobs = read('dot_cron/crontab.tmpl').split('\n').filter((l) => l.includes('rea-update.sh') && !l.startsWith('#'))
  assert.equal(jobs.length, 1, jobs.join('\n'))
  assert.match(jobs[0], /^25 10 \* \* \* \{ date; \$HOME\/\.cron\/rea-update\.sh; \} > \$HOME\/\.cron\/logs\/rea\.log 2>&1$/)
})

test('run_onchange: after_ script, re-runs on Node pin or script change, execs the cron script', () => {
  const s = read('run_onchange_after_install-rea.sh.tmpl')
  assert.match(s, /^\{\{- if eq \.chezmoi\.os "darwin" -\}\}\n#!\/bin\/bash\n/)
  assert.match(s, /\{\{ include "dot_tool-versions" \| sha256sum \}\}/)
  assert.match(s, /\{\{ include "dot_cron\/executable_rea-update\.sh" \| sha256sum \}\}/)
  assert.match(s, /^exec "\$HOME\/\.cron\/rea-update\.sh"$/m)
})

// --- Codex registration --------------------------------------------------------

function renderCodex(toolVersions, homeName = 'home') {
  const base = mkdtempSync(join(tmpdir(), 'rea-codex-'))
  const src = join(base, 'src')
  const home = join(base, homeName)
  mkdirSync(home)
  mkdirSync(src)
  cpSync(join(SOURCE, 'dot_codex'), join(src, 'dot_codex'), { recursive: true })
  writeFileSync(join(src, 'dot_tool-versions'), toolVersions)
  try {
    return spawnSync('chezmoi', ['--source', src, '--destination', home, 'cat', join(home, '.codex/config.toml')], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: home },
    })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

test('codex: renders the exact entry rea setup writes, at the pinned Node', () => {
  const r = renderCodex('python 3.14.6t\nnodejs 26.4.0\ngolang 1.26.4\n')
  assert.ifError(r.error)
  assert.equal(r.status, 0, r.stderr)
  const block = r.stdout.slice(r.stdout.indexOf('[mcp_servers.rea]'))
  assert.match(block, /^\[mcp_servers\.rea\]\ncommand = "\/.+\/\.asdf\/installs\/nodejs\/26\.4\.0\/bin\/rea"\nargs = \[ "mcp" \]\nstartup_timeout_sec = 30\n/)
  // The durable prefs above it survive the move to a template.
  assert.match(r.stdout, /^approval_policy = "never"$/m)
})

test('codex: follows a Node bump in dot_tool-versions', () => {
  const r = renderCodex('nodejs   28.0.1\n')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /\/nodejs\/28\.0\.1\/bin\/rea"/)
})

test('codex: fails the render when no Node is pinned (never a //bin/rea path)', () => {
  const r = renderCodex('python 3.14.6t\n')
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /pins no nodejs version/)
})

test('codex: the real dot_tool-versions pins the Node the entry needs', () => {
  assert.match(read('dot_tool-versions'), /^nodejs \S+$/m)
})

// asdf's .tool-versions allows tabs, extra spaces, trailing comments, CRLF line
// ends, and fallback versions after the first; asdf uses the first version.
for (const [name, tv, want] of [
  ['tab separator', 'nodejs\t26.4.0\n', '26.4.0'],
  ['trailing comment', 'nodejs 26.4.0 # LTS\n', '26.4.0'],
  ['CRLF line ends', 'python 3.14.6t\r\nnodejs 26.4.0\r\ngolang 1.26.4\r\n', '26.4.0'],
  ['fallback versions: first wins', 'nodejs 26.4.0 24.11.0 system\n', '26.4.0'],
  ['no trailing newline', 'nodejs 26.4.0', '26.4.0'],
]) {
  test(`codex: ${name} still renders .../nodejs/${want}/bin/rea`, () => {
    const r = renderCodex(tv)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, new RegExp(`^command = "/[^"\\r]+/\\.asdf/installs/nodejs/${want.replace(/\./g, '\\.')}/bin/rea"$`, 'm'))
  })
}

for (const [name, tv] of [
  ['a commented-out pin', '# nodejs 26.4.0\npython 3.14.6t\n'],
  ['a different tool whose name starts with nodejs', 'nodejs-lts 26.4.0\n'],
  ['an empty file', ''],
]) {
  test(`codex: ${name} counts as no Node pin and fails the render`, () => {
    const r = renderCodex(tv)
    assert.notEqual(r.status, 0, r.stdout)
    assert.match(r.stderr, /pins no nodejs version/)
  })
}

test('codex: a home dir with spaces and non-ASCII lands verbatim inside the TOML string', () => {
  const r = renderCodex('nodejs 26.4.0\n', 'Ränd all ☁️')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^command = "\/.+\/Ränd all ☁️\/\.asdf\/installs\/nodejs\/26\.4\.0\/bin\/rea"$/m)
})

test('codex: exactly one [mcp_servers.rea] table, and it is the last table (keys cannot leak into another)', () => {
  const r = renderCodex(read('dot_tool-versions'))
  assert.equal(r.status, 0, r.stderr)
  const tables = r.stdout.split('\n').filter((l) => /^\[/.test(l))
  assert.equal(tables.filter((t) => t === '[mcp_servers.rea]').length, 1, tables.join('\n'))
  assert.equal(tables.at(-1), '[mcp_servers.rea]', tables.join('\n'))
})
