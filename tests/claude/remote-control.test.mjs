// remoteControlAtStartup: dot_claude/settings.json and the unattended
// vault-agent-settings.json profile both set it to true, so a session starts
// the Remote Control bridge without /remote-control or --rc.
//
// Run from the repo root (needs `script` from util-linux, which node:latest
// ships, and the real `claude` CLI: CLAUDE_BIN, else `claude` on PATH; without
// the CLI the probe tests FAIL, they do not skip):
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'npm i -g @anthropic-ai/claude-code@latest >/dev/null && node --test tests/claude/remote-control.test.mjs'
//
// What a pass proves, with the CLI started in a throwaway HOME and config dir
// (no login, API base pointed at a closed local port):
// - both files set remoteControlAtStartup to the boolean true at the top level
//   (the CLI's schema takes a boolean there).
// - an interactive session (in a pty) with the repo's settings.json as user
//   settings runs the REPL's Remote Control bridge init. A control with the key
//   set to false must mount the REPL and run no bridge init, so the init line
//   is caused by the key and a renamed log line fails closed.
// - with the key false in user settings, `--settings vault-agent-settings.json`
//   still runs the bridge init: the CLI reads the key from a --settings file
//   (it ignores a true in project or local settings), so the profile's own key
//   works.
// - `claude -p` with the repo's settings.json runs no bridge init at all
//   (CLI 2.1.322): the key has no effect on print-mode runs.
// It says nothing about a signed-in session reaching claude.ai (without a
// login the init stops at "bridge not enabled"), about managed settings or org
// policy that can lock Remote Control off on the work Mac, or about the
// desktop app or IDE hosts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const SOURCE = new URL('../../', import.meta.url).pathname
const SETTINGS_PATH = join(SOURCE, 'dot_claude/settings.json')
const VAULT_PROFILE = join(SOURCE, 'dot_claude/vault-agent-settings.json')
const SETTINGS = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
const VAULT = JSON.parse(readFileSync(VAULT_PROFILE, 'utf8'))
const KEY = 'remoteControlAtStartup'
const MOUNTED = '[REPL:mount] REPL mounted'
const BRIDGE_INIT = '[bridge:repl]'
const ANY_BRIDGE = '[bridge'

function claudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN
  const r = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : undefined
}

function sandbox(userSettings) {
  const root = mkdtempSync(join(tmpdir(), 'remote-control-'))
  const home = join(root, 'home')
  const config = join(root, 'config')
  const project = join(root, 'project')
  mkdirSync(home)
  mkdirSync(config)
  mkdirSync(join(project, '.claude'), { recursive: true })
  writeFileSync(join(config, 'settings.json'), JSON.stringify(userSettings))
  // Skip onboarding and the trust dialog so the REPL mounts with no input.
  writeFileSync(
    join(config, '.claude.json'),
    JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [project]: { hasTrustDialogAccepted: true } } }),
  )
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    CLAUDE_CONFIG_DIR: config,
    TERM: 'xterm',
    // Any API call dies locally: this probe must never reach a model.
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    // The repo's settings.json puts sessions in bypass mode, which the CLI
    // refuses for root (as in the Docker run above) unless it is told it runs
    // in a sandbox. Off root, the probe runs as the user's sessions do.
    ...(process.getuid?.() === 0 && { IS_SANDBOX: '1' }),
  }
  return { root, project, env, log: join(root, 'debug.log') }
}

