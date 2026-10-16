// run_once_before_preserve-ssh-config.sh on its own (no chezmoi), plus the
// chezmoi behaviors its safety depends on. ssh-config.test.mjs covers the
// main migration paths through a full apply; this file covers the error
// branches and edge inputs a full apply does not reach.
//
// Run from the repo root, same image as ssh-config.test.mjs:
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'apt-get update -qq && apt-get install -y -qq openssh-client >/dev/null &&
//      sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin &&
//      node --test tests/ssh/'
//
// What a pass proves: the script exits non-zero with a message and writes
// nothing when it cannot read ~/.ssh/config or cannot write config.local
// (permission tests drop to uid 1000 with setpriv when run as root, and skip
// if they cannot); it leaves a dangling config.local symlink alone; it treats
// a missing or dangling ~/.ssh/config as nothing to keep; paths with spaces
// and non-ASCII work. Through chezmoi (Linux only): `apply --dry-run` copies
// nothing; a failure later in the same apply still records the run_once, so
// the next apply does not stop on the copy the script made; and a config from
// the first managed version (no Include line) is copied but still resolves to
// port 443. The PROPOSED CONTRACT todo pins the known gap that a
// target-limited apply of ~/.ssh skips the script.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, lstatSync, readlinkSync, symlinkSync, chmodSync, chownSync, cpSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('../../', import.meta.url)
const SCRIPT = new URL('run_once_before_preserve-ssh-config.sh', ROOT).pathname
const MANAGED = readFileSync(new URL('private_dot_ssh/private_config', ROOT), 'utf8')

const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0
const isRoot = process.getuid?.() === 0
// Root ignores file modes, so permission tests run the script as uid 1000.
const pskip = isRoot && !has('setpriv') ? 'root without setpriv cannot test permission failures' : false
const askip = (!has('chezmoi') && 'chezmoi not installed') || (process.platform !== 'linux' && 'full apply runs the darwin scripts (run in Docker)')
const sskip = has('ssh') ? false : 'ssh not installed'

function withHome(fn, name = 'home') {
  const base = mkdtempSync(join(tmpdir(), 'preserve-'))
  try {
    const home = join(base, name)
    mkdirSync(home)
    return fn({ base, home, ssh: join(home, '.ssh') })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

function runScript(home, { dropPrivs = false } = {}) {
  const env = { PATH: process.env.PATH, HOME: home }
  if (dropPrivs && isRoot) {
    return spawnSync('setpriv', ['--reuid=1000', '--regid=1000', '--clear-groups', 'sh', SCRIPT], { encoding: 'utf8', env })
  }
  return spawnSync('sh', [SCRIPT], { encoding: 'utf8', env })
}

// Give the scratch tree to uid 1000 so the dropped-privilege run owns it.
function chownTree(dir) {
  if (!isRoot) return
  chownSync(dir, 1000, 1000)
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) chownTree(p)
    else if (!e.isSymbolicLink()) chownSync(p, 1000, 1000)
  }
}

// --- The script on its own ------------------------------------------------------

test('no ~/.ssh/config: exit 0, silent, nothing created', () =>
  withHome(({ home, ssh }) => {
    mkdirSync(ssh)
    const r = runScript(home)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout + r.stderr, '')
    assert.deepEqual(readdirSync(ssh), [])
  }))

test('a dangling ~/.ssh/config symlink has nothing to keep: exit 0, no config.local', () =>
  withHome(({ home, ssh }) => {
    mkdirSync(ssh)
    symlinkSync(join(home, 'gone'), join(ssh, 'config'))
    const r = runScript(home)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(existsSync(join(ssh, 'config.local')), false)
  }))

test('~/.ssh/config is a directory: exit 1 with "cannot read", no config.local', () =>
  withHome(({ home, ssh }) => {
    mkdirSync(join(ssh, 'config'), { recursive: true })
    const r = runScript(home)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /preserve-ssh-config: cannot read /)
    assert.equal(existsSync(join(ssh, 'config.local')), false)
  }))

