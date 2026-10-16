// Behavior of the network wait that the launchd update jobs run first
// (dot_cron/executable_wait-for-network.sh).
//
// Run from the repo root:
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'apt-get update -qq && apt-get install -y -qq zsh >/dev/null &&
//      sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin &&
//      node --test tests/cron/'
//
// What a pass proves: with stub `route` and `dscacheutil` on a PATH that has no
// real ones (they are macOS tools), the script asks `route -n get default` and
// `dscacheutil -q host -a name github.com`, and exits 0 only when route
// reports an interface and dscacheutil prints an ip_address: or ipv6_address:
// line (the stubs replay real macOS output). With no default route or empty
// DNS output it polls every 2s and exits 1 once WAIT_FOR_NETWORK_TIMEOUT
// seconds have passed; a network that comes up within the timeout exits 0. A
// missing tool, a dscacheutil error, output it cannot read, or a bad timeout
// exits 2 at once. It holds under dash and under bash --posix (macOS /bin/sh is
// bash in POSIX mode). It says nothing about real macOS route or dscacheutil
// output after a wake; the host smoke run in the PR checks one connected Mac.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, chmodSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('../../', import.meta.url)
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8')
const SCRIPT = new URL('dot_cron/executable_wait-for-network.sh', ROOT).pathname
// Only system dirs, so no real route or dscacheutil can answer in place of a stub.
const SYS_PATH = '/usr/bin:/bin'

const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0
const SHELLS = [
  { name: 'sh', argv: ['sh'], skip: false },
  { name: 'bash --posix', argv: ['bash', '--posix'], skip: has('bash') ? false : 'bash not installed' },
]

// Output of `route -n get default` and of a good dscacheutil lookup, captured
// on a connected Mac (macOS 27).
const ROUTE_UP =
  '   route to: default\ndestination: default\n       mask: default\n    gateway: 192.168.1.1\n' +
  '  interface: en0\n      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>\n' +
  ' recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire\n' +
  '       0         0         0         0         0         0      1500         0 \n'
const DNS_UP = 'name: github.com\nip_address: 20.29.134.23\n\n'
const DNS_UP6 = 'name: github.com\nipv6_address: 2606:50c0:8000::154\n\n'

// Each stub logs its call, then replays the output for this call number:
// STUB_<TOOL>_<n> (1-based), else STUB_<TOOL>. A value "rc=<k>" exits k with no
// output (route: "not in table" on stderr).
const stub = (name, envName) =>
  '#!/bin/sh\n' +
  `echo "${name} $*" >> "$CALLS"\n` +
  `n=$(grep -c '^${name} ' "$CALLS")\n` +
  `eval "v=\\\${STUB_${envName}_$n-\\\${STUB_${envName}-}}"\n` +
  'case "$v" in rc=*) echo "not in table" >&2; exit "${v#rc=}" ;; esac\n' +
  'printf "%s" "$v"\n'

