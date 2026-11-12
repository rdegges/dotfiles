// The always-on Claude Code Remote Control server: its wrapper
// (dot_cron/executable_claude-remote-control.sh.tmpl), its restart script
// (run_onchange_after_restart-claude-remote-control.sh.tmpl), and its work gate.
// Its plist, the shared template's `service` key, and the loader's service rules
// are tested in tests/cron/launch-agents.test.mjs.
//
// Run from the repo root (chezmoi, python3, and bash are needed; without them
// these tests FAIL, they do not skip):
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'apt-get update -qq && apt-get install -y -qq zsh >/dev/null &&
//      sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin &&
//      node --test tests/cron/'
//
// What a pass proves, with stub claude, scutil, plutil (reads the JSON file and
// the dotted key path like the real one), himalaya (like 1.2.0: the message on
// stdin, a panic on an empty stdin), launchctl, and find, with the wrapper itself run by
// Debian sh (dash) and by bash --posix (and by a bash 3.2 `sh`, as macOS
// /bin/sh, when CRC_MACOS_SH names one), started the way the plist starts it
// (`exec ... >> log 2>&1`):
// - the wrapper starts claude in ~/Code with exactly
//   `remote-control --name <LocalHostName> --spawn same-dir --permission-mode
//   bypassPermissions`, and that mode equals permissions.defaultMode in
//   dot_claude/settings.json;
// - each preflight fails closed with a marker and never starts claude: claude
//   not on PATH, LocalHostName empty, failing, or not a plain name, ~/Code
//   missing, and ~/Code not trusted, absent, or unreadable in ~/.claude.json
//   (also when only ~ is trusted), and a HOME with a dot (no plutil call);
// - a TERM goes on to claude, and the wrapper then exits 0 and writes no
//   marker; claude still running after the settle time clears the marker and
//   touches .ok; any other exit writes the marker with claude's exit code and
//   the last 20 log lines (cleaned by `lines` from dot_cron/lib/text.sh: each
//   one printable ASCII, at most 300 bytes, no color-code fragments) and exits
//   with that code, also when claude dies after the settle time in the same
//   run (one ok, then the down mail; .ok stays); the dot_zshrc banner prints
//   that marker whole;
// - with lib/text.sh missing or not parsing, the wrapper writes the marker
//   ("cannot load"), exits 1, and never starts claude or mails; a lib cut short
//   after oneline (no lines) still leaves the failure reason in the marker;
// - a log over 10 MB is emptied at start, a smaller one is kept;
// - on the homelab render only, one mail goes out when the server goes down
//   and one when it is back (not one per crash-loop restart, also across
//   down -> up -> down), and a failed send writes the marker and is retried on
//   the next change; the other render never calls himalaya;
// - the restart script renders only on darwin with work false, its hash header
//   changes with the agent, the shared template, and the rendered wrapper
//   (homelab flip included); it boots out and bootstraps the service when no
//   file in the ~/Code transcript folder (named by Claude Code 2.1.322's rule)
//   changed in 20 minutes, defers with exit 1 and a marker when one did, when
//   find fails, or when the folder name cannot be derived, skips a disabled
//   service with exit 0, fails with a marker when a bootout leaves it
//   loaded for 10s, and never restarts from inside the service; under a
//   real `chezmoi apply`, a deferred restart runs again on the next apply.
// What a pass does not prove: that the real server registers with claude.ai
// under that name, the real trust prompt or ~/.claude.json format beyond
// hasTrustDialogAccepted, real launchd KeepAlive and throttle timing, that the
// server reconnects after sleep or wake, real plutil or scutil output, Apple's own
// /bin/sh build (CRC_MACOS_SH is a Linux build of bash 3.2.57), or real mail
// delivery. Those are the rollout checks on each Mac.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, chmodSync, rmSync, readdirSync, cpSync, appendFileSync, utimesSync, statSync, realpathSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const SOURCE = new URL('../../', import.meta.url).pathname
const read = (p) => readFileSync(join(SOURCE, p), 'utf8')
const WRAPPER = 'dot_cron/executable_claude-remote-control.sh.tmpl'
const RESTART = 'run_onchange_after_restart-claude-remote-control.sh.tmpl'
const AGENT = 'private_Library/LaunchAgents/com.rdegges.claude-remote-control.plist.tmpl'
const LOADER = 'run_onchange_after_load-launch-agents.sh.tmpl'
const LABEL = 'com.rdegges.claude-remote-control'
const SYS_PATH = '/usr/bin:/bin'
const LIB = join(SOURCE, 'dot_cron/lib/text.sh')

