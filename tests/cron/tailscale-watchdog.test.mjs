// Behavior of the Tailscale watchdog (dot_cron/executable_tailscale-watchdog.sh),
// which runs only on the homelab server Mac. Its gate (.chezmoiignore and the
// loader) and its launchd agent are tested in tests/cron/launch-agents.test.mjs.
//
// Run from the repo root:
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'apt-get update -qq && apt-get install -y -qq zsh >/dev/null &&
//      sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin &&
//      node --test tests/cron/'
//
// What a pass proves: against a stub Tailscale CLI (TAILSCALE_CLI, at a path
// with a space) and stub pgrep, open, plutil, himalaya, and hostname on a PATH
// with only system dirs after them (real date, sed, and coreutils timeout):
// Running is healthy and sends no mail; Starting settles; Stopped while logged
// in runs `tailscale up` once with no flags and confirms Running; an `up` that
// refuses (the "non-default flags" error), times out at 30s, or leaves the state
// not Running fails and never retries with flags; Stopped and logged out,
// NeedsLogin, NeedsMachineAuth, a missing CLI, and status or prefs output the
// script cannot read (bad JSON, two values, an unknown value) fail without
// `up`; an app that is not running is started with `open -g -b` for either
// bundle id and an unknown id is not started. Each failure writes one marker
// line and exits 1; mail goes to r@rdegges.com from the himalaya account
// `icloud`, with the whole message on stdin (the stub, like himalaya 1.2.0,
// ignores a message argument and panics on an empty stdin), only when the
// state changes (also across Running -> down -> Running
// -> down); a recovery mails once and clears the marker; a mail that cannot be
// sent writes the marker, exits 1, and is retried by the next run.
//
// What a pass does not prove: the real Tailscale CLI's output or exit codes on
// macOS (the JSON shape was read by hand from 1.104.5, and from the Standalone
// 1.104.6, io.tailscale.ipn.macsys, that the Mac runs now), what real
// `tailscale up` does with non-default prefs, real pgrep/open/plutil behavior, real launchd
// timing, macOS /bin/sh (bash 3.2 in POSIX mode; this runs under Debian dash),
// or real mail delivery. Those need the user-present `tailscale down` run on
// the homelab Mac.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, chmodSync, rmSync, readdirSync, statSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('../../', import.meta.url)
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8')
const SCRIPT = new URL('dot_cron/executable_tailscale-watchdog.sh', ROOT).pathname
const SYS_PATH = '/usr/bin:/bin'
const APP_BIN = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'

// $STATE/backend holds one BackendState per line. Each `status --json` uses the
// first line and drops it while more lines remain, so "Starting\nRunning"
// settles. The Health text holds an escaped "BackendState": "Running", which
// a parser that ignores JSON escaping would count as a second value.
const CLI = [
  '#!/bin/sh',
  'echo "tailscale $*" >> "$CALLS"',
  'case "$*" in',
  '"status --json")',
  '  [ -n "${STUB_STATUS_HANG:-}" ] && exec sleep 600',
  '  if [ -n "${STUB_STATUS_RAW+x}" ]; then printf \'%s\\n\' "$STUB_STATUS_RAW"; exit "${STUB_STATUS_RC:-0}"; fi',
  '  s=$(head -n 1 "$STATE/backend")',
  '  if [ "$(wc -l < "$STATE/backend")" -gt 1 ]; then tail -n +2 "$STATE/backend" > "$STATE/b.tmp"; mv "$STATE/b.tmp" "$STATE/backend"; fi',
  '  printf \'{\\n  "Version": "1.104.5-t788384763",\\n  "TUN": true,\\n  "BackendState": "%s",\\n  "HaveNodeKey": true,\\n  "Health": [\\n    "\\\\"BackendState\\\\": \\\\"Running\\\\" in a health message"\\n  ]\\n}\\n\' "$s"',
  '  exit "${STUB_STATUS_RC:-0}" ;;',
  '"debug prefs")',
  '  [ -n "${STUB_PREFS_HANG:-}" ] && exec sleep 600',
  '  if [ -n "${STUB_PREFS_RAW+x}" ]; then printf \'%s\\n\' "$STUB_PREFS_RAW"; exit "${STUB_PREFS_RC:-1}"; fi',
  '  printf \'{\\n  "ControlURL": "https://controlplane.tailscale.com",\\n  "WantRunning": false,\\n  "LoggedOut": %s\\n}\\n\' "${STUB_LOGGED_OUT:-false}"',
  '  exit 0 ;;',
  'up)',
  '  [ -n "${STUB_UP_HANG:-}" ] && exec sleep 600',
  '  if [ "${STUB_UP_RC:-0}" != 0 ]; then echo "${STUB_UP_ERR:-boom}" >&2; exit "$STUB_UP_RC"; fi',
  '  printf \'%s\\n\' "${STUB_AFTER_UP:-Running}" > "$STATE/backend"',
  '  exit 0 ;;',
  'esac',
  'exit 64',
].join('\n') + '\n'

