// private_dot_ssh/private_config: GitHub SSH over port 443 (ssh.github.com),
// with HostKeyAlias github.com so unattended runs reuse the github.com
// known_hosts entry. run_once_before_preserve-ssh-config.sh keeps a hand-written
// ~/.ssh/config by copying it to ~/.ssh/config.local before the first apply.
//
// Run from the repo root (ssh and sshd are needed for the ssh tests, chezmoi
// for the deploy tests; without them those tests skip; the full-apply tests
// also skip off Linux):
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'apt-get update -qq && apt-get install -y -qq openssh-client openssh-server >/dev/null &&
//      sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin &&
//      node --test tests/ssh/'
//
// What a pass proves: with work = true and work = false alike, the real source
// tree (its .chezmoiignore and .chezmoiremove included) deploys ~/.ssh/config
// byte for byte, mode 0600, in a 0700 ~/.ssh, without touching the other files
// in ~/.ssh, and a second apply changes nothing. In a full apply with scripts,
// as the hourly update runs it, a hand-written config (plain or symlinked) ends
// up byte for byte in config.local, and its hosts, including ones from a nested
// absolute-path Include, still resolve through the managed config. If
// config.local already exists, the apply fails and both files stay as they were.
// A config that has the managed Include line is never copied, a missing ~/.ssh
// gets no config.local, and after the migration `chezmoi diff` is empty. OpenSSH
// resolves github.com to ssh.github.com:443 with host key alias github.com and
// leaves every other host alone; config.local adds to the github.com block and
// wins where both set an option. Against a local sshd (root only), a BatchMode,
// strict-host-key ssh through this config connects with a known_hosts that
// holds only a github.com entry, and fails at once with "Host key verification
// failed" when it holds none. It says nothing about the real network or
// GitHub's servers; those were probed by hand in the gate run. It also proves
// nothing about how the Conductor app behaves at runtime: the test only stands
// in for its Include line, and does not check that Conductor leaves the
// managed config alone or what it writes into conductor_config.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, statSync, lstatSync, existsSync, readdirSync, symlinkSync } from 'node:fs'
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

