// dot_config/himalaya/config.toml.tmpl: the Himalaya accounts. Every account
// renders on every machine except snyk, which needs work = true. Passwords stay
// in the macOS Keychain; the config only names the `security` command.
//
// Run from the repo root (chezmoi is needed; without it every test FAILS, it
// does not skip. The real-binary tests need himalaya and skip without it). The
// config uses the v1 format, so the v1 tests need a v1 binary:
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin &&
//      curl -fsSL "https://github.com/pimalaya/himalaya/releases/download/v1.2.0/himalaya.$(uname -m)-linux.tgz" |
//        tar -xz -C /usr/local/bin himalaya &&
//      node --test tests/himalaya/'
//
// To run the latest-release test, install what run_once_install-himalaya.sh.tmpl
// installs instead (from an empty directory: the installer's unquoted tr
// arguments glob against the current directory):
//   cd /tmp && curl -sSL https://raw.githubusercontent.com/pimalaya/himalaya/master/install.sh | PREFIX=/usr/local sh
//
// What a pass proves, for this source tree with a throwaway HOME:
// - With work = true and work = false the template renders valid TOML; the only
//   difference between the two is the snyk account; a missing work value stops
//   the render.
// - icloud is the only default, so a bare `himalaya` command never moves to
//   another account.
// - Every account has the same shape: IMAP and SMTP share one login and one
//   Keychain command, which names that login; ports match their encryption; no
//   account sets a raw password key.
// - The aihackers account has exactly the agreed Fastmail settings, and the
//   Fastmail login and Keychain item reach no other account.
// - A real v1 himalaya binary, if present, accepts the render without running
//   `security`, and when `security` refuses it stops with an error on the right
//   Keychain item for each account.
// A pass does not prove that Fastmail accepts the login, that the folder names
// exist on the server, or that SMTP sends. Those were tested by hand. It also does
// not prove that a fresh machine can use the config (#66), or that no password
// value appears anywhere in the template. The binary
// tests put only a refusing `security` stub on PATH, so they cannot read the
// Keychain and have no password to send.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SOURCE = new URL('../../', import.meta.url).pathname
const TEMPLATE = readFileSync(join(SOURCE, 'dot_config/himalaya/config.toml.tmpl'), 'utf8')

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'himalaya-config-'))
  try {
    return fn(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function chezmoi(home, data, input) {
  const dataFile = join(home, 'data.json')
  writeFileSync(dataFile, JSON.stringify(data))
  const r = spawnSync('chezmoi', ['--source', SOURCE, '--destination', home, '--override-data-file', dataFile, 'execute-template'], {
    encoding: 'utf8',
    input,
    env: { PATH: process.env.PATH, HOME: home },
  })
  assert.ifError(r.error)
  return r
}

function render(home, work) {
  const r = chezmoi(home, { work }, TEMPLATE)
  assert.equal(r.status, 0, `render work=${work} exited ${r.status}: ${r.stderr}`)
  return r.stdout
}

// chezmoi's own TOML parser, so these tests need no second runtime.
function parse(home, toml) {
  const file = join(home, 'rendered.toml')
  writeFileSync(file, toml)
  const r = chezmoi(home, { work: false }, `{{ include ${JSON.stringify(file)} | fromToml | toJson }}`)
  assert.equal(r.status, 0, `rendered TOML did not parse: ${r.stderr}`)
  return JSON.parse(r.stdout)
}

const accountsFor = (work) => withHome((home) => parse(home, render(home, work)).accounts)
const WORK_VALUES = [true, false]
const FASTMAIL_CMD = 'security find-generic-password -s himalaya-fastmail -a rdegges@sent.com -w'

function allKeys(value, path = []) {
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([k, v]) => [[...path, k].join('.'), ...allKeys(v, [...path, k])])
}

const keychainServices = (accounts) =>
  new Set(Object.values(accounts).map((a) => a.backend.auth.cmd.match(/ -s (\S+) /)?.[1]))

for (const work of WORK_VALUES) {
  test(`work=${work}: render leaves no template syntax behind`, () => {
    withHome((home) => assert.doesNotMatch(render(home, work), /\{\{|\}\}/))
  })

  test(`work=${work}: icloud is the only default account`, () => {
    const defaults = Object.entries(accountsFor(work)).filter(([, a]) => a.default === true).map(([n]) => n)
    assert.deepEqual(defaults, ['icloud'])
  })

  test(`work=${work}: every account has its own From address`, () => {
    const emails = Object.values(accountsFor(work)).map((a) => a.email)
    assert.equal(new Set(emails).size, emails.length, emails.join(', '))
  })

  test(`work=${work}: every account has IMAP, SMTP, and the four folder aliases`, () => {
    for (const [name, a] of Object.entries(accountsFor(work))) {
      assert.equal(a.backend.type, 'imap', name)
      assert.equal(a.message.send.backend.type, 'smtp', name)
      assert.equal(a.message.send['save-copy'], true, name)
      assert.equal(a['display-name'], 'Randall Degges', name)
      assert.equal(a.folder.aliases.inbox, 'INBOX', name)
      for (const alias of ['sent', 'drafts', 'trash']) {
        assert.ok(a.folder.aliases[alias], `${name}: no ${alias} alias`)
      }
    }
  })

  test(`work=${work}: IMAP and SMTP of each account share a login and read that login's Keychain item`, () => {
    for (const [name, a] of Object.entries(accountsFor(work))) {
      const imap = a.backend
      const smtp = a.message.send.backend
      assert.equal(smtp.login, imap.login, `${name}: logins differ`)
      assert.equal(imap.auth.type, 'password', name)
      assert.equal(smtp.auth.type, 'password', name)
      assert.equal(smtp.auth.cmd, imap.auth.cmd, `${name}: Keychain commands differ`)
      const m = imap.auth.cmd.match(/^security find-generic-password -s (himalaya-[a-z]+) -a (\S+) -w$/)
      assert.ok(m, `${name}: unexpected auth command ${imap.auth.cmd}`)
      assert.equal(m[2], imap.login, `${name}: Keychain account is not the login`)
    }
  })

  test(`work=${work}: every port matches its encryption`, () => {
    const expected = { 993: 'tls', 465: 'tls', 587: 'start-tls' }
    for (const [name, a] of Object.entries(accountsFor(work))) {
      for (const b of [a.backend, a.message.send.backend]) {
        assert.equal(b.encryption.type, expected[b.port], `${name}: ${b.host}:${b.port} uses ${b.encryption.type}`)
      }
    }
  })

  test(`work=${work}: no account sets a password key`, () => {
    for (const key of allKeys(accountsFor(work))) {
      assert.doesNotMatch(key, /(^|\.)(raw|password|passwd|secret|token)$/i, key)
    }
  })

  test(`work=${work}: aihackers has exactly the Fastmail settings`, () => {
    assert.deepEqual(accountsFor(work).aihackers, {
      email: 'randall@aihackers.club',
      'display-name': 'Randall Degges',
      folder: { aliases: { inbox: 'INBOX', sent: 'Sent', drafts: 'Drafts', trash: 'Trash' } },
      backend: {
        type: 'imap',
        host: 'imap.fastmail.com',
        port: 993,
        encryption: { type: 'tls' },
        login: 'rdegges@sent.com',
        auth: { type: 'password', cmd: FASTMAIL_CMD },
      },
      message: {
        send: {
          backend: {
            type: 'smtp',
            host: 'smtp.fastmail.com',
            port: 465,
            encryption: { type: 'tls' },
            login: 'rdegges@sent.com',
            auth: { type: 'password', cmd: FASTMAIL_CMD },
          },
          'save-copy': true,
        },
      },
      signature: 'Randall Degges\nhttps://rdegges.com\n',
    })
  })

  test(`work=${work}: Fastmail settings reach no other account`, () => {
    const { aihackers, ...others } = accountsFor(work)
    assert.ok(aihackers)
    for (const [name, a] of Object.entries(others)) {
      assert.doesNotMatch(JSON.stringify(a), /fastmail|sent\.com|aihackers/, name)
    }
  })

  test(`work=${work}: iCloud accounts still use iCloud`, () => {
    const accounts = accountsFor(work)
    for (const name of ['icloud', 'hardlyfunny', 'social']) {
      const a = accounts[name]
      assert.equal(a.backend.host, 'imap.mail.me.com', name)
      assert.equal(a.message.send.backend.host, 'smtp.mail.me.com', name)
      assert.equal(a.backend.login, 'r@rdegges.com', name)
      assert.equal(a.backend.auth.cmd, 'security find-generic-password -s himalaya-icloud -a r@rdegges.com -w', name)
      assert.equal(a.folder.aliases.sent, 'Sent Messages', name)
    }
  })
}

test('work=true differs from work=false only by the snyk account', () => {
  const { snyk, ...rest } = accountsFor(true)
  assert.equal(snyk.email, 'randall.degges@snyk.io')
  assert.deepEqual(rest, accountsFor(false))
})

test('work=false renders no snyk account or Snyk Keychain item', () => {
  const accounts = accountsFor(false)
  assert.equal(accounts.snyk, undefined)
  assert.doesNotMatch(JSON.stringify(accounts), /snyk/i)
})

test('a missing work value stops the render instead of dropping an account', () => {
  withHome((home) => {
    const r = chezmoi(home, {}, TEMPLATE)
    assert.notEqual(r.status, 0, 'render without work exited 0')
    assert.match(r.stderr, /work/)
    assert.equal(r.stdout, '', 'a failed render wrote output')
  })
})

function readmeEmailSection() {
  const readme = readFileSync(join(SOURCE, 'README.md'), 'utf8')
  const start = readme.indexOf('## Email (Himalaya)')
  assert.notEqual(start, -1, 'README has no Email (Himalaya) section')
  const next = readme.indexOf('\n## ', start + 1)
  return next === -1 ? readme.slice(start) : readme.slice(start, next)
}

// README.md told the next machine that one Keychain item is enough. A wrong step
// here shows up only later, as a failed `himalaya -a aihackers` on a new host.
test('README does not call the iCloud password the only per-machine step while the config reads other Keychain items', () => {
  const section = readmeEmailSection()
  const services = [...keychainServices(accountsFor(false))].sort()
  const claimsOnlyICloud = /only per-machine step is loading the iCloud/i.test(section)
  assert.ok(
    !(claimsOnlyICloud && services.length > 1),
    `README says iCloud is the only per-machine step, but a work=false render reads ${services.join(', ')}`,
  )
})

test('the README Email section names the himalaya-fastmail Keychain item and how to store it', () => {
  assert.match(readmeEmailSection(), /-s himalaya-fastmail -a rdegges@sent\.com/)
})

// Observed 2026-11-01: the installer fetches the latest release, which is v2.2.1,
// and v2 ignores the v1 `backend` table ("its v1 `backend` table is ignored since
// v2"), so every account on a fresh machine fails. Either fix passes: pin the
// install to v1, or move the config to the v2 format. Tracked in #66.
test('PROPOSED CONTRACT: the installer does not fetch an unpinned Himalaya while the config uses the v1 backend table', { todo: true }, () => {
  const installer = readFileSync(join(SOURCE, 'run_once_install-himalaya.sh.tmpl'), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
  const unpinned = /pimalaya\/himalaya\/master\/install\.sh/.test(installer)
  const usesV1Backend = Object.values(accountsFor(false)).some((a) => a.backend?.type)
  assert.ok(!(unpinned && usesV1Backend), 'run_once_install-himalaya.sh.tmpl installs the latest release, and v2 ignores this config\'s backend tables')
})

// The real parser. Only the stub directory is on PATH, so /usr/bin/security is
// out of reach: these tests cannot read the Keychain and hold no password.
const himalayaPath = spawnSync('sh', ['-c', 'command -v himalaya'], { encoding: 'utf8' }).stdout.trim()
const himalayaMajor = himalayaPath ? spawnSync(himalayaPath, ['--version'], { encoding: 'utf8' }).stdout.match(/^himalaya v(\d+)\./)?.[1] : undefined
const skip = himalayaMajor === '1' ? false : `needs himalaya v1 on PATH, found ${himalayaMajor ? `v${himalayaMajor}` : 'none'}`
const skipUnlessNewer = Number(himalayaMajor) >= 2 ? false : 'needs himalaya v2 or newer on PATH'

function withHimalaya(work, fn) {
  withHome((home) => {
    const stub = join(home, 'stub')
    const log = join(home, 'security.log')
    const config = join(home, 'config.toml')
    mkdirSync(stub)
    symlinkSync('/bin/sh', join(stub, 'sh'))
    writeFileSync(join(stub, 'security'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\necho refused >&2\nexit 44\n`)
    chmodSync(join(stub, 'security'), 0o755)
    writeFileSync(log, '')
    writeFileSync(config, render(home, work))
    const run = (...args) => {
      const r = spawnSync(himalayaPath, ['-c', config, ...args], {
        encoding: 'utf8',
        timeout: 30000,
        env: { HOME: home, PATH: stub },
      })
      assert.ifError(r.error)
      return r
    }
    fn(run, () => readFileSync(log, 'utf8'))
  })
}

for (const work of WORK_VALUES) {
  test(`work=${work}: himalaya accepts the config, lists aihackers, keeps icloud default, and runs no security command`, { skip }, () => {
    withHimalaya(work, (run, securityCalls) => {
      const r = run('-o', 'json', 'account', 'list')
      assert.equal(r.status, 0, r.stderr)
      const accounts = JSON.parse(r.stdout)
      assert.deepEqual(accounts.filter((a) => a.default).map((a) => a.name), ['icloud'])
      assert.deepEqual(accounts.find((a) => a.name === 'aihackers'), { name: 'aihackers', backend: 'IMAP, SMTP', default: false })
      assert.equal(accounts.some((a) => a.name === 'snyk'), work)
      assert.equal(securityCalls(), '')
    })
  })
}

test('himalaya -a aihackers asks for the Fastmail item and fails when security refuses', { skip }, () => {
  withHimalaya(false, (run, securityCalls) => {
    const r = run('folder', 'list', '-a', 'aihackers')
    assert.notEqual(r.status, 0, 'folder list succeeded with no password')
    assert.equal(securityCalls(), 'find-generic-password -s himalaya-fastmail -a rdegges@sent.com -w\n')
  })
})

test('himalaya with no -a asks for the iCloud item, not Fastmail', { skip }, () => {
  withHimalaya(false, (run, securityCalls) => {
    const r = run('folder', 'list')
    assert.notEqual(r.status, 0, 'folder list succeeded with no password')
    assert.equal(securityCalls(), 'find-generic-password -s himalaya-icloud -a r@rdegges.com -w\n')
  })
})

test('PROPOSED CONTRACT: himalaya v2 or newer finds a backend for aihackers in this config', { skip: skipUnlessNewer, todo: true }, () => {
  withHimalaya(false, (run) => {
    const r = run('--json', 'account', 'list')
    assert.equal(r.status, 0, r.stderr)
    const { backends } = JSON.parse(r.stdout).accounts.find((a) => a.name === 'aihackers')
    assert.notDeepEqual(backends, [], 'himalaya lists aihackers with no backend')
  })
})