function execTemplate(input, { source = SOURCE, data } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'crc-tmpl-'))
  try {
    const args = ['--source', source, '--destination', home]
    if (data) args.push('--override-data', JSON.stringify(data))
    const r = spawnSync('chezmoi', [...args, 'execute-template'], { encoding: 'utf8', input, env: { PATH: process.env.PATH, HOME: home } })
    assert.ifError(r.error)
    assert.equal(r.status, 0, `chezmoi execute-template exited ${r.status}: ${r.stderr}`)
    return r.stdout
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

const DARWIN = { chezmoi: { os: 'darwin' } }
const renderWrapper = (homelab) => execTemplate(read(WRAPPER), { data: { ...DARWIN, work: false, homelab } })

// --- Stubs -------------------------------------------------------------------------

// claude: records its cwd, its pid, the binary of its parent (the shell that
// runs the wrapper; Linux /proc only), its argv (one per line, written last),
// and the signals it gets.
// STUB_CLAUDE=run stays up until TERM, or until $STATE/die exists, then exits
// STUB_DIE_RC (a crash after the settle time); STUB_CLAUDE=exit prints
// STUB_CLAUDE_LINES numbered lines and then exits with STUB_CLAUDE_RC.
const CLAUDE =
  '#!/bin/sh\n' +
  'pwd > "$STATE/claude.cwd"\n' +
  'echo $$ > "$STATE/claude.pid"\n' +
  'readlink "/proc/$PPID/exe" > "$STATE/claude.parent" 2>/dev/null || :\n' +
  'printf "%s\\n" "$@" > "$STATE/claude.args.tmp"; mv "$STATE/claude.args.tmp" "$STATE/claude.args"\n' +
  'case "${STUB_CLAUDE:-run}" in\n' +
  'run)\n' +
  '  trap \'echo TERM >> "$STATE/claude.signals"; exit 0\' TERM\n' +
  '  echo "stub claude: Remote Control ready"\n' +
  '  while :; do [ -e "$STATE/die" ] && { echo "stub claude: connection lost"; exit "${STUB_DIE_RC:-4}"; }; sleep 0.1; done ;;\n' +
  'exit)\n' +
  '  i=1; while [ "$i" -le "${STUB_CLAUDE_LINES:-3}" ]; do echo "stub claude line $i"; i=$((i + 1)); done\n' +
  '  [ -z "${STUB_CLAUDE_TEXT:-}" ] || printf "%s\\n" "$STUB_CLAUDE_TEXT"\n' +
  '  exit "${STUB_CLAUDE_RC:-1}" ;;\n' +
  'esac\n'

// plutil -extract <keypath> raw -o - <file>: walk the dotted key path in the
// JSON file, as the real plutil does (a dot always separates keys).
const PLUTIL =
  '#!/usr/bin/env python3\n' +
  'import json, os, sys\n' +
  'open(os.environ["CALLS"], "a").write("plutil " + " ".join(sys.argv[1:]) + "\\n")\n' +
  'a = sys.argv[1:]\n' +
  'if len(a) != 6 or a[0] != "-extract" or a[2:5] != ["raw", "-o", "-"]: sys.exit(64)\n' +
  'kp, f = a[1], a[5]\n' +
  'try:\n' +
  '    v = json.load(open(f))\n' +
  'except FileNotFoundError:\n' +
  '    sys.stderr.write(f + ": file does not exist or is not readable or is not a regular file (Error Domain=NSCocoaErrorDomain Code=260)\\n"); sys.exit(1)\n' +
  'except ValueError:\n' +
  '    sys.stderr.write(f + ": Property List error: Unexpected character\\n"); sys.exit(1)\n' +
  'for k in kp.split("."):\n' +
  '    if not isinstance(v, dict) or k not in v:\n' +
  '        sys.stderr.write(f + ": Could not extract value, error: No value at that key path or invalid key path: " + kp + "\\n"); sys.exit(1)\n' +
  '    v = v[k]\n' +
  'if isinstance(v, bool): print("true" if v else "false")\n' +
  'elif isinstance(v, (str, int, float)): print(v)\n' +
  'else: sys.stderr.write(f + ": Could not extract value: raw is only for scalars\\n"); sys.exit(1)\n'

const STUBS = {
  claude: CLAUDE,
  plutil: PLUTIL,
  scutil:
    '#!/bin/sh\necho "scutil $*" >> "$CALLS"\n' +
    '[ "$*" = "--get LocalHostName" ] || exit 64\n' +
    '[ -n "${STUB_SCUTIL_FAIL:-}" ] && { echo "LocalHostName: not set" >&2; exit 1; }\n' +
    'printf "%s\\n" "${STUB_HOST-testhost}"\n',
  // As in tests/cron/tailscale-watchdog.test.mjs: like himalaya 1.2.0.
  himalaya:
    '#!/bin/sh\necho "himalaya $1 $2 $3 $4 ($# args)" >> "$CALLS"\n' +
    'cat > "$STATE/stdin.tmp"\n' +
    'if [ ! -s "$STATE/stdin.tmp" ]; then\n' +
    '  printf "The application panicked (crashed).\\nMessage:  index out of bounds: the len is 0 but the index is 0\\n" >&2\n' +
    '  exit 101\n' +
    'fi\n' +
    'if [ "${STUB_MAIL_RC:-0}" != 0 ]; then echo "cannot send message: smtp connection refused" >&2; exit "$STUB_MAIL_RC"; fi\n' +
    'n=$(ls "$STATE" | grep -c "^mail\\.")\nmv "$STATE/stdin.tmp" "$STATE/mail.$((n + 1))"\n',
}

// The shells that run the wrapper itself. The plist's `exec "$0"` goes through
// the #!/bin/sh line, so a shell named only as the outer `-c` shell never runs
// the wrapper: each variant here execs the wrapper with that shell. 'sh' is the
// plist's own path (Debian /bin/sh, dash). 'macos-sh' is a bash 3.2 binary
// started under the name sh (POSIX mode), as macOS /bin/sh is; it runs only
// when CRC_MACOS_SH names one (a symlink called sh), and skips otherwise. To
// build one in the Docker run: apt-get install bison, then bash-3.2.57 from
// ftp.gnu.org with CC="gcc -std=gnu89 -fpermissive -Wno-error
// -Wno-implicit-function-declaration -Wno-int-conversion
// -Wno-incompatible-pointer-types -Wno-implicit-int -Wno-return-mismatch".
const MACOS_SH = process.env.CRC_MACOS_SH
const WRAPPER_SHELLS = {
  sh: null,
  'bash --posix': ['bash', '--posix'],
  'macos-sh': MACOS_SH ? [MACOS_SH] : null,
}
const shellSkip = (shell) => (shell === 'macos-sh' && !(MACOS_SH && existsSync(MACOS_SH)) ? 'CRC_MACOS_SH does not name a bash 3.2 `sh` (see WRAPPER_SHELLS)' : false)
// The binary that must be the wrapper's process for that variant.
const shellBinary = (shell) => realpathSync(shell === 'sh' ? '/bin/sh' : shell === 'macos-sh' ? MACOS_SH : spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim())

// lib: 'ok' (the real lib/text.sh next to the wrapper, as chezmoi deploys it),
// 'missing', 'syntax', or 'no-lines' (the real lib cut short before lines).
function wrapperSandbox({ homelab = false, trusted = { Code: true }, code = true, stubs = Object.keys(STUBS), lib = 'ok', homeName = 'home dir' } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'crc-'))
  const home = join(base, homeName)
  const bin = join(base, 'bin')
  const state = join(base, 'state')
  for (const d of [home, bin, state]) mkdirSync(d)
  if (code) mkdirSync(join(home, 'Code'))
  for (const s of stubs) {
    writeFileSync(join(bin, s), STUBS[s])
    chmodSync(join(bin, s), 0o755)
  }
  const projects = {}
  for (const [dir, v] of Object.entries(trusted ?? {})) projects[dir === '~' ? home : join(home, dir)] = { hasTrustDialogAccepted: v, allowedTools: [], lastCost: null }
  if (trusted !== null) writeFileSync(join(home, '.claude.json'), JSON.stringify({ numStartups: 3, projects }))
  const script = join(base, 'claude-remote-control.sh')
  writeFileSync(script, renderWrapper(homelab))
  chmodSync(script, 0o755)
  if (lib !== 'missing') {
    mkdirSync(join(base, 'lib'))
    const text = readFileSync(LIB, 'utf8')
    writeFileSync(join(base, 'lib', 'text.sh'), lib === 'syntax' ? 'oneline() {\n' : lib === 'no-lines' ? text.split('\nlines()')[0] : text)
  }
  const calls = join(base, 'calls')
  writeFileSync(calls, '')
  const logs = join(home, '.cron', 'logs')
  mkdirSync(logs, { recursive: true })
  const log = join(logs, 'claude-remote-control.log')
  const env = (extra) => ({ HOME: home, PATH: `${bin}:${SYS_PATH}`, CALLS: calls, STATE: state, CLAUDE_REMOTE_CONTROL_SETTLE: '30', ...extra })
  // The plist's command: the wrapper becomes this process and appends to its log.
  const argv = ['-c', 'exec "$0" >> "$HOME/.cron/logs/claude-remote-control.log" 2>&1', script]
  // Another shell variant: the same redirect, with the wrapper run by that shell.
  const argvFor = (shell) =>
    WRAPPER_SHELLS[shell] ? ['-c', 'exec "$@" "$0" >> "$HOME/.cron/logs/claude-remote-control.log" 2>&1', script, ...WRAPPER_SHELLS[shell]] : argv
  const started = []
  return {
    base,
    home,
    bin,
    state,
    logs,
    log,
    marker: join(logs, 'claude-remote-control.FAILED'),
    stamp: join(logs, 'claude-remote-control.ok'),
    statefile: join(logs, 'claude-remote-control.state'),
    calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    logText: () => (existsSync(log) ? readFileSync(log, 'utf8') : ''),
    claudeArgs: () => (existsSync(join(state, 'claude.args')) ? readFileSync(join(state, 'claude.args'), 'utf8').split('\n').slice(0, -1) : null),
    claudeSignals: () => (existsSync(join(state, 'claude.signals')) ? readFileSync(join(state, 'claude.signals'), 'utf8') : ''),
    // The variant really ran the wrapper: claude's parent is that shell's binary
    // (checked where /proc exists, as in the Docker run).
    assertShell(shell) {
      if (!existsSync('/proc/self/exe')) return
      assert.equal(readFileSync(join(state, 'claude.parent'), 'utf8').trim(), shellBinary(shell), `the wrapper did not run under ${shell}`)
    },
    mails: () =>
      readdirSync(state)
        .filter((f) => f.startsWith('mail.'))
        .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
        .map((f) => readFileSync(join(state, f), 'utf8')),
    resetClaude: () => ['claude.args', 'claude.cwd', 'claude.pid', 'claude.signals'].forEach((f) => rmSync(join(state, f), { force: true })),
    // A run that ends by itself (preflight failure, claude exits).
    run(extra = {}, shell = 'sh') {
      const r = spawnSync('sh', argvFor(shell), { encoding: 'utf8', env: env(extra), timeout: 60000 })
      assert.ifError(r.error)
      return r
    },
    // A run that stays up: returns the child and a promise of its exit.
    start(extra = {}, shell = 'sh') {
      const child = spawn('sh', argvFor(shell), { env: env(extra), stdio: 'ignore' })
      started.push(child)
      const exit = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
      return { child, exit }
    },
    // A failed assertion must not leave the wrapper and the stub running, or
    // node never exits.
    cleanup() {
      for (const c of started) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
      const pid = join(state, 'claude.pid')
      if (existsSync(pid)) try { process.kill(Number(readFileSync(pid, 'utf8')), 'SIGKILL') } catch {}
      rmSync(base, { recursive: true, force: true })
    },
  }
}