// `ssh -G` as a key -> value map. ssh prints keys in lower case. With `home`,
// it reads <home>/.ssh/config and ~ means <home> (OpenSSH takes ~ from $HOME).
function resolve(dest, extra = [], home) {
  const config = home ? join(home, '.ssh', 'config') : CONFIG
  const env = home ? { ...process.env, HOME: home } : process.env
  const r = spawnSync('ssh', ['-G', '-F', config, ...extra, dest], { encoding: 'utf8', stdin: 'ignore', env })
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

// The real source tree and a scratch destination, so the real HOME is never
// touched. `cz` excludes scripts and is for target-limited applies. `czAll` is
// a full apply with scripts, as the hourly `chezmoi update` runs it, with its
// run_once state in the scratch dir; it skips off Linux, where the darwin-only
// scripts (brew, launchctl) would act on the real machine.
const SCRIPT = 'run_once_before_preserve-ssh-config.sh'
const askip = cskip || (process.platform !== 'linux' && 'full apply runs the darwin scripts (run in Docker)')

function withDeploy(work, fn) {
  const base = mkdtempSync(join(tmpdir(), 'ssh-deploy-'))
  try {
    const home = join(base, 'home')
    mkdirSync(home)
    const cfg = join(base, 'chezmoi.toml')
    writeFileSync(cfg, `[data]\n  work = ${work}\n`)
    const run = (scripts, args) =>
      spawnSync(
        'chezmoi',
        ['--source', ROOT.pathname, '--destination', home, '--config', cfg, '--no-tty',
          '--persistent-state', join(base, 'state.boltdb'), '--cache', join(base, 'cache'),
          ...(scripts ? [] : ['--exclude', 'scripts']), ...args],
        { encoding: 'utf8', env: { ...process.env, HOME: home } },
      )
    const cz = (...args) => run(false, args)
    const czAll = (...args) => run(true, args)
    return fn({ base, home, ssh: join(home, '.ssh'), cz, czAll })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

// Lines of `chezmoi managed` that are ~/.ssh or under it.
const sshLines = (out) => out.split('\n').filter((l) => l === '.ssh' || l.startsWith('.ssh/'))
const files = (dir) => readdirSync(dir).sort()

// The work flag no longer gates ~/.ssh: every test runs with both values and
// expects the same result.
for (const work of [true, false]) {
  test(`[work=${work}] chezmoi deploys ~/.ssh/config byte for byte, 0600 in a 0700 ~/.ssh`, { skip: cskip }, () =>
    withDeploy(work, ({ home, cz }) => {
      const r = cz('apply', '--force', join(home, '.ssh'))
      assert.equal(r.status, 0, r.stderr)
      const dst = join(home, '.ssh', 'config')
      assert.equal(readFileSync(dst, 'utf8'), read(SRC))
      assert.equal(statSync(dst).mode & 0o777, 0o600)
      assert.equal(statSync(join(home, '.ssh')).mode & 0o777, 0o700)
    }))

  test(`[work=${work}] chezmoi apply leaves the other files in ~/.ssh alone, and a second apply changes nothing`, { skip: cskip }, () =>
    withDeploy(work, ({ ssh, cz }) => {
      // ~/.ssh holds keys and known_hosts chezmoi does not manage; the dir is not
      // exact_, so they must survive.
      mkdirSync(ssh, { mode: 0o700 })
      const keep = { id_rsa: 'PRIVATE KEY\n', 'id_rsa.pub': 'ssh-rsa AAAA\n', known_hosts: 'github.com ssh-ed25519 AAAA\n' }
      for (const [f, c] of Object.entries(keep)) writeFileSync(join(ssh, f), c, { mode: 0o600 })

      let r = cz('apply', '--force', ssh)
      assert.equal(r.status, 0, r.stderr)
      for (const [f, c] of Object.entries(keep)) assert.equal(readFileSync(join(ssh, f), 'utf8'), c, `${f} changed`)
      assert.equal(readFileSync(join(ssh, 'config'), 'utf8'), read(SRC))

      r = cz('diff', ssh)
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout, '', 'second apply would change something')
      r = cz('verify', ssh)
      assert.equal(r.status, 0, r.stdout + r.stderr)
    }))

  test(`[work=${work}] chezmoi manages exactly ~/.ssh and ~/.ssh/config`, { skip: cskip }, () =>
    withDeploy(work, ({ cz }) => {
      const r = cz('managed')
      assert.equal(r.status, 0, r.stderr)
      assert.deepEqual(sshLines(r.stdout).sort(), ['.ssh', '.ssh/config'])
    }))

  // --- The preserve script, through a full apply ---------------------------------

  test(`[work=${work}] an unmanaged config moves to config.local, and its hosts (and a nested absolute Include) still resolve`, { skip: askip || sskip }, () =>
    withDeploy(work, ({ home, ssh, czAll }) => {
      // Like the Conductor app's line: an absolute-path Include of its own file.
      mkdirSync(ssh, { mode: 0o755 })
      const conductor = join(ssh, 'conductor_config')
      writeFileSync(conductor, 'Host conductor-ws\n  Hostname 192.0.2.7\n  User conductor\n')
      const old = `Include ${conductor}\n\nHost personal\n  Hostname 192.0.2.1\n  Port 2200\n`
      writeFileSync(join(ssh, 'config'), old, { mode: 0o644 })

      const r = czAll('apply', '--force')
      assert.equal(r.status, 0, r.stderr)
      assert.equal(readFileSync(join(ssh, 'config.local'), 'utf8'), old)
      assert.equal(statSync(join(ssh, 'config.local')).mode & 0o777, 0o644, 'cp -p did not keep the mode')
      assert.equal(readFileSync(join(ssh, 'config'), 'utf8'), read(SRC))

      const g = resolve('git@github.com', [], home)
      assert.equal(g.get('hostname'), 'ssh.github.com')
      assert.equal(g.get('port'), '443')
      assert.equal(g.get('hostkeyalias'), 'github.com')
      const p = resolve('personal', [], home)
      assert.equal(p.get('hostname'), '192.0.2.1')
      assert.equal(p.get('port'), '2200')
      const c = resolve('conductor-ws', [], home)
      assert.equal(c.get('hostname'), '192.0.2.7')
      assert.equal(c.get('user'), 'conductor')
    }))

  test(`[work=${work}] an unmanaged config and an existing config.local stop the apply and change neither file`, { skip: askip }, () =>
    withDeploy(work, ({ ssh, czAll }) => {
      mkdirSync(ssh, { mode: 0o700 })
      const old = 'Host personal\n  Hostname 192.0.2.1\n'
      const local = 'Host other\n  Hostname 192.0.2.2\n'
      writeFileSync(join(ssh, 'config'), old)
      writeFileSync(join(ssh, 'config.local'), local)

      let r = czAll('apply', '--force')
      assert.notEqual(r.status, 0, 'apply succeeded over an unmerged config')
      assert.match(r.stderr, /merge .*config into .*config\.local by hand/)
      assert.equal(readFileSync(join(ssh, 'config'), 'utf8'), old)
      assert.equal(readFileSync(join(ssh, 'config.local'), 'utf8'), local)

      // The failed run_once script is not recorded, so after the hand merge the
      // README asks for (merge into config.local, delete config) the next apply
      // runs it again and goes through.
      writeFileSync(join(ssh, 'config.local'), local + old)
      rmSync(join(ssh, 'config'))
      r = czAll('apply', '--force')
      assert.equal(r.status, 0, r.stderr)
      assert.equal(readFileSync(join(ssh, 'config.local'), 'utf8'), local + old)
      assert.equal(readFileSync(join(ssh, 'config'), 'utf8'), read(SRC))
    }))

  test(`[work=${work}] an already-managed config changes nothing in ~/.ssh`, { skip: askip }, () =>
    withDeploy(work, ({ ssh, czAll }) => {
      mkdirSync(ssh, { mode: 0o700 })
      const before = { config: read(SRC), 'config.local': 'Host personal\n  Hostname 192.0.2.1\n', id_ed25519: 'PRIVATE KEY\n' }
      for (const [f, c] of Object.entries(before)) writeFileSync(join(ssh, f), c, { mode: 0o600 })

      const r = czAll('apply', '--force')
      assert.equal(r.status, 0, r.stderr)
      assert.deepEqual(files(ssh), Object.keys(before).sort())
      for (const [f, c] of Object.entries(before)) assert.equal(readFileSync(join(ssh, f), 'utf8'), c, `${f} changed`)
    }))

  test(`[work=${work}] an older managed config (it has the Include line) is replaced without a copy`, { skip: askip }, () =>
    withDeploy(work, ({ ssh, czAll }) => {
      mkdirSync(ssh, { mode: 0o700 })
      writeFileSync(join(ssh, 'config'), 'Include ~/.ssh/config.local\n\nHost github.com\n  Port 22\n')

      const r = czAll('apply', '--force')
      assert.equal(r.status, 0, r.stderr)
      assert.equal(existsSync(join(ssh, 'config.local')), false, 'a managed config was copied to config.local')
      assert.equal(readFileSync(join(ssh, 'config'), 'utf8'), read(SRC))
    }))

  test(`[work=${work}] with no ~/.ssh the script does nothing and chezmoi creates a 0700 ~/.ssh`, { skip: askip }, () =>
    withDeploy(work, ({ ssh, czAll }) => {
      const r = czAll('apply', '--force')
      assert.equal(r.status, 0, r.stderr)
      assert.doesNotMatch(r.stdout + r.stderr, /preserve-ssh-config/)
      assert.deepEqual(files(ssh), ['config'])
      assert.equal(statSync(ssh).mode & 0o777, 0o700)
      assert.equal(readFileSync(join(ssh, 'config'), 'utf8'), read(SRC))
    }))

  test(`[work=${work}] a symlinked ~/.ssh/config: the target's content ends up in config.local`, { skip: askip }, () =>
    withDeploy(work, ({ home, ssh, czAll }) => {
      mkdirSync(ssh, { mode: 0o700 })
      const target = join(home, 'my-ssh-config')
      const old = 'Host personal\n  Hostname 192.0.2.1\n'
      writeFileSync(target, old)
      symlinkSync(target, join(ssh, 'config'))

      const r = czAll('apply', '--force')
      assert.equal(r.status, 0, r.stderr)
      assert.equal(lstatSync(join(ssh, 'config.local')).isFile(), true, 'config.local is not a regular file')
      assert.equal(readFileSync(join(ssh, 'config.local'), 'utf8'), old)
      assert.equal(lstatSync(join(ssh, 'config')).isFile(), true, 'config is still a symlink')
      assert.equal(readFileSync(join(ssh, 'config'), 'utf8'), read(SRC))
    }))

  test(`[work=${work}] after the migration a second apply has nothing to do: chezmoi diff is empty`, { skip: askip }, () =>
    withDeploy(work, ({ ssh, czAll }) => {
      mkdirSync(ssh, { mode: 0o700 })
      writeFileSync(join(ssh, 'config'), 'Host personal\n  Hostname 192.0.2.1\n')

      let r = czAll('apply', '--force')
      assert.equal(r.status, 0, r.stderr)
      r = czAll('diff')
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout, '', 'second apply would change something')
      r = czAll('apply', '--force')
      assert.equal(r.status, 0, r.stderr)
      assert.doesNotMatch(r.stdout + r.stderr, /preserve-ssh-config/, 'the run_once script ran twice')
    }))
}

// --- How config.local and the managed block combine ------------------------------

// OpenSSH keeps the first value it gets for each option. config.local is
// included above the managed Host github.com block, so it adds to it and wins.
function withLocal(local, fn) {
  const home = mkdtempSync(join(tmpdir(), 'ssh-local-'))
  try {
    mkdirSync(join(home, '.ssh'), { mode: 0o700 })
    writeFileSync(join(home, '.ssh', 'config'), read(SRC), { mode: 0o600 })
    writeFileSync(join(home, '.ssh', 'config.local'), local(home), { mode: 0o600 })
    return fn(resolve('git@github.com', [], home))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('config.local Host github.com with an IdentityFile merges with the managed block: 443 and the identity both apply', { skip: sskip }, () =>
  withLocal((h) => `Host github.com\n  IdentityFile ${h}/.ssh/id_work\n`, (g) => {
    assert.equal(g.get('hostname'), 'ssh.github.com')
    assert.equal(g.get('port'), '443')
    assert.equal(g.get('hostkeyalias'), 'github.com')
    assert.match(g.get('identityfile'), /\/\.ssh\/id_work$/)
  }))

test('config.local Hostname github.com beats the managed block (the README warns of this)', { skip: sskip }, () =>
  withLocal(() => 'Host github.com\n  Hostname github.com\n', (g) => {
    assert.equal(g.get('hostname'), 'github.com')
  }))

test('config.local Host * Port 22 beats the managed Port 443 (the README warns of this)', { skip: sskip }, () =>
  withLocal(() => 'Host *\n  Port 22\n', (g) => {
    assert.equal(g.get('port'), '22')
  }))

// --- The preserve script itself ---------------------------------------------------

test('the preserve script is plain sh (no template), has no set -e, and never writes the managed content', () => {
  const s = read(SCRIPT)
  assert.match(s, /^#!\/bin\/sh\n/)
  assert.match(s, /^set -u$/m)
  assert.doesNotMatch(s, /^\s*set -[a-z]*e/m)
  assert.doesNotMatch(s, /\{\{|chezmoi cat/)
  assert.doesNotMatch(s, /ssh\.github\.com|Port 443/)
  assert.ok(read(SRC).split('\n').includes('Include ~/.ssh/config.local'), 'the managed config lost the line the script keys on')
  const r = spawnSync('sh', ['-n', new URL(SCRIPT, ROOT).pathname], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
})

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