const STUBS = {
  pgrep: '#!/bin/sh\necho "pgrep $*" >> "$CALLS"\n[ -n "${STUB_PGREP_RC:-}" ] && exit "$STUB_PGREP_RC"\n[ -e "$STATE/app-running" ]\n',
  open:
    '#!/bin/sh\necho "open $*" >> "$CALLS"\n' +
    'if [ "${STUB_OPEN_RC:-0}" != 0 ]; then echo "LSOpenURLsWithRole() failed with error -10814" >&2; exit "$STUB_OPEN_RC"; fi\n' +
    '[ -n "${STUB_OPEN_NOAPP:-}" ] || touch "$STATE/app-running"\n',
  plutil:
    '#!/bin/sh\necho "plutil $*" >> "$CALLS"\n' +
    'if [ -n "${STUB_PLUTIL_FAIL:-}" ]; then echo "Could not extract value, error: No value at that key path" >&2; exit 1; fi\n' +
    'printf "%s\\n" "${STUB_BUNDLE_ID:-io.tailscale.ipn.macos}"\n',
  // Like the real himalaya 1.2.0 `message send`: with a non-TTY stdin it reads
  // the message from stdin and ignores any message argument, and an empty stdin
  // makes it panic (exit 101, nothing sent), as measured on the homelab Mac. Each
  // sent message (the stdin bytes) lands in $STATE/mail.<n>.
  himalaya:
    '#!/bin/sh\necho "himalaya $1 $2 $3 $4 ($# args)" >> "$CALLS"\n' +
    'cat > "$STATE/stdin.tmp"\n' +
    'if [ ! -s "$STATE/stdin.tmp" ]; then\n' +
    '  printf "The application panicked (crashed).\\nMessage:  index out of bounds: the len is 0 but the index is 0\\nLocation: /cargo/registry/src/mail-parser-0.9.4/src/core/message.rs:89\\n" >&2\n' +
    '  exit 101\n' +
    'fi\n' +
    'if [ "${STUB_MAIL_RC:-0}" != 0 ]; then echo "cannot send message: smtp connection refused" >&2; exit "$STUB_MAIL_RC"; fi\n' +
    'n=$(ls "$STATE" | grep -c "^mail\\.")\nmv "$STATE/stdin.tmp" "$STATE/mail.$((n + 1))"\n',
  hostname: '#!/bin/sh\necho testhost\n',
}

function sandbox({ backend = 'Running', app = true, stubs = Object.keys(STUBS), cli = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'tailscale-watchdog-'))
  const home = join(base, 'home')
  const bin = join(base, 'bin')
  const state = join(base, 'state')
  for (const d of [home, bin, state]) mkdirSync(d)
  for (const s of stubs) {
    writeFileSync(join(bin, s), STUBS[s])
    chmodSync(join(bin, s), 0o755)
  }
  const cliPath = join(base, 'Tailscale CLI')
  if (cli) {
    writeFileSync(cliPath, CLI)
    chmodSync(cliPath, 0o755)
  }
  const setBackend = (b) => writeFileSync(join(state, 'backend'), b.split(' ').join('\n') + '\n')
  setBackend(backend)
  if (app) writeFileSync(join(state, 'app-running'), '')
  const calls = join(base, 'calls')
  writeFileSync(calls, '')
  const logs = join(home, '.cron', 'logs')
  return {
    base,
    home,
    bin,
    logs,
    cliPath,
    marker: join(logs, 'tailscale-watchdog.FAILED'),
    stamp: join(logs, 'tailscale-watchdog.ok'),
    statefile: join(logs, 'tailscale-watchdog.state'),
    setBackend,
    setApp: (on) => (on ? writeFileSync(join(state, 'app-running'), '') : rmSync(join(state, 'app-running'), { force: true })),
    calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    resetCalls: () => writeFileSync(calls, ''),
    mails: () =>
      readdirSync(state)
        .filter((f) => f.startsWith('mail.'))
        .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
        .map((f) => readFileSync(join(state, f), 'utf8')),
    // shell: the argv that runs the script (macOS /bin/sh is bash in POSIX
    // mode); input: what the caller feeds the script's own stdin.
    run(env = {}, { shell = ['sh'], input } = {}) {
      const t0 = Date.now()
      const r = spawnSync(shell[0], [...shell.slice(1), SCRIPT], {
        encoding: 'utf8',
        input,
        // Built from scratch so the host's TAILSCALE_* never leak in.
        env: { HOME: home, PATH: `${bin}:${SYS_PATH}`, CALLS: calls, STATE: state, TAILSCALE_CLI: cliPath, TAILSCALE_WATCHDOG_WAIT: '3', ...env },
      })
      r.elapsed = (Date.now() - t0) / 1000
      return r
    },
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

const subject = (mail) => mail.match(/^Subject: (.*)$/m)[1]
const tsCalls = (sb) => sb.calls().filter((c) => c.startsWith('tailscale ')).map((c) => c.slice('tailscale '.length))
const state = (sb) => readFileSync(sb.statefile, 'utf8').trim()

function assertHealthy(sb, r) {
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /^tailscale-watchdog: ok: Running$/m)
  assert.equal(existsSync(sb.marker), false, 'marker left behind')
  assert.ok(existsSync(sb.stamp), 'no .ok stamp')
  assert.equal(state(sb), 'Running')
}

function assertFailed(sb, r, reason) {
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /tailscale-watchdog: FAILED: /)
  const m = readFileSync(sb.marker, 'utf8')
  assert.match(m, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} tailscale-watchdog: .* \(see ~\/\.cron\/logs\/tailscale-watchdog\.log\)\n$/)
  assert.equal(m.split('\n').length, 2, `marker is not one line: ${JSON.stringify(m)}`)
  assert.match(m, reason)
  return m
}

// --- Healthy -------------------------------------------------------------------

test('Running, first run: exit 0, no mail, no up or open, state Running, stamp touched', () =>
  withSandbox({}, (sb) => {
    const r = sb.run()
    assertHealthy(sb, r)
    assert.deepEqual(sb.mails(), [])
    assert.deepEqual(sb.calls(), [`pgrep -fx ${APP_BIN}`, 'tailscale status --json'])
  }))

test('Running after Running: no mail', () =>
  withSandbox({}, (sb) => {
    sb.run()
    const r = sb.run()
    assertHealthy(sb, r)
    assert.deepEqual(sb.mails(), [])
  }))

test('a healthy run removes a marker left by an earlier failure', () =>
  withSandbox({}, (sb) => {
    mkdirSync(sb.logs, { recursive: true })
    writeFileSync(sb.marker, 'old\n')
    assertHealthy(sb, sb.run())
  }))

test('Starting, then Running: waits for it, no up, no mail', () =>
  withSandbox({ backend: 'Starting Starting Running' }, (sb) => {
    const r = sb.run()
    assertHealthy(sb, r)
    assert.deepEqual(tsCalls(sb), ['status --json', 'status --json', 'status --json'])
    assert.deepEqual(sb.mails(), [])
  }))