async function withWrapper(opts, fn) {
  const sb = wrapperSandbox(opts)
  try {
    return await fn(sb)
  } finally {
    sb.cleanup()
  }
}

// The exit of a started wrapper, or a failure after `ms` (so a wrapper that
// does not stop fails the test, and cleanup still kills it).
function exited(exit, ms = 15000) {
  let timer
  return Promise.race([exit, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`the wrapper did not exit within ${ms}ms`)), ms)))]).finally(() => clearTimeout(timer))
}

async function until(cond, what, ms = 15000) {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

const subject = (mail) => mail.match(/^Subject: (.*)$/m)[1]
const MARKER_LINE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} claude-remote-control: .* \(see ~\/\.cron\/logs\/claude-remote-control\.log\)$/

function assertFailed(sb, r, reason, code = 1) {
  assert.equal(r.status, code, sb.logText())
  const m = readFileSync(sb.marker, 'utf8')
  assert.match(m.split('\n')[0], MARKER_LINE)
  assert.match(m.split('\n')[0], reason)
  assert.match(sb.logText(), /claude-remote-control: FAILED: /)
  return m
}

const WANT_ARGS = ['remote-control', '--name', 'testhost', '--spawn', 'same-dir', '--permission-mode', 'bypassPermissions']

// --- The command it runs ---------------------------------------------------------------

test('wrapper: --permission-mode equals permissions.defaultMode in dot_claude/settings.json (they cannot drift)', () => {
  const mode = JSON.parse(read('dot_claude/settings.json')).permissions.defaultMode
  const lines = read(WRAPPER).split('\n').filter((l) => /^claude remote-control /.test(l))
  assert.equal(lines.length, 1, lines.join('\n'))
  assert.equal(lines[0].match(/--permission-mode (\S+)/)[1], mode)
})

test('wrapper: renders mail=1 only for homelab true; both renders parse under sh -n and bash -n', () => {
  for (const [homelab, want] of [[true, 'mail=1'], [false, 'mail=0'], [undefined, 'mail=0']]) {
    const data = { ...DARWIN, work: false }
    if (homelab !== undefined) data.homelab = homelab
    const s = execTemplate(read(WRAPPER), { data })
    assert.deepEqual(s.split('\n').filter((l) => l.startsWith('mail=')), [want])
    for (const sh of ['sh', 'bash']) assert.equal(spawnSync(sh, ['-n'], { input: s }).status, 0, sh)
  }
})

for (const shell of Object.keys(WRAPPER_SHELLS)) {
  test(`wrapper (${shell}): preflight passes; claude runs in ~/Code with the exact argv; a TERM stops it, exit 0, no marker, no mail`, { skip: shellSkip(shell) }, () =>
    withWrapper({ homelab: true }, async (sb) => {
      const { child, exit } = sb.start({}, shell)
      await until(() => sb.claudeArgs() && /Remote Control ready/.test(sb.logText()), 'claude to start')
      assert.deepEqual(sb.claudeArgs(), WANT_ARGS)
      assert.equal(readFileSync(join(sb.state, 'claude.cwd'), 'utf8').trim(), join(sb.home, 'Code'))
      sb.assertShell(shell)
      child.kill('SIGTERM')
      const { code, signal } = await exited(exit)
      assert.equal(signal, null)
      assert.equal(code, 0, sb.logText())
      assert.equal(sb.claudeSignals(), 'TERM\n', 'claude did not get the TERM')
      assert.equal(existsSync(sb.marker), false)
      assert.equal(existsSync(sb.stamp), false, 'stopped before the settle time, but .ok was touched')
      assert.deepEqual(sb.mails(), [])
      assert.match(sb.logText(), /claude-remote-control: stopped \(claude exit 0\)/)
    }))
}

test('wrapper: an INT also goes on to claude and stops cleanly', () =>
  withWrapper({}, async (sb) => {
    const { child, exit } = sb.start()
    await until(() => sb.claudeArgs(), 'claude to start')
    child.kill('SIGINT')
    assert.equal((await exited(exit)).code, 0, sb.logText())
    assert.equal(sb.claudeSignals(), 'TERM\n')
    assert.equal(existsSync(sb.marker), false)
  }))

test('wrapper: still running after the settle time: the old marker is removed and .ok touched; a later TERM leaves no marker', () =>
  withWrapper({}, async (sb) => {
    writeFileSync(sb.marker, 'old failure\n')
    const { child, exit } = sb.start({ CLAUDE_REMOTE_CONTROL_SETTLE: '1' })
    await until(() => existsSync(sb.stamp), '.ok')
    assert.equal(existsSync(sb.marker), false)
    assert.match(sb.logText(), /claude-remote-control: ok: running for 1s/)
    child.kill('SIGTERM')
    assert.equal((await exited(exit)).code, 0)
    assert.equal(existsSync(sb.marker), false)
    assert.equal(existsSync(sb.statefile), false, 'the non-homelab render keeps no mail state')
  }))

