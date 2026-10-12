// private_dot_ssh/private_config: GitHub SSH over port 443 (ssh.github.com),
// with HostKeyAlias github.com so unattended runs reuse the github.com
// known_hosts entry.
//
// Run from the repo root (ssh and sshd are needed for the ssh tests, chezmoi
// for the deploy tests; without them those tests skip):
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'apt-get update -qq && apt-get install -y -qq openssh-client openssh-server >/dev/null &&
//      sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin &&
//      node --test tests/ssh/'
//
// What a pass proves: the real source tree (its .chezmoiignore and
// .chezmoiremove included) deploys ~/.ssh/config byte for byte, mode 0600, in a
// 0700 ~/.ssh, on work and non-work machines, without touching the other files
// in ~/.ssh, and a second apply changes nothing. OpenSSH resolves github.com to
// ssh.github.com:443 with host key alias github.com and leaves every other host
// alone. Against a local sshd (root only), a BatchMode, strict-host-key ssh
// through this config connects with a known_hosts that holds only a github.com
// entry, and fails at once with "Host key verification failed" when it holds
// none. It says nothing about the real network or GitHub's servers; those were
// probed by hand in the gate run.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, statSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('../../', import.meta.url)
const SRC = 'private_dot_ssh/private_config'
const CONFIG = new URL(SRC, ROOT).pathname
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8')

const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0
const SSHD = ['/usr/sbin/sshd', '/usr/bin/sshd'].find((p) => existsSync(p))
const cskip = has('chezmoi') ? false : 'chezmoi not installed (see the run command at the top)'
const sskip = has('ssh') ? false : 'ssh not installed (see the run command at the top)'
// sshd -i needs root for privilege separation; the Docker run is root.
const dskip =
  sskip || (!SSHD && 'sshd not installed (see the run command at the top)') ||
  (process.getuid?.() !== 0 && 'local sshd needs root (run in Docker)')

// `ssh -G` as a key -> value map. ssh prints keys in lower case.
function resolve(dest, extra = []) {
  const r = spawnSync('ssh', ['-G', '-F', CONFIG, ...extra, dest], { encoding: 'utf8', stdin: 'ignore' })
  assert.equal(r.status, 0, r.stderr)
  const m = new Map()
  for (const line of r.stdout.split('\n')) {
    const i = line.indexOf(' ')
    if (i > 0 && !m.has(line.slice(0, i))) m.set(line.slice(0, i), line.slice(i + 1))
  }
  return m
}

// --- What OpenSSH makes of the config -----------------------------------------

test('github.com resolves to ssh.github.com port 443 with host key alias github.com', { skip: sskip }, () => {
  const g = resolve('git@github.com')
  assert.equal(g.get('hostname'), 'ssh.github.com')
  assert.equal(g.get('port'), '443')
  assert.equal(g.get('hostkeyalias'), 'github.com')
  // git's remote user must survive: the config sets no User.
  assert.equal(g.get('user'), 'git')
})

for (const host of ['gist.github.com', 'ssh.github.com', 'example.com', 'github.com.evil.example', 'notgithub.com']) {
  test(`other hosts are untouched: ${host} keeps its own name, port 22, and no host key alias`, { skip: sskip }, () => {
    const g = resolve(`git@${host}`)
    assert.equal(g.get('hostname'), host)
    assert.equal(g.get('port'), '22')
    assert.equal(g.has('hostkeyalias'), false, `hostkeyalias leaked to ${host}: ${g.get('hostkeyalias')}`)
  })
}

// --- Host key verification, unattended, against a local sshd -------------------

// A throwaway sshd run through ProxyCommand in inetd mode, so no port and no
// network: ssh still sees HostKeyAlias github.com from the config under test.
function withSshd(fn) {
  const d = mkdtempSync(join(tmpdir(), 'ssh-config-'))
  try {
    const kg = (f) => {
      const r = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(d, f)], { encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
    }
    kg('hostkey')
    kg('client')
    mkdirSync('/run/sshd', { recursive: true })
    writeFileSync(
      join(d, 'sshd_config'),
      [
        `HostKey ${join(d, 'hostkey')}`,
        `AuthorizedKeysFile ${join(d, 'client.pub')}`,
        'StrictModes no',
        'UsePAM no',
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        'PermitRootLogin prohibit-password',
        '',
      ].join('\n'),
    )
    const hostPub = readFileSync(join(d, 'hostkey.pub'), 'utf8').split(' ').slice(0, 2).join(' ')
    const ssh = (knownHosts) => {
      const kh = join(d, 'known_hosts')
      writeFileSync(kh, knownHosts)
      return spawnSync(
        'ssh',
        [
          '-F', CONFIG,
          '-o', 'BatchMode=yes',
          '-o', 'StrictHostKeyChecking=yes',
          '-o', `UserKnownHostsFile=${kh}`,
          '-o', 'GlobalKnownHostsFile=/dev/null',
          '-o', `ProxyCommand=${SSHD} -i -f ${join(d, 'sshd_config')}`,
          '-o', 'IdentitiesOnly=yes',
          '-i', join(d, 'client'),
          '-T', `${userInfo().username}@github.com`, 'echo connected',
        ],
        { encoding: 'utf8', stdin: 'ignore', timeout: 30_000 },
      )
    }
    return fn({ hostPub, ssh })
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
}

test('BatchMode ssh to github.com is verified by a github.com-only known_hosts entry (no [ssh.github.com]:443 needed)', { skip: dskip }, () =>
  withSshd(({ hostPub, ssh }) => {
    const r = ssh(`github.com ${hostPub}\n`)
    assert.equal(r.error, undefined, String(r.error))
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim(), 'connected')
  }))

