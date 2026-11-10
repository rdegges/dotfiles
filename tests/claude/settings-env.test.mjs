// CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS (lifts bypass mode's last
// block on commands such as `rm -rf ~`) and the settings.json `env` block.
// Claude Code drops some keys from every settings file and reads them only from
// the environment it starts in; this key is one, so dot_zshenv exports it.
//
// Run from the repo root (needs zsh and the real `claude` CLI: CLAUDE_BIN, else
// `claude` on PATH; without the CLI the probe tests FAIL, they do not skip):
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'apt-get update -qq && apt-get install -y -qq zsh >/dev/null && npm i -g @anthropic-ai/claude-code@latest >/dev/null && node --test tests/claude/settings-env.test.mjs'
//
// What a pass proves: settings.json parses, its env values are of a type the
// CLI keeps, and the real CLI, started in a throwaway HOME and config dir (no
// login, API base pointed at a closed local port):
// - with only that env block as a project settings file, logs no "no settings
//   file can set this key" warning for any of its keys. A positive control
//   (CLAUDE_CODE_MANAGED_SETTINGS_PATH, which the CLI refuses from settings)
//   must draw that warning, so a renamed message fails closed.
// - started by a non-interactive zsh that loads only the repo's dot_zshenv,
//   in bypass mode as the cc alias starts it, prints its "is set, so dangerous
//   rm commands" notice. A control run of the same zsh with the export removed
//   must not print it, so the notice is caused by dot_zshenv.
// - no other zsh startup file in the repo sets or unsets the key, and
//   settings.json env does not set it (one source).
// - the cc alias passes the flag the probe uses, and an interactive login zsh
//   with the repo's .zprofile and .zshrc still exports the key.
// - with the repo's real settings.json as user settings, the CLI in bypass mode
//   says the waiver is set, not that it "has no effect in this session" (some
//   permission rules, such as a Read deny rule, switch it off; a control with
//   one must draw that message).
// - settings.json has no top-level defaultMode, which the CLI never reads (it
//   reads only permissions.defaultMode); if permissions.defaultMode is
//   bypassPermissions, the CLI started from zsh with that settings file alone
//   (no flag) acknowledges the waiver.
// It says nothing about the desktop app (it never sources dot_zshenv), about
// a real rm tool call, or about managed settings on the work Mac.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SOURCE = new URL('../../', import.meta.url).pathname
const SETTINGS = JSON.parse(readFileSync(join(SOURCE, 'dot_claude/settings.json'), 'utf8'))
const ENV = SETTINGS.env ?? {}
const CONTROL = 'CLAUDE_CODE_MANAGED_SETTINGS_PATH'
const REFUSED = 'no settings file can set this key'
const RM_GUARD_KEY = 'CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS'
const RM_GUARD_NOTICE = `${RM_GUARD_KEY} is set, so dangerous rm commands`
const RM_GUARD_INERT = `${RM_GUARD_KEY} has no effect in this session`
const ZSHENV = readFileSync(join(SOURCE, 'dot_zshenv'), 'utf8')
const EXPORT_LINE = `export ${RM_GUARD_KEY}=1`

function claudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN
  const r = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : undefined
}