test('wrapper: a marker from an earlier failure stays while the server has run for less than the settle time', () =>
  withWrapper({}, async (sb) => {
    writeFileSync(sb.marker, 'old failure\n')
    const { child, exit } = sb.start()
    await until(() => sb.claudeArgs(), 'claude to start')
    await sleep(500)
    assert.equal(readFileSync(sb.marker, 'utf8'), 'old failure\n')
    child.kill('SIGTERM')
    assert.equal((await exited(exit)).code, 0)
    assert.equal(readFileSync(sb.marker, 'utf8'), 'old failure\n', 'a stop changed the marker')
  }))

// --- An exit nobody asked for -------------------------------------------------------------

for (const shell of Object.keys(WRAPPER_SHELLS)) {
  test(`wrapper (${shell}): claude exits 3 by itself: marker with the exit code and the last 20 log lines, exit 3`, { skip: shellSkip(shell) }, () =>
    withWrapper({}, async (sb) => {
      const r = sb.run({ STUB_CLAUDE: 'exit', STUB_CLAUDE_RC: '3', STUB_CLAUDE_LINES: '25' }, shell)
      const m = assertFailed(sb, r, /claude remote-control exited \(exit 3\)/, 3)
      const lines = m.trimEnd().split('\n')
      assert.equal(lines.length, 21, m)
      assert.deepEqual(lines.slice(-5), [21, 22, 23, 24, 25].map((i) => `  | stub claude line ${i}`))
      assert.ok(!lines.includes('  | stub claude line 5'), 'more than the last 20 lines')
      sb.assertShell(shell)
      assert.equal(existsSync(sb.stamp), false)
    }))
}

for (const shell of Object.keys(WRAPPER_SHELLS)) {
  test(`wrapper (${shell}): claude killed by a signal (exit 137) is a failure with that code`, { skip: shellSkip(shell) }, () =>
    withWrapper({}, async (sb) => {
      const { exit } = sb.start({}, shell)
      await until(() => sb.claudeArgs(), 'claude to start')
      sb.assertShell(shell)
      process.kill(Number(readFileSync(join(sb.state, 'claude.pid'), 'utf8')), 'SIGKILL')
      const { code } = await exited(exit)
      assert.equal(code, 137, sb.logText())
      assert.match(readFileSync(sb.marker, 'utf8'), /claude remote-control exited \(exit 137\)/)
    }))

  // The supervisor's one path where the USR1 timer cuts a wait short and the
  // loop must go back to waiting on a live claude, then still catch its exit.
  test(`wrapper (${shell}, homelab): healthy once, then claude dies by itself in the same run: exactly one ok, down mail, marker with its last lines, .ok kept, exit 4`, { skip: shellSkip(shell) }, () =>
    withWrapper({ homelab: true }, async (sb) => {
      const { exit } = sb.start({ CLAUDE_REMOTE_CONTROL_SETTLE: '1' }, shell)
      await until(() => existsSync(sb.stamp), '.ok')
      sb.assertShell(shell)
      assert.equal(readFileSync(sb.statefile, 'utf8'), 'up\n')
      await sleep(1500)
      assert.equal(sb.logText().match(/claude-remote-control: ok: running for 1s/g).length, 1, sb.logText())
      writeFileSync(join(sb.state, 'die'), '')
      const { code, signal } = await exited(exit)
      assert.equal(signal, null)
      assert.equal(code, 4, sb.logText())
      const m = readFileSync(sb.marker, 'utf8')
      assert.match(m.split('\n')[0], MARKER_LINE)
      assert.match(m.split('\n')[0], /claude remote-control exited \(exit 4\)/)
      assert.match(m, /^ {2}\| stub claude: connection lost$/m)
      assert.ok(existsSync(sb.stamp), '.ok is the last healthy time; a later crash does not remove it')
      assert.deepEqual(sb.mails().map(subject), ['Claude Remote Control is down on testhost'])
      assert.equal(readFileSync(sb.statefile, 'utf8'), 'down\n')
      assert.equal(sb.claudeSignals(), '', 'the wrapper signalled claude')
    }))
}

test('wrapper: claude exits 0 by itself: still a failure (launchd starts it again), exit 0', () =>
  withWrapper({}, async (sb) => {
    assertFailed(sb, sb.run({ STUB_CLAUDE: 'exit', STUB_CLAUDE_RC: '0' }), /exited \(exit 0\)/, 0)
  }))

test('wrapper: log lines with escape sequences, CR, and non-ASCII reach the marker cleaned by lines, each cut at 300', () =>
  withWrapper({}, async (sb) => {
    const text = '\x1b[31mréseau ☁ down\x07\x1b[0m \x1b]0;title\x07\x1b[38:5:196mred\r [31m raw ' + 'y'.repeat(400)
    sb.run({ STUB_CLAUDE: 'exit', STUB_CLAUDE_TEXT: text })
    const m = readFileSync(sb.marker)
    assert.ok(m.every((b) => b === 0x0a || (b >= 0x20 && b <= 0x7e)), m.toString())
    const lines = m.toString('latin1').trimEnd().split('\n')
    assert.equal(lines.at(-1), '  | ' + ('rseau  down red  [31m raw ' + 'y'.repeat(400)).slice(0, 300))
    assert.deepEqual(lines.slice(-4, -1), [1, 2, 3].map((i) => `  | stub claude line ${i}`))
    assert.ok(lines.every((l) => l.length <= 304), 'a line is over 300 bytes after the prefix')
  }))

for (const shell of Object.keys(WRAPPER_SHELLS)) {
  for (const lib of ['missing', 'syntax']) {
    test(`wrapper (${shell}): a ${lib} lib/text.sh writes the marker ("cannot load"), exits 1, never starts claude, never mails`, { skip: shellSkip(shell) }, () =>
      withWrapper({ homelab: true, lib }, async (sb) => {
        const r = sb.run({}, shell)
        assert.equal(r.status, 1, sb.logText())
        assert.match(readFileSync(sb.marker, 'utf8'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} claude-remote-control: cannot load ~\/\.cron\/lib\/text\.sh; run chezmoi apply\n$/)
        assert.match(sb.logText(), /^claude-remote-control: cannot load .*\/lib\/text\.sh$/m)
        assert.equal(sb.claudeArgs(), null, 'claude was started')
        assert.deepEqual(sb.calls().filter((c) => c.startsWith('himalaya')), [])
      }))
  }
}

// The first multi-line marker: every line must reach a new shell, cleaned.
const hasZsh = spawnSync('sh', ['-c', 'command -v zsh']).status === 0
test('wrapper: the multi-line marker shows whole in the dot_zshrc banner, first line prefixed, no control characters', { skip: hasZsh ? false : 'zsh not installed (see the run command at the top)' }, () =>
  withWrapper({}, async (sb) => {
    sb.run({ STUB_CLAUDE: 'exit', STUB_CLAUDE_RC: '3', STUB_CLAUDE_TEXT: '\x1b[31mlast\x1b[0m words' })
    const m = readFileSync(sb.marker, 'utf8')
    const line = read('dot_zshrc')
      .split('\n')
      .find((l) => l.includes('.FAILED') && !l.trimStart().startsWith('#'))
    const r = spawnSync('zsh', ['-f', '-c', line], { encoding: 'utf8', env: { HOME: sb.home, PATH: SYS_PATH } })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, `\x1b[31mcron: ${m.trimEnd()}\x1b[0m\n`)
    assert.match(r.stdout, /\n {2}\| last words\x1b\[0m\n$/)
  }))