test('unreadable ~/.ssh/config: exit 1 with "cannot read", no config.local', { skip: pskip }, () =>
  withHome(({ base, home, ssh }) => {
    mkdirSync(ssh)
    writeFileSync(join(ssh, 'config'), 'Host personal\n  Hostname 192.0.2.1\n')
    chownTree(base)
    chmodSync(join(ssh, 'config'), 0o000)
    const r = runScript(home, { dropPrivs: true })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stderr, /preserve-ssh-config: cannot read /)
    assert.equal(existsSync(join(ssh, 'config.local')), false)
  }))

test('~/.ssh not writable: exit 1 with "cannot copy", config unchanged, no config.local', { skip: pskip }, () =>
  withHome(({ base, home, ssh }) => {
    mkdirSync(ssh)
    const old = 'Host personal\n  Hostname 192.0.2.1\n'
    writeFileSync(join(ssh, 'config'), old)
    chownTree(base)
    chmodSync(ssh, 0o500)
    try {
      const r = runScript(home, { dropPrivs: true })
      assert.equal(r.status, 1, r.stdout + r.stderr)
      assert.match(r.stderr, /preserve-ssh-config: cannot copy /)
      assert.equal(readFileSync(join(ssh, 'config'), 'utf8'), old)
      assert.equal(existsSync(join(ssh, 'config.local')), false)
    } finally {
      chmodSync(ssh, 0o700)
    }
  }))

test('a dangling config.local symlink stops the script; the link and its target stay as they were', () =>
  withHome(({ home, ssh }) => {
    mkdirSync(ssh)
    writeFileSync(join(ssh, 'config'), 'Host personal\n  Hostname 192.0.2.1\n')
    const target = join(home, 'elsewhere', 'local')
    symlinkSync(target, join(ssh, 'config.local'))
    const r = runScript(home)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /merge .* by hand/)
    assert.equal(lstatSync(join(ssh, 'config.local')).isSymbolicLink(), true)
    assert.equal(readlinkSync(join(ssh, 'config.local')), target)
    assert.equal(existsSync(target), false, 'cp wrote through the dangling symlink')
  }))

test('a HOME with spaces and non-ASCII: the config is copied byte for byte and the success line names it', () =>
  withHome(({ home, ssh }) => {
    mkdirSync(ssh)
    const old = 'Host café\n  Hostname 192.0.2.1\n'
    writeFileSync(join(ssh, 'config'), old)
    const r = runScript(home)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readFileSync(join(ssh, 'config.local'), 'utf8'), old)
    assert.ok(r.stdout.includes(`copied ${join(ssh, 'config')} to ${join(ssh, 'config.local')}`), r.stdout)
  }, 'my home é'))

test('the script alone is not idempotent: a second run stops on its own copy (chezmoi run_once recording is load-bearing)', () =>
  withHome(({ home, ssh }) => {
    mkdirSync(ssh)
    writeFileSync(join(ssh, 'config'), 'Host personal\n  Hostname 192.0.2.1\n')
    assert.equal(runScript(home).status, 0)
    const r = runScript(home)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /already exists/)
  }))

// --- Through chezmoi --------------------------------------------------------------

function withDeploy(fn, src = ROOT.pathname) {
  return withHome(({ base, home, ssh }) => {
    const cfg = join(base, 'chezmoi.toml')
    writeFileSync(cfg, '[data]\n  work = false\n')
    const cz = (...args) =>
      spawnSync(
        'chezmoi',
        ['--source', src, '--destination', home, '--config', cfg, '--no-tty',
          '--persistent-state', join(base, 'state.boltdb'), '--cache', join(base, 'cache'), ...args],
        { encoding: 'utf8', env: { ...process.env, HOME: home } },
      )
    return fn({ base, home, ssh, cz })
  })
}