test('NoState, then Running: waits for it', () =>
  withSandbox({ backend: 'NoState Running' }, (sb) => assertHealthy(sb, sb.run())))

test('a status --json that exits non-zero but states Running is healthy (the JSON decides)', () =>
  withSandbox({}, (sb) => assertHealthy(sb, sb.run({ STUB_STATUS_RC: '1' }))))

// --- Stopped (tailscale/tailscale#21825) ----------------------------------------

test('Stopped while logged in: one `tailscale up` with no flags, confirmed Running, one recovery mail', () =>
  withSandbox({ backend: 'Stopped' }, (sb) => {
    const r = sb.run({ STUB_LOGGED_OUT: 'false' }) // first run: no state file yet
    assert.deepEqual(tsCalls(sb), ['status --json', 'debug prefs', 'up', 'status --json'])
    assertHealthy(sb, r)
    const mails = sb.mails()
    assert.equal(mails.length, 1)
    assert.equal(subject(mails[0]), 'Tailscale recovered on testhost')
    assert.match(mails[0], /BackendState was Stopped while logged in; the watchdog ran `tailscale up`/)
  }))

test('Stopped after a Running report: fixed, and the fix is mailed', () =>
  withSandbox({}, (sb) => {
    sb.run()
    sb.setBackend('Stopped')
    const r = sb.run()
    assertHealthy(sb, r)
    assert.match(r.stdout, /running tailscale up/)
    assert.equal(sb.mails().length, 1)
  }))

test('`tailscale up` refuses (non-default flags): FAILED with its message, mailed, never retried with flags', () =>
  withSandbox({ backend: 'Stopped' }, (sb) => {
    const err =
      "Error: changing settings via 'tailscale up' requires mentioning all\nnon-default flags. To proceed, either re-run your command with --reset or\nuse the command below to explicitly mention the current value of\nall non-default settings:\n\n\ttailscale up --advertise-exit-node"
    const r = sb.run({ STUB_UP_RC: '1', STUB_UP_ERR: err })
    const m = assertFailed(sb, r, /`tailscale up` failed \(exit 1; .*\): Error: changing settings via 'tailscale up' requires mentioning all non-default flags/)
    assert.doesNotMatch(m, /mail failed/)
    assert.deepEqual(tsCalls(sb).filter((c) => c.startsWith('up')), ['up'])
    const mails = sb.mails()
    assert.equal(mails.length, 1)
    assert.equal(subject(mails[0]), 'Tailscale is down on testhost: up-failed')
    assert.match(mails[0], /requires mentioning all non-default flags/)
    assert.equal(state(sb), 'up-failed')
  }))

test('`tailscale up` succeeds but the state stays Stopped: FAILED not-running', () =>
  withSandbox({ backend: 'Stopped' }, (sb) => {
    const r = sb.run({ STUB_AFTER_UP: 'Stopped' })
    assertFailed(sb, r, /`tailscale up` ran, but the state is Stopped 3s later/)
    assert.equal(subject(sb.mails()[0]), 'Tailscale is down on testhost: not-running')
  }))

test('`tailscale up` succeeds, Starting, then Running: healthy', () =>
  withSandbox({ backend: 'Stopped' }, (sb) => assertHealthy(sb, sb.run({ STUB_AFTER_UP: 'Starting\nRunning' }))))

test('a hung `tailscale up` is killed at 30s and reported', () =>
  withSandbox({ backend: 'Stopped' }, (sb) => {
    const r = sb.run({ STUB_UP_HANG: '1' })
    assert.ok(r.elapsed >= 29 && r.elapsed < 45, `took ${r.elapsed}s`)
    assertFailed(sb, r, /`tailscale up` failed \(exit 124; 124 or 137 is the 30s timeout\)/)
  }))

test('Stopped and logged out: no up, FAILED logged-out, mailed', () =>
  withSandbox({ backend: 'Stopped' }, (sb) => {
    const r = sb.run({ STUB_LOGGED_OUT: 'true' })
    assertFailed(sb, r, /logged out; log in by hand/)
    assert.deepEqual(tsCalls(sb), ['status --json', 'debug prefs'])
    assert.equal(subject(sb.mails()[0]), 'Tailscale is down on testhost: logged-out')
  }))

for (const [name, raw] of [['an error', 'Error: unknown subcommand "prefs"'], ['no LoggedOut', '{"WantRunning": false}'], ['a non-boolean LoggedOut', '{"LoggedOut": null}']]) {
  test(`Stopped, and \`debug prefs\` gives ${name}: cannot evaluate, so no up`, () =>
    withSandbox({ backend: 'Stopped' }, (sb) => {
      const r = sb.run({ STUB_PREFS_RAW: raw })
      assertFailed(sb, r, /LoggedOut cannot be read from `tailscale debug prefs` \(exit 1\)/)
      assert.ok(!tsCalls(sb).includes('up'), tsCalls(sb).join(','))
      assert.equal(state(sb), 'cannot-evaluate')
    }))
}

// --- States that need a person ---------------------------------------------------

for (const st of ['NeedsLogin', 'NeedsMachineAuth', 'InUseOtherUser']) {
  test(`${st}: no up, no open, FAILED, mailed with key ${st}`, () =>
    withSandbox({ backend: st }, (sb) => {
      const r = sb.run()
      assertFailed(sb, r, new RegExp(`BackendState is ${st}; this needs a person`))
      assert.deepEqual(tsCalls(sb), ['status --json'])
      assert.ok(!sb.calls().some((c) => c.startsWith('open')))
      assert.equal(subject(sb.mails()[0]), `Tailscale is down on testhost: ${st}`)
    }))
}

test('still Starting after the wait: FAILED Starting', () =>
  withSandbox({ backend: 'Starting' }, (sb) => {
    const r = sb.run()
    // The deadline is whole seconds (`date +%s`), so a 3s wait really lasts
    // between 2 and 3 seconds; 2.5 failed whenever the run began late in a second.
    assert.ok(r.elapsed >= 2 && r.elapsed < 10, `took ${r.elapsed}s`)
    assertFailed(sb, r, /BackendState is still Starting after 3s/)
  }))