function sandbox({ tools = ['route', 'dscacheutil'] } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'wait-for-network-'))
  const bin = join(base, 'bin')
  mkdirSync(bin)
  const names = { route: 'ROUTE', dscacheutil: 'DNS' }
  for (const t of tools) {
    writeFileSync(join(bin, t), stub(t, names[t]))
    chmodSync(join(bin, t), 0o755)
  }
  const calls = join(base, 'calls')
  writeFileSync(calls, '')
  return {
    calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    run(env = {}, shell = SHELLS[0]) {
      // Built from scratch so the host's WAIT_FOR_NETWORK_TIMEOUT never leaks in.
      const t0 = Date.now()
      const r = spawnSync(shell.argv[0], [...shell.argv.slice(1), SCRIPT], {
        encoding: 'utf8',
        timeout: 30000,
        env: {
          PATH: `${bin}:${SYS_PATH}`,
          CALLS: calls,
          STUB_ROUTE: ROUTE_UP,
          STUB_DNS: DNS_UP,
          WAIT_FOR_NETWORK_TIMEOUT: '0',
          ...env,
        },
      })
      r.ms = Date.now() - t0
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

test('the test PATH has no real route or dscacheutil (else the stubs prove nothing)', () => {
  for (const t of ['route', 'dscacheutil']) {
    const r = spawnSync('sh', ['-c', `command -v ${t}`], { env: { PATH: SYS_PATH } })
    assert.notEqual(r.status, 0, `${t} found on ${SYS_PATH}`)
  }
})

for (const shell of SHELLS) {
  const t = (name, fn) => test(`[${shell.name}] ${name}`, { skip: shell.skip }, fn)

  t('up: route has an interface and DNS has an ip_address: exit 0 at once, quiet, exact probes', () =>
    withSandbox({}, (sb) => {
      const r = sb.run({}, shell)
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.equal(r.stdout + r.stderr, '')
      assert.deepEqual(sb.calls(), ['route -n get default', 'dscacheutil -q host -a name github.com'])
    }))

  t('up with only an ipv6_address line: exit 0', () =>
    withSandbox({}, (sb) => {
      const r = sb.run({ STUB_DNS: DNS_UP6 }, shell)
      assert.equal(r.status, 0, r.stdout + r.stderr)
    }))

  t('no default route (route exits 1): exit 1 and says why', () =>
    withSandbox({}, (sb) => {
      const r = sb.run({ STUB_ROUTE: 'rc=1' }, shell)
      assert.equal(r.status, 1, r.stdout + r.stderr)
      assert.match(r.stdout, /^wait-for-network: down after 0s \(default route: no, github\.com DNS: yes\)$/m)
    }))

  t('empty DNS output (dscacheutil exits 0 on a failed lookup): exit 1', () =>
    withSandbox({}, (sb) => {
      const r = sb.run({ STUB_DNS: '' }, shell)
      assert.equal(r.status, 1, r.stdout + r.stderr)
      assert.match(r.stdout, /default route: yes, github\.com DNS: no/)
    }))

  t('route missing: exit 2, no probe runs', () =>
    withSandbox({ tools: ['dscacheutil'] }, (sb) => {
      const r = sb.run({}, shell)
      assert.equal(r.status, 2, r.stdout + r.stderr)
      assert.match(r.stderr, /route not found/)
      assert.deepEqual(sb.calls(), [])
    }))

  t('dscacheutil missing: exit 2, no probe runs', () =>
    withSandbox({ tools: ['route'] }, (sb) => {
      const r = sb.run({}, shell)
      assert.equal(r.status, 2, r.stdout + r.stderr)
      assert.match(r.stderr, /dscacheutil not found/)
      assert.deepEqual(sb.calls(), [])
    }))

  t('route exits 0 with output it cannot read: exit 2', () =>
    withSandbox({}, (sb) => {
      const r = sb.run({ STUB_ROUTE: 'something new\n' }, shell)
      assert.equal(r.status, 2, r.stdout + r.stderr)
      assert.match(r.stderr, /cannot read 'route -n get default'/)
    }))

  t('dscacheutil prints something without an address line: exit 2', () =>
    withSandbox({}, (sb) => {
      const r = sb.run({ STUB_DNS: 'name: github.com\n' }, shell)
      assert.equal(r.status, 2, r.stdout + r.stderr)
      assert.match(r.stderr, /cannot read dscacheutil output/)
    }))

  t('an address only inside another field does not count as up', () =>
    withSandbox({}, (sb) => {
      const r = sb.run({ STUB_DNS: 'name: ip_address: 1.2.3.4\n' }, shell)
      assert.equal(r.status, 2, r.stdout + r.stderr)
    }))

  t('dscacheutil itself fails: exit 2', () =>
    withSandbox({}, (sb) => {
      const r = sb.run({ STUB_DNS: 'rc=3' }, shell)
      assert.equal(r.status, 2, r.stdout + r.stderr)
    }))

  t('an empty WAIT_FOR_NETWORK_TIMEOUT falls back to the default', () =>
    withSandbox({}, (sb) => {
      const r = sb.run({ WAIT_FOR_NETWORK_TIMEOUT: '' }, shell)
      assert.equal(r.status, 0, r.stdout + r.stderr)
    }))

  for (const bad of ['abc', '-5', '1.5']) {
    t(`WAIT_FOR_NETWORK_TIMEOUT=${JSON.stringify(bad)}: exit 2, no probe runs`, () =>
      withSandbox({}, (sb) => {
        const r = sb.run({ WAIT_FOR_NETWORK_TIMEOUT: bad }, shell)
        assert.equal(r.status, 2, r.stdout + r.stderr)
        assert.deepEqual(sb.calls(), [])
      }))
  }

  t('down, then up on the second probe: polls after 2s and exits 0', () =>
    withSandbox({}, (sb) => {
      const r = sb.run({ WAIT_FOR_NETWORK_TIMEOUT: '10', STUB_DNS_1: '' }, shell)
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.match(r.stdout, /^wait-for-network: up after 2s$/m)
      assert.equal(sb.calls().filter((c) => c.startsWith('dscacheutil')).length, 2)
      assert.ok(r.ms >= 1900 && r.ms < 6000, `took ${r.ms}ms`)
    }))

  t('still down: gives up once the timeout has passed, not before', () =>
    withSandbox({}, (sb) => {
      const r = sb.run({ WAIT_FOR_NETWORK_TIMEOUT: '3', STUB_ROUTE: 'rc=1' }, shell)
      assert.equal(r.status, 1, r.stdout + r.stderr)
      assert.match(r.stdout, /down after 4s/)
      // Probes at 0s, 2s, 4s.
      assert.equal(sb.calls().filter((c) => c.startsWith('route')).length, 3)
      assert.ok(r.ms >= 3900 && r.ms < 9000, `took ${r.ms}ms`)
    }))
}

test('defaults: 60s timeout, 2s poll, github.com', () => {
  const s = read('dot_cron/executable_wait-for-network.sh')
  assert.match(s, /^timeout="\$\{WAIT_FOR_NETWORK_TIMEOUT:-60\}"$/m)
  assert.match(s, /^    sleep 2$/m)
  assert.match(s, /^host=github\.com$/m)
})

test('wait-for-network.sh: POSIX sh shebang, parses under sh -n and bash --posix -n', () => {
  assert.match(read('dot_cron/executable_wait-for-network.sh'), /^#!\/bin\/sh\n/)
  for (const shell of SHELLS) {
    if (shell.skip) continue
    const r = spawnSync(shell.argv[0], [...shell.argv.slice(1), '-n', SCRIPT], { encoding: 'utf8' })
    assert.equal(r.status, 0, `${shell.name}: ${r.stderr}`)
  }
})