// Runs `claude -p ok` in a throwaway HOME/config dir and returns its debug log
// plus stdout/stderr. `userSettings` and `projectSettings` are written as the
// user (~/.claude) and project (.claude) settings files when given.
// With `zshenv`, the CLI is exec'd by a non-interactive zsh whose ZDOTDIR
// holds only that text as .zshenv, the way a terminal or `ssh host cmd` starts it.
function runClaude({ userSettings, projectSettings, extraEnv = {}, args = [], zshenv }) {
  const bin = claudeBin()
  assert.ok(bin, 'real claude CLI not found: set CLAUDE_BIN or put claude on PATH')
  const root = mkdtempSync(join(tmpdir(), 'settings-env-'))
  try {
    const home = join(root, 'home')
    const config = join(root, 'config')
    const project = join(root, 'project')
    mkdirSync(home)
    mkdirSync(config)
    mkdirSync(join(project, '.claude'), { recursive: true })
    if (userSettings) writeFileSync(join(config, 'settings.json'), JSON.stringify(userSettings))
    if (projectSettings) writeFileSync(join(project, '.claude/settings.json'), JSON.stringify(projectSettings))
    const log = join(root, 'debug.log')
    const argv = ['--debug-file', log, ...args, '-p', 'ok']
    let cmd = bin
    let cmdArgs = argv
    if (zshenv !== undefined) {
      writeFileSync(join(home, '.zshenv'), zshenv)
      cmd = 'zsh'
      cmdArgs = ['-c', 'exec "$@"', 'zsh', bin, ...argv]
    }
    const r = spawnSync(cmd, cmdArgs, {
      cwd: project,
      encoding: 'utf8',
      input: '',
      timeout: 120_000,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        ZDOTDIR: home,
        CLAUDE_CONFIG_DIR: config,
        // Any API call dies locally: this probe must never reach a model.
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
        ...extraEnv,
      },
    })
    assert.ifError(r.error)
    let text
    try {
      text = readFileSync(log, 'utf8')
    } catch {
      assert.fail(`claude wrote no debug log (exit ${r.status}): ${r.stdout}${r.stderr}`)
    }
    return `${text}\n${r.stdout}\n${r.stderr}`
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// Returns the set of env keys the CLI says no settings file may set.
function refusedKeys(env) {
  const text = runClaude({ projectSettings: { env } })
  const refused = new Set()
  for (const line of text.split('\n')) {
    if (!line.includes(REFUSED)) continue
    for (const key of Object.keys(env)) if (line.includes(`${key} in `)) refused.add(key)
  }
  return refused
}

// The CLI drops any env value that is not a string, a number or a boolean.
test('settings.json env values are strings, numbers or booleans', () => {
  for (const [key, value] of Object.entries(ENV)) {
    assert.ok(['string', 'number', 'boolean'].includes(typeof value), `env.${key} is ${JSON.stringify(value)}, which the CLI drops`)
  }
})

test('the real CLI honors every env key settings.json sets (none is environment-only)', () => {
  const refused = refusedKeys({ ...ENV, [CONTROL]: '/nonexistent' })
  assert.ok(
    refused.has(CONTROL),
    `probe cannot evaluate: the CLI did not refuse the control key ${CONTROL}; its warning text may have changed`,
  )
  refused.delete(CONTROL)
  assert.deepEqual(
    [...refused],
    [],
    `Claude Code ignores these keys in every settings file, so dot_claude/settings.json sets them for nothing: ${[...refused].join(', ')}`,
  )
})

test(`dot_zshenv exports ${RM_GUARD_KEY} and the CLI started from zsh acknowledges it`, () => {
  const live = ZSHENV.split('\n').filter((l) => l.includes(RM_GUARD_KEY) && !l.trimStart().startsWith('#'))
  assert.deepEqual(live, [EXPORT_LINE], `dot_zshenv must have exactly one live line: ${EXPORT_LINE}`)
  // Empty user settings, so the flag (as the cc alias passes it) is what
  // turns bypass mode on in both runs. The defaultMode test below covers
  // plain `claude` with the repo's settings.json.
  const args = ['--dangerously-skip-permissions']
  const control = runClaude({ args, userSettings: {}, zshenv: ZSHENV.replace(EXPORT_LINE, '') })
  assert.ok(
    !control.includes(RM_GUARD_NOTICE),
    `probe cannot evaluate: the CLI printed "${RM_GUARD_NOTICE}" with the export removed, so the notice is not caused by dot_zshenv`,
  )
  const actual = runClaude({ args, userSettings: {}, zshenv: ZSHENV })
  assert.ok(
    actual.includes(RM_GUARD_NOTICE),
    `the CLI started from zsh with dot_zshenv printed no "${RM_GUARD_NOTICE}" notice: the export does not reach it, or the notice wording changed`,
  )
})

test(`${RM_GUARD_KEY} has one source: dot_zshenv`, () => {
  assert.ok(!(RM_GUARD_KEY in ENV), `dot_claude/settings.json env sets ${RM_GUARD_KEY}, which the CLI ignores there`)
  const others = ['dot_zprofile', 'dot_zshrc']
  const custom = 'dot_oh-my-zsh/custom'
  const walk = (d) =>
    readdirSync(join(SOURCE, d), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
    )
  for (const f of [...others, ...walk(custom)]) {
    const hits = readFileSync(join(SOURCE, f), 'utf8')
      .split('\n')
      .filter((l) => l.includes(RM_GUARD_KEY) && !l.trimStart().startsWith('#'))
    assert.deepEqual(hits, [], `${f} also sets or unsets ${RM_GUARD_KEY}`)
  }
})

// The probe above passes --dangerously-skip-permissions because that is how the
// cc alias starts claude. Pin the alias so the probe cannot drift from it.
test('the cc alias starts claude with --dangerously-skip-permissions, as the probe does', () => {
  const aliases = readFileSync(join(SOURCE, 'dot_oh-my-zsh/custom/aliases.zsh.tmpl'), 'utf8')
  const cc = aliases.split('\n').filter((l) => /^\s*alias cc=/.test(l))
  assert.equal(cc.length, 1, `expected one cc alias, found: ${cc.join(' | ')}`)
  const words = cc[0].replace(/^\s*alias cc=["']?/, '').replace(/["']\s*$/, '').split(/\s+/)
  assert.equal(words[0], 'claude', cc[0])
  assert.ok(words.includes('--dangerously-skip-permissions'), cc[0])
})

// The one-source test greps for the key by name, so a pattern unset (for
// example `unset -m 'CLAUDE_*'`) in .zprofile or .zshrc would slip past it.
// Run the real files the way a terminal does (login + interactive) and check
// the key still reaches a child process. Oh My Zsh, brew, and starship are not
// installed here, so those lines fail; the ZSH sentinel proves .zshrc ran.
test(`an interactive login zsh with the repo's .zprofile and .zshrc still exports ${RM_GUARD_KEY}`, () => {
  const hasZsh = spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).status === 0
  assert.ok(hasZsh, 'zsh not installed (see the run command at the top)')
  const home = mkdtempSync(join(tmpdir(), 'settings-env-zsh-'))
  try {
    writeFileSync(join(home, '.zshenv'), ZSHENV)
    writeFileSync(join(home, '.zprofile'), readFileSync(join(SOURCE, 'dot_zprofile'), 'utf8'))
    writeFileSync(join(home, '.zshrc'), readFileSync(join(SOURCE, 'dot_zshrc'), 'utf8'))
    const r = spawnSync('zsh', ['-l', '-i', '-c', `print -r -- "ZSH=$ZSH"; printenv ${RM_GUARD_KEY}`], {
      encoding: 'utf8',
      input: '',
      timeout: 30_000,
      env: { PATH: '/usr/bin:/bin', HOME: home, ZDOTDIR: home, TERM: 'dumb' },
    })
    assert.ifError(r.error)
    const out = r.stdout.split('\n')
    assert.ok(out.includes(`ZSH=${join(home, '.oh-my-zsh')}`), `.zshrc did not run: ${r.stdout}${r.stderr}`)
    assert.ok(out.includes('1'), `${RM_GUARD_KEY} did not survive .zprofile and .zshrc: ${r.stdout}${r.stderr}`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// The CLI drops the waiver for the whole session when some permission rules
// are present (a Read deny rule, for example), and says so. The probe above
// runs with empty user settings, so a rule added to settings.json later would
// switch the waiver off with every other test still green.
test(`with the repo's settings.json, the CLI in bypass mode keeps ${RM_GUARD_KEY} in effect`, () => {
  const args = ['--dangerously-skip-permissions']
  const control = runClaude({
    args,
    userSettings: { ...SETTINGS, permissions: { ...SETTINGS.permissions, deny: ['Read(./settings-env-control)'] } },
    zshenv: ZSHENV,
  })
  assert.ok(
    control.includes(RM_GUARD_INERT),
    `probe cannot evaluate: a Read deny rule did not draw "${RM_GUARD_INERT}"; the CLI's rule check or its wording changed`,
  )
  const actual = runClaude({ args, userSettings: SETTINGS, zshenv: ZSHENV })
  assert.ok(!actual.includes(RM_GUARD_INERT), `dot_claude/settings.json switches the waiver off: the CLI printed "${RM_GUARD_INERT}"`)
  assert.ok(actual.includes(RM_GUARD_NOTICE), `the CLI with dot_claude/settings.json printed no "${RM_GUARD_NOTICE}" notice`)
})

// dot_zshenv and the README say bypass mode comes from settings.json
// permissions.defaultMode. The CLI reads the setting only there; a top-level
// defaultMode is dropped without a warning, which once left plain `claude` out
// of bypass mode so that only `cc` got the waiver.
test('settings.json has no top-level defaultMode (the CLI reads only permissions.defaultMode)', () => {
  assert.ok(
    !('defaultMode' in SETTINGS),
    `dot_claude/settings.json sets defaultMode=${JSON.stringify(SETTINGS.defaultMode)} at the top level, where the CLI ignores it; move it under permissions or delete it`,
  )
  if (SETTINGS.permissions?.defaultMode !== 'bypassPermissions') return
  const actual = runClaude({ userSettings: SETTINGS, zshenv: ZSHENV })
  assert.ok(
    actual.includes(RM_GUARD_NOTICE),
    `permissions.defaultMode is bypassPermissions, but claude started without the flag printed no "${RM_GUARD_NOTICE}" notice`,
  )
})

// Moving defaultMode under permissions made the user settings put every session
// in bypass mode. The unattended vault profile (`claude --settings
// vault-agent-settings.json`) layers on top of those user settings, so its own
// permissions.defaultMode "default" must still win, or the waiver would reach
// scheduled runs. The control is the same run without --settings.
const VAULT_PROFILE = join(SOURCE, 'dot_claude/vault-agent-settings.json')

test(`the vault profile over the repo's settings.json is not in bypass mode, so ${RM_GUARD_KEY} does not reach it`, () => {
  const control = runClaude({ userSettings: SETTINGS, zshenv: ZSHENV })
  assert.ok(
    control.includes(RM_GUARD_NOTICE),
    `probe cannot evaluate: without --settings the CLI printed no "${RM_GUARD_NOTICE}" notice`,
  )
  const actual = runClaude({ args: ['--settings', VAULT_PROFILE], userSettings: SETTINGS, zshenv: ZSHENV })
  // The CLI prints one of these two messages only in bypass mode, so neither
  // means the vault profile's defaultMode won. INERT alone would mean bypass
  // mode with the waiver switched off by the deny rules: still a regression.
  for (const msg of [RM_GUARD_NOTICE, RM_GUARD_INERT]) {
    assert.ok(
      !actual.includes(msg),
      `claude --settings vault-agent-settings.json printed "${msg}", so it runs in bypass mode: the user settings' permissions.defaultMode overrides the vault profile's`,
    )
  }
})

// The README says the vault profile keeps the guard even in bypass mode,
// because its deny rules switch the waiver off (CLI 2.1.322: any deny rule
// does, Bash or Edit as well as Read). Pin that claim: the vault profile
// started with the cc alias's flag still keeps the guard.
test(`the vault profile switches ${RM_GUARD_KEY} off even with --dangerously-skip-permissions`, () => {
  const actual = runClaude({
    args: ['--dangerously-skip-permissions', '--settings', VAULT_PROFILE],
    userSettings: SETTINGS,
    zshenv: ZSHENV,
  })
  assert.ok(
    actual.includes(RM_GUARD_INERT),
    `the vault profile in bypass mode did not print "${RM_GUARD_INERT}": its deny rules no longer switch the waiver off, so the README's claim is false`,
  )
  assert.ok(!actual.includes(RM_GUARD_NOTICE), `the vault profile in bypass mode printed "${RM_GUARD_NOTICE}"`)
})