const readLog = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const shq = (s) => `'${s.replaceAll("'", `'\\''`)}'`

// Starts an interactive session in a pty (`script`), waits for the REPL to
// mount, gives the bridge init `graceMs` to log, then stops the session and
// returns the debug log. Fails if the REPL never mounts: no mount, no verdict.
async function runInteractive(userSettings, args = [], graceMs = 8_000) {
  const bin = claudeBin()
  assert.ok(bin, 'real claude CLI not found: set CLAUDE_BIN or put claude on PATH')
  const hasScript = spawnSync('sh', ['-c', 'command -v script'], { encoding: 'utf8' }).status === 0
  assert.ok(hasScript, '`script` (util-linux) not installed: the probe needs a pty')
  const s = sandbox(userSettings)
  try {
    const cmd = [bin, '--debug-file', s.log, ...args].map(shq).join(' ')
    const child = spawn('script', ['-qfec', cmd, '/dev/null'], { cwd: s.project, env: s.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const exited = new Promise((resolve) => child.on('exit', resolve))
    let mountedAt
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      const text = readLog(s.log)
      if (mountedAt === undefined && text.includes(MOUNTED)) mountedAt = Date.now()
      if (mountedAt !== undefined && (text.includes(BRIDGE_INIT) || Date.now() - mountedAt > graceMs)) break
      if (child.exitCode !== null) break
      await sleep(200)
    }
    child.kill('SIGTERM')
    await Promise.race([exited, sleep(5_000)])
    if (child.exitCode === null) child.kill('SIGKILL')
    const text = readLog(s.log)
    assert.ok(text.includes(MOUNTED), `probe cannot evaluate: the REPL never logged "${MOUNTED}"\n${text.slice(-2000)}\n${out.slice(-2000)}`)
    return text
  } finally {
    rmSync(s.root, { recursive: true, force: true })
  }
}

function runPrint(userSettings, args = []) {
  const bin = claudeBin()
  assert.ok(bin, 'real claude CLI not found: set CLAUDE_BIN or put claude on PATH')
  const s = sandbox(userSettings)
  try {
    const r = spawnSync(bin, ['--debug-file', s.log, ...args, '-p', 'ok'], {
      cwd: s.project,
      env: s.env,
      encoding: 'utf8',
      input: '',
      timeout: 120_000,
    })
    assert.ifError(r.error)
    const text = readLog(s.log)
    assert.ok(text.length > 0, `claude wrote no debug log (exit ${r.status}): ${r.stdout}${r.stderr}`)
    return text
  } finally {
    rmSync(s.root, { recursive: true, force: true })
  }
}

const bridgeLines = (text) => text.split('\n').filter((l) => l.includes(ANY_BRIDGE))
const keyOff = { ...SETTINGS, [KEY]: false }

test(`settings.json and the vault profile set ${KEY} to the boolean true at the top level`, () => {
  assert.equal(SETTINGS[KEY], true, `dot_claude/settings.json ${KEY} is ${JSON.stringify(SETTINGS[KEY])}`)
  assert.equal(VAULT[KEY], true, `dot_claude/vault-agent-settings.json ${KEY} is ${JSON.stringify(VAULT[KEY])}`)
  assert.ok(!(KEY in (SETTINGS.env ?? {})) && !(KEY in (SETTINGS.permissions ?? {})), `${KEY} is nested where the CLI does not read it`)
})

test(`an interactive session with the repo's settings.json runs the Remote Control bridge init (control: ${KEY} false runs none)`, async () => {
  const control = await runInteractive(keyOff)
  assert.deepEqual(
    bridgeLines(control),
    [],
    `probe cannot evaluate: with ${KEY} false the CLI still logged bridge lines, so they are not caused by the key`,
  )
  const actual = await runInteractive(SETTINGS)
  assert.ok(
    actual.includes(BRIDGE_INIT),
    `with dot_claude/settings.json the REPL mounted but logged no "${BRIDGE_INIT}" init: the key does not start Remote Control, or the log line changed`,
  )
})

test(`--settings vault-agent-settings.json turns Remote Control on by itself in an interactive session`, async () => {
  // Control: the same run with the profile's key false must start no bridge,
  // so a pass below is caused by the profile's own key.
  const dir = mkdtempSync(join(tmpdir(), 'vault-profile-'))
  try {
    const vaultOff = join(dir, 'vault-agent-settings.json')
    writeFileSync(vaultOff, JSON.stringify({ ...VAULT, [KEY]: false }))
    const control = await runInteractive(keyOff, ['--settings', vaultOff])
    assert.deepEqual(
      bridgeLines(control),
      [],
      `probe cannot evaluate: with ${KEY} false in user settings and in the vault profile the CLI still logged bridge lines, so they are not caused by the key`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const actual = await runInteractive(keyOff, ['--settings', VAULT_PROFILE])
  assert.ok(
    actual.includes(BRIDGE_INIT),
    `with ${KEY} false in user settings, the vault profile's own ${KEY} did not start the bridge init: the CLI does not read the key from a --settings file`,
  )
})

// Pins a CLI limit, not a repo choice: in CLI 2.1.322 the key starts only the
// interactive REPL bridge. If this fails, a newer CLI starts Remote Control in
// print mode too, and the vault profile's $comment and the README become true
// for `claude -p` runs.
test(`claude -p with the repo's settings.json runs no Remote Control bridge init (${KEY} reaches interactive sessions only)`, () => {
  const actual = runPrint(SETTINGS)
  assert.deepEqual(bridgeLines(actual), [], `claude -p logged bridge lines: Remote Control now starts in print mode`)
  const vault = runPrint(SETTINGS, ['--settings', VAULT_PROFILE])
  assert.deepEqual(bridgeLines(vault), [], `claude -p --settings vault-agent-settings.json logged bridge lines`)
})