// --- Cannot evaluate --------------------------------------------------------------

for (const [name, raw] of [
  ['not JSON', 'Failed to connect to local Tailscale daemon; it is not running'],
  ['empty output', ''],
  ['two BackendState values', '{"BackendState": "Running",\n "Self": {"BackendState": "Stopped"}}'],
  ['an unknown value', '{"BackendState": "Sleeping"}'],
  ['only an escaped value in a string', '{"Health": ["\\"BackendState\\": \\"Running\\""]}'],
]) {
  test(`status --json gives ${name}: cannot evaluate (never healthy), no up`, () =>
    withSandbox({}, (sb) => {
      const r = sb.run({ STUB_STATUS_RAW: raw, STUB_STATUS_RC: '1' })
      assertFailed(sb, r, /cannot read BackendState from `tailscale status --json` \(exit 1\)/)
      assert.ok(!tsCalls(sb).includes('up'))
      assert.equal(subject(sb.mails()[0]), 'Tailscale is down on testhost: cannot-evaluate')
    }))
}

test('CLI missing: FAILED cli-missing, mailed, nothing else runs', () =>
  withSandbox({ cli: false }, (sb) => {
    const r = sb.run()
    assertFailed(sb, r, /Tailscale CLI not found or not executable: .*Tailscale CLI/)
    assert.deepEqual(sb.calls().filter((c) => !c.startsWith('himalaya')), [])
    assert.equal(subject(sb.mails()[0]), 'Tailscale is down on testhost: cli-missing')
  }))

test('pgrep cannot check (exit 2): cannot evaluate, nothing started', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({ STUB_PGREP_RC: '2' })
    assertFailed(sb, r, /pgrep could not check whether the Tailscale app runs \(exit 2\)/)
    assert.ok(!sb.calls().some((c) => c.startsWith('open') || c.startsWith('tailscale')))
  }))

test('without TAILSCALE_CLI it uses the CLI inside /Applications/Tailscale.app', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({ TAILSCALE_CLI: '' })
    assertFailed(sb, r, /not found or not executable: \/Applications\/Tailscale\.app\/Contents\/MacOS\/Tailscale \(/)
  }))

// --- App not running -------------------------------------------------------------------

for (const id of ['io.tailscale.ipn.macos', 'io.tailscale.ipn.macsys']) {
  test(`app not running (${id}): started with open -g -b, then Running, one recovery mail`, () =>
    withSandbox({ app: false }, (sb) => {
      const r = sb.run({ STUB_BUNDLE_ID: id })
      assertHealthy(sb, r)
      assert.equal(sb.mails().length, 1)
      assert.match(sb.mails()[0], new RegExp(`the Tailscale app was not running; the watchdog started it \\(open -g -b ${id.replace(/\./g, '\\.')}\\)`))
      assert.ok(sb.calls().includes('plutil -extract CFBundleIdentifier raw -o - /Applications/Tailscale.app/Contents/Info.plist'), sb.calls().join('\n'))
      assert.deepEqual(sb.calls().filter((c) => c.startsWith('open')), [`open -g -b ${id}`])
    }))
}

test('app not running, then Stopped: both fixes in one recovery mail', () =>
  withSandbox({ app: false, backend: 'Stopped' }, (sb) => {
    const r = sb.run()
    assertHealthy(sb, r)
    const mails = sb.mails()
    assert.equal(mails.length, 1)
    assert.match(mails[0], /started it \(open -g -b io\.tailscale\.ipn\.macos\); BackendState was Stopped while logged in/)
  }))

