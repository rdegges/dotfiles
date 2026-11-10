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
  // The cc alias starts bypass mode with a flag; -p does not show the notice
  // for defaultMode alone, so both runs pass the flag.
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