test('wrapper: a lib cut short before lines still leaves the failure reason in the marker', () =>
  withWrapper({ lib: 'no-lines' }, async (sb) => {
    assertFailed(sb, sb.run({ STUB_CLAUDE: 'exit', STUB_CLAUDE_RC: '3' }), /claude remote-control exited \(exit 3\)/, 3)
  }))

// --- Preflight ------------------------------------------------------------------------------

function assertPreflight(sb, r, reason) {
  assertFailed(sb, r, reason)
  assert.equal(sb.claudeArgs(), null, 'claude was started')
}

test('preflight: claude not on PATH', () =>
  withWrapper({ stubs: ['plutil', 'scutil', 'himalaya'] }, async (sb) =>
    assertPreflight(sb, sb.run(), /claude is not on PATH \(.*\); install Claude Code/)))

test('preflight: LocalHostName empty, failing, or not a plain host name (ASCII-only marker)', () =>
  withWrapper({}, async (sb) => {
    for (const env of [{ STUB_HOST: '' }, { STUB_SCUTIL_FAIL: '1' }, { STUB_HOST: 'mac-server (3)' }, { STUB_HOST: 'mäc' }, { STUB_HOST: 'a;rm -rf' }]) {
      const m = assertFailed(sb, sb.run(env), /`scutil --get LocalHostName` gave '.*', not a plain host name/)
      assert.ok([...readFileSync(sb.marker)].every((b) => b < 0x80), m)
      assert.equal(sb.claudeArgs(), null)
    }
  }))

test('preflight: ~/Code missing', () =>
  withWrapper({ code: false }, async (sb) =>
    assertPreflight(sb, sb.run(), /\/Code is missing: create it, then run `claude` in ~\/Code once and accept the trust prompt/)))

test('preflight: a HOME with a dot cannot be checked (plutil splits the key path at dots): fails closed, plutil never runs', () =>
  withWrapper({ homeName: 'r.degges' }, async (sb) => {
    assertPreflight(sb, sb.run(), /cannot check the trust of .*\/r\.degges\/Code: the path has a dot/)
    assert.deepEqual(sb.calls().filter((c) => c.startsWith('plutil')), [])
  }))