for (const [name, env, reason] of [
  ['an unknown bundle id', { STUB_BUNDLE_ID: 'com.example.not-tailscale' }, /no known bundle id \(com\.example\.not-tailscale\); not started/],
  ['an unreadable Info.plist', { STUB_PLUTIL_FAIL: '1' }, /no known bundle id \(Could not extract value/],
]) {
  test(`app not running, ${name}: not started, FAILED app-not-running`, () =>
    withSandbox({ app: false }, (sb) => {
      const r = sb.run(env)
      assertFailed(sb, r, reason)
      assert.ok(!sb.calls().some((c) => c.startsWith('open')))
      assert.equal(subject(sb.mails()[0]), 'Tailscale is down on testhost: app-not-running')
    }))
}

test('app not running, open fails: FAILED with the open error', () =>
  withSandbox({ app: false }, (sb) => {
    const r = sb.run({ STUB_OPEN_RC: '1' })
    assertFailed(sb, r, /`open -g -b io\.tailscale\.ipn\.macos` failed: LSOpenURLsWithRole\(\) failed/)
    assert.ok(!sb.calls().some((c) => c.startsWith('tailscale')))
  }))

test('app not running, open succeeds but the app never shows up: FAILED after the wait', () =>
  withSandbox({ app: false }, (sb) => {
    const r = sb.run({ STUB_OPEN_NOAPP: '1' })
    // The deadline is whole seconds (`date +%s`), so a 3s wait really lasts
    // between 2 and 3 seconds; 2.5 failed whenever the run began late in a second.
    assert.ok(r.elapsed >= 2 && r.elapsed < 10, `took ${r.elapsed}s`)
    assertFailed(sb, r, /started io\.tailscale\.ipn\.macos, but the app was not running 3s later/)
  }))

// --- Mail --------------------------------------------------------------------------

test('mail: account icloud, From and To r@rdegges.com, the whole message on stdin and no message argument', () =>
  withSandbox({ backend: 'NeedsLogin' }, (sb) => {
    const r = sb.run()
    assert.doesNotMatch(r.stdout, /mail failed/, r.stdout)
    assert.deepEqual(sb.calls().filter((c) => c.startsWith('himalaya')), ['himalaya message send -a icloud (4 args)'])
    const m = sb.mails()[0]
    assert.equal(
      m,
      'From: r@rdegges.com\nTo: r@rdegges.com\nSubject: Tailscale is down on testhost: NeedsLogin\n\n' +
        'Tailscale on testhost is not up, and the watchdog could not fix it.\n\n' +
        'Reason: BackendState is NeedsLogin; this needs a person (the watchdog never re-authenticates)\n\n' +
        'The watchdog mails again only when this changes. The reason stays in ~/.cron/logs/tailscale-watchdog.FAILED until a run finds Tailscale Running.',
    )
    assert.equal(state(sb), 'NeedsLogin')
  }))

test('mail: the recovery mail (headers and body) also arrives on stdin', () =>
  withSandbox({ backend: 'Stopped' }, (sb) => {
    const r = sb.run()
    assertHealthy(sb, r)
    assert.match(sb.mails()[0], /^From: r@rdegges\.com\nTo: r@rdegges\.com\nSubject: Tailscale recovered on testhost\n\nTailscale on testhost is Running again\.\n\nWhat happened: BackendState was Stopped while logged in; the watchdog ran `tailscale up`\.$/)
  }))

test('mail: a himalaya panic (empty stdin, exit 101) is a failed send: marker, exit 1, state kept', () =>
  withSandbox({ backend: 'NeedsLogin' }, (sb) => {
    // A stub that sees no stdin at all, as `< /dev/null` gives it.
    writeFileSync(join(sb.bin, 'himalaya'), STUBS.himalaya.replace('cat > "$STATE/stdin.tmp"', ': > "$STATE/stdin.tmp"'))
    const r = sb.run()
    assertFailed(sb, r, /the alert mail failed too/)
    assert.match(r.stdout, /mail failed: The application panicked \(crashed\)\. Message:  index out of bounds/)
    assert.equal(existsSync(sb.statefile), false)
    assert.deepEqual(sb.mails(), [])
  }))

// The message on himalaya's stdin is the script's own text, not whatever the
// caller's stdin holds: launchd gives /dev/null, but a person can run the job
// from a pipe, and a leaked byte would change or replace the mail.
test('mail: the caller\'s stdin never reaches himalaya; the mail is exactly the message the script built', () =>
  withSandbox({ backend: 'NeedsLogin' }, (sb) => {
    const r = sb.run({}, { input: 'From: attacker@example.com\nSubject: CALLER STDIN\n\nleaked\n' })
    assert.match(r.stdout, /mailed: Tailscale is down on testhost: NeedsLogin/, r.stdout + r.stderr)
    const m = sb.mails()
    assert.equal(m.length, 1)
    assert.match(m[0], /^From: r@rdegges\.com\nTo: r@rdegges\.com\nSubject: Tailscale is down on testhost: NeedsLogin\n\n/)
    assert.doesNotMatch(m[0], /CALLER STDIN|leaked|attacker/)
  }))

// printf-format characters, backslashes, and option-like text in the reason
// must arrive as literal bytes: the message is data on a pipe, never a printf
// format or a himalaya argument.
// The stub CLI prints its `up` error with dash's echo, which would expand these
// backslashes itself; this one prints them raw.
const rawUpErrCli = () => {
  const cli = CLI.replace('echo "${STUB_UP_ERR:-boom}" >&2', 'printf \'%s\\n\' "${STUB_UP_ERR:-boom}" >&2')
  assert.notEqual(cli, CLI, 'stub patch did not apply')
  return cli
}

test('mail: %, backslashes, and option-like text in the reason arrive literally on stdin', () =>
  withSandbox({ backend: 'Stopped' }, (sb) => {
    const err = 'disk 100% full %s %n \\n \\t -a other --config /tmp/x'
    writeFileSync(sb.cliPath, rawUpErrCli())
    const r = sb.run({ STUB_UP_RC: '1', STUB_UP_ERR: err })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /mailed: Tailscale is down on testhost: up-failed/)
    assert.deepEqual(sb.calls().filter((c) => c.startsWith('himalaya')), ['himalaya message send -a icloud (4 args)'])
    const m = sb.mails()
    assert.equal(m.length, 1)
    assert.ok(m[0].includes(`): ${err}\n\n`), JSON.stringify(m[0]))
  }))

// Defect proof (pre-existing, not from the stdin change): the marker lines are
// written with `echo`, and both dash and macOS /bin/sh (bash 3.2, xpg_echo on)
// expand backslash escapes in echo: a literal \n in CLI output splits the
// marker into two lines, and \c cuts the rest of it off, "(see ...log)" and the
// final newline included. Invariant from this file's own header: each failure
// writes one whole marker line.
test.todo('PROPOSED CONTRACT: a `\\n` or `\\c` in the `up` error keeps the marker one whole line', () =>
  withSandbox({ backend: 'Stopped' }, (sb) => {
    writeFileSync(sb.cliPath, rawUpErrCli())
    const r = sb.run({ STUB_UP_RC: '1', STUB_UP_ERR: 'parse error: "a\\nb" then \\c the rest' })
    const m = assertFailed(sb, r, /`tailscale up` failed/)
    assert.ok(m.includes('"a\\nb" then \\c the rest (see '), JSON.stringify(m))
  }))

// macOS /bin/sh is bash 3.2 in POSIX mode; the rest of this file runs under dash.
test('[bash --posix] down then recovered: both mails arrive whole on stdin, marker cleared', { skip: spawnSync('sh', ['-c', 'command -v bash']).status === 0 ? false : 'bash not installed' }, () =>
  withSandbox({ backend: 'NeedsLogin' }, (sb) => {
    const bash = { shell: ['bash', '--posix'] }
    assertFailed(sb, sb.run({}, bash), /NeedsLogin/)
    sb.setBackend('Running')
    assertHealthy(sb, sb.run({}, bash))
    const m = sb.mails()
    assert.deepEqual(m.map(subject), ['Tailscale is down on testhost: NeedsLogin', 'Tailscale recovered on testhost'])
    assert.match(m[0], /^From: r@rdegges\.com\nTo: r@rdegges\.com\nSubject: .*\n\nTailscale on testhost is not up/)
    assert.match(m[1], /What happened: the last report was NeedsLogin, and this run found Tailscale Running\.$/)
  }))