test('chezmoi apply --dry-run runs no copy and changes nothing in ~/.ssh', { skip: askip }, () =>
  withDeploy(({ ssh, cz }) => {
    mkdirSync(ssh, { mode: 0o700 })
    const old = 'Host personal\n  Hostname 192.0.2.1\n'
    writeFileSync(join(ssh, 'config'), old)
    const r = cz('apply', '--force', '--dry-run')
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(readdirSync(ssh), ['config'])
    assert.equal(readFileSync(join(ssh, 'config'), 'utf8'), old)
  }))

test('a failure later in the same apply still records the run_once: the next apply goes through without "merge by hand"', { skip: askip }, () =>
  withHome(({ base }) => {
    // A scratch copy of the source with one extra after-script that fails.
    const src = join(base, 'src')
    cpSync(ROOT.pathname, src, { recursive: true, filter: (p) => !p.includes('/.git/') && !p.endsWith('/.git') })
    const fail = join(src, 'run_after_zz-fail.sh')
    writeFileSync(fail, '#!/bin/sh\nexit 1\n')
    return withDeploy(({ ssh, cz }) => {
      mkdirSync(ssh, { mode: 0o700 })
      const old = 'Host personal\n  Hostname 192.0.2.1\n'
      writeFileSync(join(ssh, 'config'), old)
      let r = cz('apply', '--force')
      assert.notEqual(r.status, 0, 'the failing after-script did not fail the apply')
      assert.equal(readFileSync(join(ssh, 'config.local'), 'utf8'), old)

      rmSync(fail)
      r = cz('apply', '--force')
      assert.equal(r.status, 0, r.stderr)
      assert.doesNotMatch(r.stdout + r.stderr, /preserve-ssh-config/)
      assert.equal(readFileSync(join(ssh, 'config.local'), 'utf8'), old)
      assert.equal(readFileSync(join(ssh, 'config'), 'utf8'), MANAGED)
    }, src)
  }))

// f0e536f's managed config: GitHub over 443 but no Include line, so the script
// cannot tell it is chezmoi's and copies it. Harmless: it sets the same values.
const FIRST_MANAGED = 'Host github.com\n  Hostname ssh.github.com\n  Port 443\n  HostKeyAlias github.com\n'

test('a config from the first managed version (no Include line) is copied, and github.com still resolves to 443', { skip: askip || sskip }, () =>
  withDeploy(({ home, ssh, cz }) => {
    mkdirSync(ssh, { mode: 0o700 })
    writeFileSync(join(ssh, 'config'), FIRST_MANAGED)
    const r = cz('apply', '--force')
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readFileSync(join(ssh, 'config.local'), 'utf8'), FIRST_MANAGED)
    const g = spawnSync('ssh', ['-G', '-F', join(ssh, 'config'), 'git@github.com'], { encoding: 'utf8', stdin: 'ignore', env: { ...process.env, HOME: home } })
    assert.equal(g.status, 0, g.stderr)
    assert.match(g.stdout, /^hostname ssh\.github\.com$/m)
    assert.match(g.stdout, /^port 443$/m)
    assert.match(g.stdout, /^hostkeyalias github\.com$/m)
  }))

// Known gap: chezmoi runs no scripts on a target-limited apply, and it replaces
// a file it never wrote without a prompt, even without --force. Observed on
// chezmoi v2.73.1: `chezmoi apply ~/.ssh` drops a hand-written config.
test('PROPOSED CONTRACT: a target-limited `chezmoi apply ~/.ssh` keeps a hand-written config\'s hosts', { todo: true, skip: askip }, () =>
  withDeploy(({ ssh, cz }) => {
    mkdirSync(ssh, { mode: 0o700 })
    const old = 'Host personal\n  Hostname 192.0.2.1\n'
    writeFileSync(join(ssh, 'config'), old)
    const r = cz('apply', ssh)
    const kept = [join(ssh, 'config'), join(ssh, 'config.local')]
      .filter((p) => existsSync(p))
      .some((p) => readFileSync(p, 'utf8').includes('Host personal'))
    assert.ok(r.status !== 0 || kept, 'apply succeeded and Host personal is in neither config nor config.local')
  }))