const TRUST = /run `claude` in ~\/Code once and accept the trust prompt, or the trust check cannot read ~\/\.claude\.json \(plutil: /
for (const [name, trusted] of [
  ['~/Code trusted: false', { Code: false }],
  ['only ~ trusted (Claude Code never stores that)', { '~': true }],
  ['~/Code not in projects', {}],
  ['the value is not a boolean', { Code: { yes: true } }],
  ['no ~/.claude.json', null],
]) {
  test(`preflight: trust fails closed: ${name}`, () =>
    withWrapper({ trusted }, async (sb) => assertPreflight(sb, sb.run(), TRUST)))
}

test('preflight: an unreadable (not JSON) ~/.claude.json fails closed, and it is never written', () =>
  withWrapper({}, async (sb) => {
    const f = join(sb.home, '.claude.json')
    writeFileSync(f, '{"projects": ')
    const before = statSync(f).mtimeMs
    assertPreflight(sb, sb.run(), TRUST)
    assert.equal(readFileSync(f, 'utf8'), '{"projects": ')
    assert.equal(statSync(f).mtimeMs, before)
  }))

test('preflight: the trust check reads projects["$HOME/Code"].hasTrustDialogAccepted with plutil, read-only', () =>
  withWrapper({}, async (sb) => {
    const f = join(sb.home, '.claude.json')
    const before = readFileSync(f, 'utf8')
    const { child, exit } = sb.start()
    await until(() => sb.claudeArgs(), 'claude to start')
    child.kill('SIGTERM')
    await exited(exit)
    assert.deepEqual(sb.calls().filter((c) => c.startsWith('plutil')), [`plutil -extract projects.${sb.home}/Code.hasTrustDialogAccepted raw -o - ${f}`])
    assert.equal(readFileSync(f, 'utf8'), before)
  }))

test('preflight: a fixed failure starts claude on the next run (A->B->A: untrusted, trusted, untrusted)', () =>
  withWrapper({ trusted: { Code: false } }, async (sb) => {
    assertPreflight(sb, sb.run(), TRUST)
    const f = join(sb.home, '.claude.json')
    writeFileSync(f, readFileSync(f, 'utf8').replace('"hasTrustDialogAccepted":false', '"hasTrustDialogAccepted":true'))
    const { child, exit } = sb.start({ CLAUDE_REMOTE_CONTROL_SETTLE: '1' })
    await until(() => existsSync(sb.stamp), '.ok')
    assert.equal(existsSync(sb.marker), false)
    child.kill('SIGTERM')
    await exited(exit)
    writeFileSync(f, readFileSync(f, 'utf8').replace('"hasTrustDialogAccepted":true', '"hasTrustDialogAccepted":false'))
    sb.resetClaude()
    assertPreflight(sb, sb.run(), TRUST)
  }))

// --- Log size ---------------------------------------------------------------------------------

test('log: over 10 MB at start, it is emptied; at 10 MB or less it is kept and appended to', () =>
  withWrapper({ trusted: { Code: false } }, async (sb) => {
    writeFileSync(sb.log, 'x'.repeat(10485760))
    sb.run()
    let text = sb.logText()
    assert.ok(text.startsWith('x'.repeat(100)) && text.length > 10485760, 'a 10 MB log was emptied')
    appendFileSync(sb.log, 'x'.repeat(10))
    sb.run()
    text = sb.logText()
    assert.ok(text.length < 10000, `log is ${text.length} bytes`)
    assert.match(text, /^claude-remote-control: the log was over 10 MB; emptied it\n/)
  }))

// --- Homelab mail -----------------------------------------------------------------------------

test('mail (homelab): down mails once across a crash loop; back mails once; down again mails again (A->B->A)', () =>
  withWrapper({ homelab: true }, async (sb) => {
    for (let i = 0; i < 3; i++) assertFailed(sb, sb.run({ STUB_CLAUDE: 'exit', STUB_CLAUDE_RC: '2' }), /exited \(exit 2\)/, 2)
    let mails = sb.mails()
    assert.deepEqual(mails.map(subject), ['Claude Remote Control is down on testhost'])
    assert.match(mails[0], /^From: r@rdegges\.com\nTo: r@rdegges\.com\nSubject: /)
    assert.match(mails[0], /Reason: claude remote-control exited \(exit 2\)/)
    assert.match(mails[0], /Last log lines:\n {2}\| /)
    assert.equal(readFileSync(sb.statefile, 'utf8'), 'down\n')
    assert.ok(sb.calls().filter((c) => c.startsWith('himalaya')).every((c) => c === 'himalaya message send -a icloud (4 args)'))

    const { child, exit } = sb.start({ CLAUDE_REMOTE_CONTROL_SETTLE: '1' })
    await until(() => existsSync(sb.stamp), '.ok')
    child.kill('SIGTERM')
    await exited(exit)
    mails = sb.mails()
    assert.deepEqual(mails.map(subject), ['Claude Remote Control is down on testhost', 'Claude Remote Control is back on testhost'])
    assert.equal(readFileSync(sb.statefile, 'utf8'), 'up\n')
    assert.equal(existsSync(sb.marker), false)

    assertFailed(sb, sb.run({ STUB_HOST: '' }), /not a plain host name/)
    mails = sb.mails()
    assert.equal(mails.length, 3)
    assert.equal(subject(mails[2]), 'Claude Remote Control is down on this Mac')
  }))

test('mail (homelab): a first healthy run with no state sends nothing and records up', () =>
  withWrapper({ homelab: true }, async (sb) => {
    const { child, exit } = sb.start({ CLAUDE_REMOTE_CONTROL_SETTLE: '1' })
    await until(() => existsSync(sb.stamp), '.ok')
    child.kill('SIGTERM')
    await exited(exit)
    assert.deepEqual(sb.mails(), [])
    assert.equal(readFileSync(sb.statefile, 'utf8'), 'up\n')
  }))

test('mail (homelab): a failed down mail is noted in the marker, and the next failure tries again', () =>
  withWrapper({ homelab: true, trusted: { Code: false } }, async (sb) => {
    const m = assertFailed(sb, sb.run({ STUB_MAIL_RC: '1' }), /; the alert mail failed too \(see/)
    assert.ok(m)
    assert.equal(existsSync(sb.statefile), false)
    assert.deepEqual(sb.mails(), [])
    assertFailed(sb, sb.run(), TRUST)
    assert.equal(sb.mails().length, 1)
    assert.equal(readFileSync(sb.statefile, 'utf8'), 'down\n')
  }))

test('mail (homelab): a failed back mail writes the marker and keeps the state down, so the next healthy run mails', () =>
  withWrapper({ homelab: true }, async (sb) => {
    writeFileSync(sb.statefile, 'down\n')
    let { child, exit } = sb.start({ CLAUDE_REMOTE_CONTROL_SETTLE: '1', STUB_MAIL_RC: '1' })
    await until(() => existsSync(sb.marker), 'marker')
    assert.match(readFileSync(sb.marker, 'utf8'), /the server runs again, but the recovery mail failed/)
    assert.equal(existsSync(sb.stamp), false)
    assert.equal(readFileSync(sb.statefile, 'utf8'), 'down\n')
    child.kill('SIGTERM')
    await exited(exit)
    ;({ child, exit } = sb.start({ CLAUDE_REMOTE_CONTROL_SETTLE: '1' }))
    await until(() => existsSync(sb.stamp), '.ok')
    child.kill('SIGTERM')
    await exited(exit)
    assert.deepEqual(sb.mails().map(subject), ['Claude Remote Control is back on testhost'])
    assert.equal(existsSync(sb.marker), false)
  }))

test('mail: the non-homelab render never calls himalaya and keeps no state, on failure or recovery', () =>
  withWrapper({ homelab: false }, async (sb) => {
    assertFailed(sb, sb.run({ STUB_CLAUDE: 'exit' }), /exited/)
    const { child, exit } = sb.start({ CLAUDE_REMOTE_CONTROL_SETTLE: '1' })
    await until(() => existsSync(sb.stamp), '.ok')
    child.kill('SIGTERM')
    await exited(exit)
    assert.deepEqual(sb.calls().filter((c) => c.startsWith('himalaya')), [])
    assert.equal(existsSync(sb.statefile), false)
  }))

// --- Gate ---------------------------------------------------------------------------------------

const GATED = ['Library/LaunchAgents/com.rdegges.claude-remote-control.plist', '.cron/claude-remote-control.sh']

for (const [name, extra, managed] of [['false', { work: false }, true], ['true', { work: true }, false]]) {
  test(`gate: work ${name}: chezmoi ${managed ? 'manages' : 'does not manage'} the server plist and wrapper; the restart script ${managed ? 'renders' : 'is empty'}`, () => {
    const home = mkdtempSync(join(tmpdir(), 'crc-gate-'))
    try {
      const data = JSON.stringify({ ...DARWIN, ...extra })
      const r = spawnSync('chezmoi', ['--source', SOURCE, '--destination', home, '--override-data', data, 'managed', '--include=files'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } })
      assert.equal(r.status, 0, r.stderr)
      const files = r.stdout.split('\n')
      assert.ok(files.includes('Library/LaunchAgents/com.rdegges.chezmoi.plist'), 'control')
      for (const p of GATED) assert.equal(files.includes(p), managed, p)
      const s = execTemplate(read(RESTART), { data: { ...DARWIN, ...extra } })
      assert.equal(s === '', !managed, s.slice(0, 200))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
}

// A missing `work` key: .chezmoiignore already reads `.work` (no `index`) for
// the work-only skills, so chezmoi fails on such a config before it writes
// anything. The new gates read `(index . "work")`, so the key alone never
// decides; the server's own templates treat it as false.
test('gate: work missing: the whole source fails at the existing `.work` read; the new templates read it as false', () => {
  const home = mkdtempSync(join(tmpdir(), 'crc-gate-'))
  try {
    const r = spawnSync('chezmoi', ['--source', SOURCE, '--destination', home, '--override-data', JSON.stringify(DARWIN), 'managed', '--include=files'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } })
    assert.notEqual(r.status, 0, r.stdout)
    assert.match(r.stderr, /map has no entry for key "work"/)
    assert.notEqual(execTemplate(read(RESTART), { data: DARWIN }), '')
    assert.match(execTemplate(read(WRAPPER), { data: DARWIN }), /^mail=0$/m)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('gate: the restart script is empty off darwin', () => {
  assert.equal(execTemplate(read(RESTART), { data: { chezmoi: { os: 'linux' }, work: false } }), '')
})

test('gate: every machine config has `work` (asked with promptBoolOnce), so a missing key is only an old config', () => {
  assert.match(read('.chezmoi.toml.tmpl'), /^\{\{- \$work := promptBoolOnce \. "work" "[^"]+" false -\}\}$/m)
  assert.match(read('.chezmoi.toml.tmpl'), /^ {2}work = \{\{ \$work \}\}$/m)
})

// --- Restart script ---------------------------------------------------------------------------

// launchctl: $STATE/loaded/<label> is load state; `print gui/<uid>` lists it. STUB_DISABLED / STUB_ENABLED
// fill print-disabled; STUB_PRINT_DISABLED_FAIL and STUB_BOOTSTRAP_FAIL fail. STUB_BOOTOUT_STUCK: bootout
// succeeds but the label stays loaded.
const LAUNCHCTL =
  '#!/bin/sh\n' +
  'echo "$*" >> "$CALLS"\n' +
  'dom="gui/$(id -u)"\n' +
  'case "$1" in\n' +
  'print)\n' +
  '  if [ "$2" = "$dom" ]; then echo "$dom = {"; for f in "$STATE"/loaded/*; do [ -e "$f" ] && printf "\\t\\t0\\t-\\t%s\\n" "${f##*/}"; done; echo "}"; exit 0; fi\n' +
  '  l=${2#"$dom"/}; [ "$l" != "$2" ] || exit 64; [ -e "$STATE/loaded/$l" ] || exit 113; exit 0 ;;\n' +
  'print-disabled)\n' +
  '  [ "$2" = "$dom" ] || exit 64\n' +
  '  [ -n "${STUB_PRINT_DISABLED_FAIL:-}" ] && { echo "Bad request." >&2; exit 1; }\n' +
  '  printf "\\tdisabled services = {\\n"\n' +
  '  for d in ${STUB_ENABLED:-}; do printf "\\t\\t\\"%s\\" => enabled\\n" "$d"; done\n' +
  '  for d in ${STUB_DISABLED:-}; do printf "\\t\\t\\"%s\\" => disabled\\n" "$d"; done\n' +
  '  printf "\\t}\\n"; exit 0 ;;\n' +
  'bootout) l=${2#"$dom"/}; [ -e "$STATE/loaded/$l" ] || exit 3; [ -n "${STUB_BOOTOUT_STUCK:-}" ] && exit 0; rm -f "$STATE/loaded/$l"; exit 0 ;;\n' +
  'bootstrap)\n' +
  '  [ "$2" = "$dom" ] || exit 64\n' +
  '  l=$(basename "$3" .plist); [ -f "$3" ] || exit 5\n' +
  '  [ -n "${STUB_BOOTSTRAP_FAIL:-}" ] && { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; }\n' +
  '  [ -e "$STATE/loaded/$l" ] && exit 5\n' +
  '  touch "$STATE/loaded/$l"; exit 0 ;;\n' +
  'esac\n' +
  'exit 64\n'
// find: the real one, or a failure with STUB_FIND_FAIL.
const FIND = '#!/bin/sh\necho "find $*" >> "$CALLS"\n[ -n "${STUB_FIND_FAIL:-}" ] && { echo "find: Permission denied" >&2; exit 1; }\nexec /usr/bin/find "$@"\n'

// Claude Code 2.1.322's name for a project's transcript folder (copied from the
// CLI: every character that is not an ASCII letter or digit becomes "-").
const projectDir = (path) => path.replace(/[^a-zA-Z0-9]/g, '-')

const RESTART_SCRIPT = execTemplate(read(RESTART), { data: { ...DARWIN, work: false } })

function restartSandbox({ loaded = true, homeName = 'home dir.v2' } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'crc-restart-'))
  const home = join(base, homeName)
  const bin = join(base, 'bin')
  const state = join(base, 'state')
  for (const d of [home, bin, join(state, 'loaded'), join(home, 'Library', 'LaunchAgents')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(bin, 'launchctl'), LAUNCHCTL)
  writeFileSync(join(bin, 'find'), FIND)
  chmodSync(join(bin, 'launchctl'), 0o755)
  chmodSync(join(bin, 'find'), 0o755)
  writeFileSync(join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`), '<plist/>\n')
  if (loaded) writeFileSync(join(state, 'loaded', LABEL), '')
  const script = join(base, 'restart.sh')
  writeFileSync(script, RESTART_SCRIPT)
  const calls = join(base, 'calls')
  writeFileSync(calls, '')
  const projects = join(home, '.claude', 'projects')
  return {
    home,
    marker: join(home, '.cron', 'logs', 'claude-remote-control-restart.FAILED'),
    codeProject: join(projects, projectDir(join(home, 'Code'))),
    homeProject: join(projects, projectDir(home)),
    loaded: () => existsSync(join(state, 'loaded', LABEL)),
    calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    launchctl: () => readFileSync(calls, 'utf8').split('\n').filter((c) => /^(print|bootout|bootstrap)/.test(c)).map((c) => c.split(' ')[0]),
    run: (env = {}) => spawnSync('bash', [script], { encoding: 'utf8', env: { HOME: home, PATH: `${bin}:${SYS_PATH}`, CALLS: calls, STATE: state, ...env } }),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

function withRestart(opts, fn) {
  const sb = restartSandbox(opts)
  try {
    return fn(sb)
  } finally {
    sb.cleanup()
  }
}

// A transcript file, last changed `minutes` ago.
function transcript(dir, minutes, name = 'session.jsonl') {
  mkdirSync(dir, { recursive: true })
  const f = join(dir, name)
  writeFileSync(f, '{}\n')
  const t = (Date.now() - minutes * 60000) / 1000
  utimesSync(f, t, t)
  utimesSync(dir, t, t)
}

const DEFER_BUSY = 'claude-remote-control: restart deferred, a session in ~/Code is active (retries on the next apply)\n'

test('restart: the transcript folder name matches the CLI rule (`/Users/rdegges/Code` -> `-Users-rdegges-Code`)', () => {
  assert.equal(projectDir('/Users/rdegges/Code'), '-Users-rdegges-Code')
  assert.equal(projectDir('/Users/rdegges'), '-Users-rdegges')
})

test('restart: no ~/Code transcript folder: bootout, then bootstrap, exit 0, the marker cleared', () =>
  withRestart({}, (sb) => {
    mkdirSync(join(sb.marker, '..'), { recursive: true })
    writeFileSync(sb.marker, 'old\n')
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.launchctl(), ['print-disabled', 'bootout', 'print', 'bootstrap'])
    assert.ok(sb.loaded())
    assert.equal(existsSync(sb.marker), false)
    assert.match(r.stdout, /restarted com\.rdegges\.claude-remote-control/)
  }))

test('restart: transcripts in ~/Code last changed 30 minutes ago: restarts', () =>
  withRestart({}, (sb) => {
    transcript(sb.codeProject, 30)
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.ok(sb.launchctl().includes('bootstrap'))
  }))

test('restart: a ~/Code transcript changed 5 minutes ago (HOME with a space and a dot): deferred, exit 1, marker, no bootout', () =>
  withRestart({}, (sb) => {
    transcript(sb.codeProject, 30)
    transcript(sb.codeProject, 5, 'other.jsonl')
    const r = sb.run()
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.equal(r.stderr, DEFER_BUSY)
    assert.deepEqual(sb.launchctl(), ['print-disabled'])
    assert.ok(sb.loaded())
    assert.match(readFileSync(sb.marker, 'utf8'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} claude-remote-control: restart deferred, a session in ~\/Code is active/)
  }))

test('restart: a session active only in ~ (another project folder) does not defer it', () =>
  withRestart({}, (sb) => {
    transcript(sb.homeProject, 1)
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.ok(sb.launchctl().includes('bootstrap'))
  }))

test('restart: a probe that cannot evaluate (find fails) counts as busy', () =>
  withRestart({}, (sb) => {
    transcript(sb.codeProject, 30)
    const r = sb.run({ STUB_FIND_FAIL: '1' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stderr, /restart deferred, cannot tell whether a session in ~\/Code is active: find failed \(exit 1\)/)
    assert.ok(!sb.launchctl().includes('bootout'))
  }))

test('restart: a HOME whose folder name the script cannot derive (non-ASCII) counts as busy', () =>
  withRestart({ homeName: 'Ränd' }, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stderr, /cannot tell whether a session in ~\/Code is active: no transcript folder name/)
    assert.ok(!sb.launchctl().includes('bootout'))
  }))

test('restart: a disabled service is not restarted, exit 0 (an enabled look-alike does not count)', () =>
  withRestart({}, (sb) => {
    let r = sb.run({ STUB_DISABLED: LABEL })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.launchctl(), ['print-disabled'])
    assert.match(r.stdout, /is disabled; not restarted/)
    r = sb.run({ STUB_ENABLED: LABEL, STUB_DISABLED: `${LABEL}-old` })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.ok(sb.launchctl().includes('bootstrap'))
  }))

test('restart: print-disabled fails: exit 1, no bootout', () =>
  withRestart({}, (sb) => {
    const r = sb.run({ STUB_PRINT_DISABLED_FAIL: '1' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.deepEqual(sb.launchctl(), ['print-disabled'])
  }))

test('restart: from inside the server (XPC_SERVICE_NAME is the service): no launchctl call, exit 1', () =>
  withRestart({}, (sb) => {
    const r = sb.run({ XPC_SERVICE_NAME: LABEL })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), [])
    assert.match(r.stderr, /restart deferred, this apply runs inside the server/)
  }))

test('restart: not loaded (and not disabled): bootstrapped', () =>
  withRestart({ loaded: false }, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.ok(sb.loaded())
  }))

test('restart: a failed bootstrap: exit 1 and a marker', () =>
  withRestart({}, (sb) => {
    const r = sb.run({ STUB_BOOTSTRAP_FAIL: '1' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(readFileSync(sb.marker, 'utf8'), /restart failed, launchctl bootstrap gui\/\d+ com\.rdegges\.claude-remote-control failed/)
  }))

test('restart: a bootout that leaves the service loaded: no bootstrap after 10s, exit 1, a marker', () =>
  withRestart({}, (sb) => {
    const t0 = Date.now()
    const r = sb.run({ STUB_BOOTOUT_STUCK: '1' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    // The deadline is bash $SECONDS + 10, in whole seconds: 9 to 10s of polling.
    assert.ok(Date.now() - t0 >= 8000, `gave up after ${Date.now() - t0}ms, not about 10s`)
    assert.ok(!sb.launchctl().includes('bootstrap'), sb.launchctl().join(' '))
    assert.ok(sb.loaded())
    assert.match(r.stderr, /ERROR: com\.rdegges\.claude-remote-control still loaded 10s after bootout/)
    assert.match(readFileSync(sb.marker, 'utf8'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} claude-remote-control: restart failed, com\.rdegges\.claude-remote-control still loaded 10s after bootout \(retries on the next apply\)\n$/)
  }))

test('restart: busy, then idle: deferred, then restarted, and the marker cleared (A->B)', () =>
  withRestart({}, (sb) => {
    transcript(sb.codeProject, 2)
    assert.equal(sb.run().status, 1)
    assert.ok(existsSync(sb.marker))
    transcript(sb.codeProject, 25)
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.equal(existsSync(sb.marker), false)
  }))

// The hash header: what change restarts the server.
function scratchSource() {
  const src = mkdtempSync(join(tmpdir(), 'crc-src-'))
  for (const p of ['.chezmoitemplates', AGENT, WRAPPER, RESTART, LOADER, 'private_Library/LaunchAgents', '.chezmoiignore']) cpSync(join(SOURCE, p), join(src, p), { recursive: true })
  return src
}

test('restart: the hash header changes with the agent, the shared template, the wrapper, and the homelab flag, and only then', () => {
  const src = scratchSource()
  try {
    const render = (homelab = false) => execTemplate(readFileSync(join(src, RESTART), 'utf8'), { source: src, data: { ...DARWIN, work: false, homelab } })
    const header = (s) => s.split('\n').filter((l) => / hash: [0-9a-f]{64}$/.test(l))
    const base = render()
    assert.equal(header(base).length, 3)
    assert.equal(render(), base, 'render is not stable')
    assert.notEqual(render(true), base, 'a homelab flip does not restart it')
    for (const p of [AGENT, '.chezmoitemplates/launchagent.plist', WRAPPER]) {
      const before = render()
      appendFileSync(join(src, p), '\n')
      assert.notEqual(render(), before, p)
    }
    const before = render()
    appendFileSync(join(src, 'private_Library/LaunchAgents/com.rdegges.pipx.plist.tmpl'), '\n')
    assert.equal(render(), before, 'another agent restarted the server')
  } finally {
    rmSync(src, { recursive: true, force: true })
  }
})

test('restart: under a real `chezmoi apply`, it runs after the loader; a deferred restart fails the apply and runs again on the next; then not again', () => {
  const base = mkdtempSync(join(tmpdir(), 'crc-apply-'))
  try {
    const src = join(base, 'src')
    mkdirSync(src)
    for (const p of ['.chezmoitemplates', 'private_Library/LaunchAgents', WRAPPER, RESTART, LOADER, '.chezmoiignore']) cpSync(join(SOURCE, p), join(src, p), { recursive: true })
    const home = join(base, 'home')
    const bin = join(base, 'bin')
    const state = join(base, 'state')
    for (const d of [home, bin, join(state, 'loaded')]) mkdirSync(d, { recursive: true })
    writeFileSync(join(bin, 'launchctl'), LAUNCHCTL)
    writeFileSync(join(bin, 'find'), FIND)
    chmodSync(join(bin, 'launchctl'), 0o755)
    chmodSync(join(bin, 'find'), 0o755)
    const cfg = join(base, 'chezmoi.toml')
    writeFileSync(cfg, '')
    const calls = join(base, 'calls')
    const apply = () => {
      writeFileSync(calls, '')
      const r = spawnSync('chezmoi', ['--source', src, '--destination', home, '--config', cfg, '--no-tty', '--override-data', JSON.stringify({ ...DARWIN, work: false }), 'apply', '--force'], {
        encoding: 'utf8',
        env: { HOME: home, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, STATE: state },
      })
      return { r, calls: readFileSync(calls, 'utf8').split('\n').filter(Boolean) }
    }
    const svc = (c) => c.includes(LABEL)
    const codeProject = join(home, '.claude', 'projects', projectDir(join(home, 'Code')))
    transcript(codeProject, 1)

    // 1. Busy: the loader bootstraps the new service, then the restart defers.
    let { r, calls: c } = apply()
    assert.notEqual(r.status, 0, 'a deferred restart must fail the apply')
    assert.match(r.stderr, /restart deferred, a session in ~\/Code is active/)
    assert.ok(existsSync(join(state, 'loaded', LABEL)))
    assert.deepEqual(c.filter(svc).map((x) => x.split(' ')[0]), ['print', 'bootstrap'])
    assert.ok(existsSync(join(home, '.cron', 'claude-remote-control.sh')), 'the wrapper was not written')

    // 2. Idle: the failed script runs again and restarts it; the loader leaves it alone.
    transcript(codeProject, 30)
    ;({ r, calls: c } = apply())
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(c.filter(svc).map((x) => x.split(' ')[0]), ['bootout', 'print', 'bootstrap'])
    assert.equal(existsSync(join(home, '.cron', 'logs', 'claude-remote-control-restart.FAILED')), false)

    // 3. Nothing changed: nothing runs.
    ;({ r, calls: c } = apply())
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(c, [])

    // 4. The wrapper changes: only the restart script touches the service.
    appendFileSync(join(src, WRAPPER), '\n')
    ;({ r, calls: c } = apply())
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(c.filter(svc).map((x) => x.split(' ')[0]), ['bootout', 'print', 'bootstrap'])
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