test('mail only on change: the same failure twice mails once; a different failure mails again', () =>
  withSandbox({ backend: 'NeedsLogin' }, (sb) => {
    assertFailed(sb, sb.run(), /NeedsLogin/)
    assertFailed(sb, sb.run(), /NeedsLogin/)
    assert.equal(sb.mails().length, 1)
    sb.setBackend('NeedsMachineAuth')
    assertFailed(sb, sb.run(), /NeedsMachineAuth/)
    assert.deepEqual(sb.mails().map(subject), ['Tailscale is down on testhost: NeedsLogin', 'Tailscale is down on testhost: NeedsMachineAuth'])
  }))

test('A->B->A: Running, down, Running, down: mails down, recovered, down; quiet runs send nothing', () =>
  withSandbox({}, (sb) => {
    assertHealthy(sb, sb.run())
    sb.setBackend('NeedsLogin')
    sb.run()
    sb.run()
    sb.setBackend('Running')
    assertHealthy(sb, sb.run())
    assertHealthy(sb, sb.run())
    sb.setBackend('NeedsLogin')
    assertFailed(sb, sb.run(), /NeedsLogin/)
    assert.deepEqual(sb.mails().map(subject), [
      'Tailscale is down on testhost: NeedsLogin',
      'Tailscale recovered on testhost',
      'Tailscale is down on testhost: NeedsLogin',
    ])
    assert.match(sb.mails()[1], /the last report was NeedsLogin, and this run found Tailscale Running/)
  }))

test('failure mail cannot be sent: the marker says so, exit 1, and the next run sends it', () =>
  withSandbox({ backend: 'NeedsLogin' }, (sb) => {
    const r = sb.run({ STUB_MAIL_RC: '1' })
    assertFailed(sb, r, /NeedsLogin.*; the alert mail failed too/)
    assert.match(r.stdout, /mail failed: cannot send message: smtp connection refused/)
    assert.equal(existsSync(sb.statefile), false, 'state recorded although nothing was mailed')
    assert.deepEqual(sb.mails(), [])
    const r2 = sb.run()
    const m = assertFailed(sb, r2, /NeedsLogin/)
    assert.doesNotMatch(m, /mail failed/)
    assert.equal(sb.mails().length, 1)
    assert.equal(state(sb), 'NeedsLogin')
  }))