test('BatchMode ssh fails fast and loudly when known_hosts has only the [ssh.github.com]:443 entry', { skip: dskip }, () =>
  withSshd(({ hostPub, ssh }) => {
    // Proves the lookup goes through the alias, not the real host and port.
    const r = ssh(`[ssh.github.com]:443 ${hostPub}\n`)
    assert.equal(r.error, undefined, 'ssh hung instead of failing')
    assert.equal(r.status, 255)
    assert.match(r.stderr, /Host key verification failed/)
  }))

test('BatchMode ssh fails fast and loudly with an empty known_hosts (never prompts)', { skip: dskip }, () =>
  withSshd(({ ssh }) => {
    const r = ssh('')
    assert.equal(r.error, undefined, 'ssh hung instead of failing')
    assert.equal(r.status, 255)
    assert.match(r.stderr, /Host key verification failed/)
  }))

// --- chezmoi deploys it ---------------------------------------------------------

// The real source tree, a scratch destination, and only the ~/.ssh targets, so
// no script runs and the real HOME is never touched.
function withDeploy(work, fn) {
  const base = mkdtempSync(join(tmpdir(), 'ssh-deploy-'))
  try {
    const home = join(base, 'home')
    mkdirSync(home)
    const cfg = join(base, 'chezmoi.toml')
    writeFileSync(cfg, `[data]\n  work = ${work}\n`)
    const cz = (...args) =>
      spawnSync(
        'chezmoi',
        ['--source', ROOT.pathname, '--destination', home, '--config', cfg, '--no-tty', '--exclude', 'scripts', ...args],
        { encoding: 'utf8', env: { ...process.env, HOME: home } },
      )
    return fn({ home, cz })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

for (const work of [false, true]) {
  test(`[work=${work}] chezmoi deploys ~/.ssh/config byte for byte, 0600 in a 0700 ~/.ssh`, { skip: cskip }, () =>
    withDeploy(work, ({ home, cz }) => {
      const r = cz('apply', '--force', join(home, '.ssh'))
      assert.equal(r.status, 0, r.stderr)
      const dst = join(home, '.ssh', 'config')
      assert.equal(readFileSync(dst, 'utf8'), read(SRC))
      assert.equal(statSync(dst).mode & 0o777, 0o600)
      assert.equal(statSync(join(home, '.ssh')).mode & 0o777, 0o700)
    }))
}

test('chezmoi apply leaves the other files in ~/.ssh alone, and a second apply changes nothing', { skip: cskip }, () =>
  withDeploy(false, ({ home, cz }) => {
    // ~/.ssh holds keys and known_hosts chezmoi does not manage; the dir is not
    // exact_, so they must survive.
    const ssh = join(home, '.ssh')
    mkdirSync(ssh, { mode: 0o700 })
    const keep = { id_rsa: 'PRIVATE KEY\n', 'id_rsa.pub': 'ssh-rsa AAAA\n', known_hosts: 'github.com ssh-ed25519 AAAA\n' }
    for (const [f, c] of Object.entries(keep)) writeFileSync(join(ssh, f), c, { mode: 0o600 })

    let r = cz('apply', '--force', ssh)
    assert.equal(r.status, 0, r.stderr)
    for (const [f, c] of Object.entries(keep)) assert.equal(readFileSync(join(ssh, f), 'utf8'), c, `${f} changed`)

    r = cz('diff', ssh)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, '', 'second apply would change something')
    r = cz('verify', ssh)
    assert.equal(r.status, 0, r.stdout + r.stderr)
  }))

// --- The README describes this file -------------------------------------------

test('README names the real source path and the same host and port as the config', () => {
  const readme = read('README.md')
  const cfg = read(SRC)
  assert.ok(readme.includes(`\`${SRC}\``), `README does not name ${SRC}`)
  assert.match(cfg, /^\s*Hostname ssh\.github\.com$/m)
  assert.match(cfg, /^\s*Port 443$/m)
  assert.match(cfg, /^\s*HostKeyAlias github\.com$/m)
  assert.match(readme, /port 443 \(`ssh\.github\.com`\)/)
  assert.match(readme, /`HostKeyAlias`/)
})
