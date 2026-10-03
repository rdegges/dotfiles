// dot_zshenv: the 1Password CLI app-integration switch and its documented
// per-command opt-out.
//
// Run from the repo root (zsh is needed; without it the shell tests skip):
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'apt-get update -qq && apt-get install -y -qq zsh >/dev/null && node --test tests/zsh/'
//
// What a pass proves: dot_zshenv parses; a non-interactive zsh that loads it
// (the `ssh host cmd` and agent-shell case) hands OP_BIOMETRIC_UNLOCK_ENABLED=true
// to child processes; the opt-out command written in the comment, run as
// written against a stub `op`, hands that `op` false; and no later zsh startup
// file in the repo reassigns or unsets the variable. It says nothing about the
// real op binary or the 1Password app; those were checked by hand in the gate run.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, chmodSync, copyFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('../../', import.meta.url)
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8')
const ZSHENV = new URL('dot_zshenv', ROOT).pathname
const VAR = 'OP_BIOMETRIC_UNLOCK_ENABLED'

const hasZsh = spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).status === 0
const zskip = hasZsh ? false : 'zsh not installed (see the run command at the top)'

// A ZDOTDIR holding only the repo's .zshenv, plus a stub `op` that reports the
// value it received, first on PATH.
function withZdot(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'zshenv-'))
  try {
    copyFileSync(ZSHENV, join(dir, '.zshenv'))
    const stub = join(dir, 'op')
    writeFileSync(stub, `#!/bin/sh\nprintf 'op %s=%s\\n' "$*" "\${${VAR}-unset}"\n`)
    chmodSync(stub, 0o755)
    // HOME points at the sandbox so .zshenv's $HOME/.local/bin is harmless.
    const run = (cmd) =>
      spawnSync('zsh', ['-c', `PATH=${dir}:$PATH; ${cmd}`], {
        encoding: 'utf8',
        env: { HOME: dir, ZDOTDIR: dir, PATH: '/usr/bin:/bin' },
      })
    return fn(run)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('dot_zshenv parses (zsh -n)', { skip: zskip }, () => {
  const r = spawnSync('zsh', ['-n', ZSHENV], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
})

test(`dot_zshenv has exactly one live ${VAR} line, and it exports true`, () => {
  const live = read('dot_zshenv')
    .split('\n')
    .filter((l) => l.includes(VAR) && !l.trimStart().startsWith('#'))
  assert.deepEqual(live, [`export ${VAR}=true`])
})

test(`non-interactive zsh exports ${VAR}=true to child processes`, { skip: zskip }, () =>
  withZdot((run) => {
    // env(1) is a child process: this fails if the line ever drops `export`.
    const r = run('env')
    assert.equal(r.status, 0, r.stderr)
    assert.ok(r.stdout.split('\n').includes(`${VAR}=true`), r.stdout)
  }))

test('the opt-out command in the comment, run as written, gives op false', { skip: zskip }, () => {
  const marker = 'opt out per command:'
  const line = read('dot_zshenv').split('\n').find((l) => l.startsWith('#') && l.includes(marker))
  assert.ok(line, `no "${marker}" comment in dot_zshenv`)
  const cmd = line.slice(line.indexOf(marker) + marker.length).trim()
  assert.match(cmd, /\bop\b/, cmd)
  withZdot((run) => {
    const r = run(cmd)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, new RegExp(`^op .*=false$`, 'm'), r.stdout)
    // The opt-out is per command: the shell keeps the export for the next op.
    const after = run(`${cmd} >/dev/null; op whoami`)
    assert.match(after.stdout, /^op whoami=true$/m, after.stdout)
  })
})

test(`no zsh startup file loaded after .zshenv reassigns or unsets ${VAR}`, () => {
  // .zprofile, .zshrc, and oh-my-zsh custom files run after .zshenv in login
  // and interactive shells, so any of them could silently undo the switch.
  const files = ['dot_zprofile', 'dot_zshrc', 'dot_zlogin']
  const walk = (rel) => {
    for (const name of readdirSync(new URL(rel + '/', ROOT))) {
      const p = `${rel}/${name}`
      if (statSync(new URL(p, ROOT)).isDirectory()) walk(p)
      else files.push(p)
    }
  }
  walk('dot_oh-my-zsh')
  const hits = []
  for (const f of files) {
    let text
    try {
      text = read(f)
    } catch {
      continue // dot_zlogin does not exist today; listed so adding it is covered.
    }
    text.split('\n').forEach((l, i) => {
      if (l.includes(VAR) && !l.trimStart().startsWith('#')) hits.push(`${f}:${i + 1}: ${l}`)
    })
  }
  assert.deepEqual(hits, [])
})