test('recovery mail cannot be sent: marker, exit 1, and the next healthy run sends it and clears the marker', () =>
  withSandbox({ backend: 'NeedsLogin' }, (sb) => {
    sb.run()
    sb.setBackend('Running')
    const r = sb.run({ STUB_MAIL_RC: '1' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(readFileSync(sb.marker, 'utf8'), /Tailscale is Running again \(.*\), but the recovery mail failed/)
    assert.equal(state(sb), 'NeedsLogin')
    assertHealthy(sb, sb.run())
    assert.deepEqual(sb.mails().map(subject), ['Tailscale is down on testhost: NeedsLogin', 'Tailscale recovered on testhost'])
  }))

test('a fix whose mail cannot be sent is still reported by the next run', () =>
  withSandbox({}, (sb) => {
    sb.run()
    sb.setBackend('Stopped')
    const r = sb.run({ STUB_MAIL_RC: '1' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(readFileSync(sb.marker, 'utf8'), /Running again \(BackendState was Stopped while logged in; .*\), but the recovery mail failed/)
    assert.equal(state(sb), 'Stopped')
    assertHealthy(sb, sb.run())
    assert.deepEqual(sb.mails().map(subject), ['Tailscale recovered on testhost'])
    assert.match(sb.mails()[0], /the last report was Stopped/)
  }))

test('himalaya missing: a failure still writes the marker, with the mail failure', () =>
  withSandbox({ backend: 'NeedsLogin', stubs: ['pgrep', 'open', 'plutil', 'hostname'] }, (sb) => {
    const r = sb.run()
    assertFailed(sb, r, /; the alert mail failed too/)
  }))

// --- Portability and wiring --------------------------------------------------------

test('without timeout/gtimeout on PATH it still runs, unbounded', () =>
  withSandbox({ backend: 'Stopped' }, (sb) => {
    const tools = join(sb.base, 'tools')
    mkdirSync(tools)
    for (const t of ['sh', 'mkdir', 'cat', 'sed', 'tr', 'cut', 'date', 'sleep', 'rm', 'touch', 'head', 'tail', 'wc', 'mv', 'ls', 'grep']) {
      const w = spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' })
      assert.equal(w.status, 0, `${t} not found`)
      symlinkSync(w.stdout.trim(), join(tools, t))
    }
    const PATH = `${sb.bin}:${tools}`
    assert.notEqual(spawnSync('sh', ['-c', 'command -v timeout || command -v gtimeout'], { env: { PATH } }).status, 0, 'timeout leaked onto PATH')
    assertHealthy(sb, sb.run({ PATH }))
    assert.ok(tsCalls(sb).includes('up'))
    // The unbounded branch of run() pipes the message straight into himalaya.
    assert.deepEqual(sb.mails().map(subject), ['Tailscale recovered on testhost'])
    assert.match(sb.mails()[0], /^From: r@rdegges\.com\nTo: r@rdegges\.com\n/)
  }))

test('HOME with spaces and non-ASCII: marker and state land in that HOME', () =>
  withSandbox({ backend: 'NeedsLogin' }, (sb) => {
    const home = join(sb.base, 'Ränd all ☁️')
    mkdirSync(home)
    const r = sb.run({ HOME: home })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.ok(existsSync(join(home, '.cron/logs/tailscale-watchdog.FAILED')))
    assert.equal(readFileSync(join(home, '.cron/logs/tailscale-watchdog.state'), 'utf8'), 'NeedsLogin\n')
  }))

test('the stamp is fresh after a healthy run and untouched by a failure', () =>
  withSandbox({}, (sb) => {
    const before = Date.now()
    sb.run()
    assert.ok(statSync(sb.stamp).mtimeMs >= before - 2000)
    const mtime = statSync(sb.stamp).mtimeMs
    sb.setBackend('NeedsLogin')
    sb.run()
    assert.equal(statSync(sb.stamp).mtimeMs, mtime)
  }))

test('script: POSIX sh shebang, parses under sh -n, never waits for the network', () => {
  const src = read('dot_cron/executable_tailscale-watchdog.sh')
  assert.match(src, /^#!\/bin\/sh\n/)
  const r = spawnSync('sh', ['-n', SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(src.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n'), /wait-for-network/)
})

test('script: no `tailscale up` with flags, no login, logout, or down anywhere', () => {
  const code = read('dot_cron/executable_tailscale-watchdog.sh').split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')
  // Every CLI call goes through the bounded run helper.
  assert.equal((code.match(/"\$cli"/g) || []).length, (code.match(/run \d+ "\$cli"/g) || []).length + 1, 'a CLI call outside run (the +1 is the -x check)')
  const runs = [...code.matchAll(/run \d+ "\$cli" ([^<)]*)/g)].map((m) => m[1].trim())
  assert.deepEqual([...new Set(runs)].sort(), ['debug prefs', 'status --json', 'up'])
})

// --- Real output shapes, bounds, and edge cases (tester additions) -----------------
//
// The two fixtures below copy the layout of the real Tailscale 1.104.6 Standalone
// CLI (io.tailscale.ipn.macsys), read with `status --json` and `debug prefs` on a
// Mac where it was Running: `status --json` indents with two spaces and has one
// "BackendState" (at the top level; Self and Peer hold none), and `debug prefs`
// indents with TABS and ends each value with a comma. Node IDs, keys, IPs, and
// names are replaced with placeholders.

const REAL_STATUS_RUNNING = [
  '{',
  '  "Version": "1.104.6-t3b273a64c-gdf9d2ed85",',
  '  "TUN": true,',
  '  "BackendState": "Running",',
  '  "HaveNodeKey": true,',
  '  "AuthURL": "",',
  '  "TailscaleIPs": [',
  '    "100.64.0.1",',
  '    "fd7a:115c:a1e0::1"',
  '  ],',
  '  "Self": {',
  '    "ID": "nPLACEHOLDER",',
  '    "HostName": "homelab",',
  '    "Online": true,',
  '    "ExitNode": false',
  '  },',
  '  "Health": [],',
  '  "Peer": {',
  '    "nodekey:0000": {',
  '      "HostName": "laptop",',
  '      "Online": true',
  '    }',
  '  }',
  '}',
].join('\n')

const realPrefs = (loggedOut) =>
  ['{', '\t"ControlURL": "https://controlplane.tailscale.com",', '\t"RouteAll": false,', '\t"ExitNodeID": "",', '\t"CorpDNS": true,', '\t"RunSSH": false,', '\t"WantRunning": false,', `\t"LoggedOut": ${loggedOut},`, '\t"ShieldsUp": false,', '\t"AdvertiseTags": null,', '\t"AdvertiseRoutes": null', '}'].join('\n')

test('real `status --json` shape (1.104.6, Running, exit 0): healthy, no mail', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({ STUB_STATUS_RAW: REAL_STATUS_RUNNING, STUB_STATUS_RC: '0' })
    assertHealthy(sb, r)
    assert.deepEqual(sb.mails(), [])
  }))

test('real `debug prefs` shape (tabs, trailing comma, exit 0), Stopped and logged in: one `up`, recovered', () =>
  withSandbox({ backend: 'Stopped' }, (sb) => {
    const r = sb.run({ STUB_PREFS_RAW: realPrefs('false'), STUB_PREFS_RC: '0' })
    assert.deepEqual(tsCalls(sb), ['status --json', 'debug prefs', 'up', 'status --json'])
    assertHealthy(sb, r)
    assert.equal(subject(sb.mails()[0]), 'Tailscale recovered on testhost')
  }))

test('real `debug prefs` shape, Stopped and logged out: no up, FAILED logged-out', () =>
  withSandbox({ backend: 'Stopped' }, (sb) => {
    const r = sb.run({ STUB_PREFS_RAW: realPrefs('true'), STUB_PREFS_RC: '0' })
    assertFailed(sb, r, /logged out; log in by hand/)
    assert.ok(!tsCalls(sb).includes('up'))
  }))

test('`debug prefs` with two LoggedOut values: cannot evaluate, no up', () =>
  withSandbox({ backend: 'Stopped' }, (sb) => {
    const r = sb.run({ STUB_PREFS_RAW: '{\n\t"LoggedOut": false,\n\t"Profile": {\n\t\t"LoggedOut": true\n\t}\n}', STUB_PREFS_RC: '0' })
    assertFailed(sb, r, /LoggedOut cannot be read/)
    assert.ok(!tsCalls(sb).includes('up'))
  }))

// The script's own contract: "Exactly one known value must appear in the JSON",
// and a probe that cannot evaluate never counts as healthy. The multi-line case
// is covered above; these put both values on ONE line (compact JSON), where the
// greedy `sed 's/.*"BackendState": *"\(...\)".*/'` keeps only the last value
// and so sees exactly one.
test('compact JSON with two BackendState values (Stopped, then nested Running): never healthy', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({ STUB_STATUS_RAW: '{"BackendState":"Stopped","Self":{"BackendState":"Running"}}', STUB_STATUS_RC: '0' })
    assert.notEqual(r.status, 0, `an ambiguous status counted as healthy:\n${r.stdout}`)
    assert.ok(!tsCalls(sb).includes('up'))
  }))

test('compact JSON with two BackendState values (Running, then nested Stopped): no `tailscale up`', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({ STUB_STATUS_RAW: '{"BackendState":"Running","Self":{"BackendState":"Stopped"}}', STUB_STATUS_RC: '0' })
    assert.ok(!tsCalls(sb).includes('up'), `an ambiguous status ran up: ${tsCalls(sb).join(',')}`)
    assert.notEqual(r.status, 0, r.stdout)
  }))

// --- Bounds: a hung CLI cannot wedge the job ------------------------------------------

test('a hung `status --json` is killed at 10s: cannot evaluate (exit 124), no up, well inside the 5-minute interval', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({ STUB_STATUS_HANG: '1' })
    assert.ok(r.elapsed >= 9 && r.elapsed < 20, `took ${r.elapsed}s`)
    assertFailed(sb, r, /cannot read BackendState from `tailscale status --json` \(exit 124\)/)
    assert.ok(!tsCalls(sb).includes('up'))
    assert.equal(state(sb), 'cannot-evaluate')
  }))

test('a hung `debug prefs` is killed at 10s: cannot evaluate, no up', () =>
  withSandbox({ backend: 'Stopped' }, (sb) => {
    const r = sb.run({ STUB_PREFS_HANG: '1' })
    assert.ok(r.elapsed >= 9 && r.elapsed < 20, `took ${r.elapsed}s`)
    assertFailed(sb, r, /LoggedOut cannot be read from `tailscale debug prefs` \(exit 124\)/)
    assert.ok(!tsCalls(sb).includes('up'))
  }))

// --- More states and transitions -------------------------------------------------------

test('still NoState after the wait: FAILED NoState, no up', () =>
  withSandbox({ backend: 'NoState' }, (sb) => {
    assertFailed(sb, sb.run(), /BackendState is still NoState after 3s/)
    assert.ok(!tsCalls(sb).includes('up'))
    assert.equal(subject(sb.mails()[0]), 'Tailscale is down on testhost: NoState')
  }))

test('`tailscale up` succeeds, then the status cannot be read: FAILED not-running, "unreadable"', () =>
  withSandbox({ backend: 'Stopped' }, (sb) => {
    const r = sb.run({ STUB_AFTER_UP: 'Sleeping' })
    assertFailed(sb, r, /`tailscale up` ran, but the state is unreadable 3s later/)
    assert.equal(state(sb), 'not-running')
  }))

test('`tailscale up` succeeds but leaves NeedsLogin: FAILED not-running, `up` ran once', () =>
  withSandbox({ backend: 'Stopped' }, (sb) => {
    const r = sb.run({ STUB_AFTER_UP: 'NeedsLogin' })
    assertFailed(sb, r, /the state is NeedsLogin 3s later/)
    assert.deepEqual(tsCalls(sb).filter((c) => c === 'up'), ['up'])
  }))

test('an empty state file counts as no report: Running sends no mail', () =>
  withSandbox({}, (sb) => {
    mkdirSync(sb.logs, { recursive: true })
    writeFileSync(sb.statefile, '')
    assertHealthy(sb, sb.run())
    assert.deepEqual(sb.mails(), [])
  }))

test('app started, then Running, but the recovery mail fails: state app-not-running, and the next run reports it', () =>
  withSandbox({ app: false }, (sb) => {
    const r = sb.run({ STUB_MAIL_RC: '1' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(readFileSync(sb.marker, 'utf8'), /Running again \(the Tailscale app was not running; .*\), but the recovery mail failed/)
    assert.equal(state(sb), 'app-not-running')
    assertHealthy(sb, sb.run())
    assert.deepEqual(sb.mails().map(subject), ['Tailscale recovered on testhost'])
    assert.match(sb.mails()[0], /the last report was app-not-running/)
  }))

test('the same failure while the mail keeps failing: each run retries the mail, the marker stays one line', () =>
  withSandbox({ backend: 'NeedsLogin' }, (sb) => {
    for (let i = 0; i < 3; i++) assertFailed(sb, sb.run({ STUB_MAIL_RC: '1' }), /the alert mail failed too/)
    assert.equal(sb.calls().filter((c) => c.startsWith('himalaya')).length, 3)
    assert.equal(existsSync(sb.statefile), false)
  }))

// --- Hostile output text ---------------------------------------------------------------

test('a 5000-character, many-line `up` error: one marker line, bounded, and a one-line mail subject', () =>
  withSandbox({ backend: 'Stopped' }, (sb) => {
    const err = Array.from({ length: 100 }, (_, i) => `line ${i} ` + 'e'.repeat(42)).join('\n')
    const r = sb.run({ STUB_UP_RC: '1', STUB_UP_ERR: err })
    const m = assertFailed(sb, r, /`tailscale up` failed/)
    assert.ok(Buffer.byteLength(m) < 600, `marker is ${Buffer.byteLength(m)} bytes`)
    const mail = sb.mails()[0]
    assert.equal(subject(mail), 'Tailscale is down on testhost: up-failed')
    assert.ok(!/line 99/.test(mail), 'the reason was not cut at 300 characters')
  }))

// Marker and mail text must stay valid UTF-8 when the CLI's own output is valid
// UTF-8: the shell banner prints the marker, and himalaya sends the message it
// reads on stdin. Under launchd there is no LANG, so `cut -c` counts bytes
// (as GNU cut in this container always does) and can split a multi-byte character.
test('a non-ASCII `up` error that crosses the 300-character cut: marker and mail stay valid UTF-8', () =>
  withSandbox({ backend: 'Stopped' }, (sb) => {
    const r = sb.run({ STUB_UP_RC: '1', STUB_UP_ERR: 'x'.repeat(299) + '☁ réseau indisponible' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    const strict = new TextDecoder('utf-8', { fatal: true })
    assert.doesNotThrow(() => strict.decode(readFileSync(sb.marker)), 'marker is not valid UTF-8')
    const mailFile = readdirSync(join(sb.base, 'state')).find((f) => f.startsWith('mail.'))
    assert.doesNotThrow(() => strict.decode(readFileSync(join(sb.base, 'state', mailFile))), 'mail is not valid UTF-8')
  }))

test('hostname fails: the mail names "this Mac" instead', () =>
  withSandbox({ backend: 'NeedsLogin' }, (sb) => {
    writeFileSync(join(sb.bin, 'hostname'), '#!/bin/sh\nexit 1\n')
    assertFailed(sb, sb.run(), /NeedsLogin/)
    assert.equal(subject(sb.mails()[0]), 'Tailscale is down on this Mac: NeedsLogin')
  }))
