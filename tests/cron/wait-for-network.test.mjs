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
// line. The up fixtures (ROUTE_UP, DNS_UP) and empty DNS output were captured
// on macOS; the no-route stub copies the macOS behavior with no default route
// (exit 0, empty stdout, "not in table" on stderr); the other fixtures are
// made up. With no default route (that stub, or route exiting 1) or empty DNS
// output it polls every 2s and exits 1 once WAIT_FOR_NETWORK_TIMEOUT seconds
// have passed; a network that comes up within the timeout exits 0. A missing
// tool, a dscacheutil error, output it cannot read, or a bad or over-long
// (7+ digit) timeout exits 2 at once. It holds under dash and under bash --posix (macOS /bin/sh is
// bash in POSIX mode). It says nothing about real macOS route or dscacheutil
// output after a wake; the host smoke run in the PR checks one connected Mac.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, chmodSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('../../', import.meta.url)
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8')
const SCRIPT = new URL('dot_cron/executable_wait-for-network.sh', ROOT).pathname
// Only system dirs, so no real route or dscacheutil can answer in place of a stub.
const SYS_PATH = '/usr/bin:/bin'
// The script appends these itself (launchd's PATH has no /sbin).
const SBIN = '/usr/sbin:/sbin'

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
// No default route on macOS: exit 0, empty stdout, "not in table" on stderr.
const ROUTE_NONE = 'rc=0'
// A route that fails outright: also no route.
const ROUTE_FAIL = 'rc=1'

// Each stub logs its call, then replays the output for this call number:
// STUB_<TOOL>_<n> (1-based), else STUB_<TOOL>. A value "rc=<k>" exits k with no
// stdout and the macOS route "not in table" line on stderr.
const stub = (name, envName) =>
  '#!/bin/sh\n' +
  `echo "${name} $*" >> "$CALLS"\n` +
  `n=$(grep -c '^${name} ' "$CALLS")\n` +
  `eval "v=\\\${STUB_${envName}_$n-\\\${STUB_${envName}-}}"\n` +
  'case "$v" in rc=*) echo "route: writing to routing socket: not in table" >&2; exit "${v#rc=}" ;; esac\n' +
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
    run(env = {}, shell = SHELLS[0], timeout = 30000) {
      // Built from scratch so the host's WAIT_FOR_NETWORK_TIMEOUT never leaks in.
      const t0 = Date.now()
      const r = spawnSync(shell.argv[0], [...shell.argv.slice(1), SCRIPT], {
        encoding: 'utf8',
        timeout,
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
    const r = spawnSync('sh', ['-c', `command -v ${t}`], { env: { PATH: `${SYS_PATH}:${SBIN}` } })
    assert.notEqual(r.status, 0, `${t} found on ${SYS_PATH}:${SBIN}`)
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

  for (const [name, route] of [
    ['macOS: exit 0, empty stdout, "not in table" on stderr', ROUTE_NONE],
    ['route exits 1', ROUTE_FAIL],
  ]) {
    t(`no default route (${name}): exit 1 after the timeout and says why`, () =>
      withSandbox({}, (sb) => {
        const r = sb.run({ STUB_ROUTE: route, WAIT_FOR_NETWORK_TIMEOUT: '2' }, shell)
        assert.equal(r.status, 1, r.stdout + r.stderr)
        assert.match(r.stdout, /^wait-for-network: down after 2s \(default route: no, github\.com DNS: yes\)$/m)
        assert.equal(r.stderr, '', 'route stderr must not reach the log')
        assert.equal(sb.calls().filter((c) => c.startsWith('route')).length, 2)
      }))
  }

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

  t('a 6-digit WAIT_FOR_NETWORK_TIMEOUT is accepted', () =>
    withSandbox({}, (sb) => {
      const r = sb.run({ WAIT_FOR_NETWORK_TIMEOUT: '999999' }, shell)
      assert.equal(r.status, 0, r.stdout + r.stderr)
    }))

  for (const bad of ['abc', '-5', '1.5', '1000000', '99999999999999999999']) {
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
      const r = sb.run({ WAIT_FOR_NETWORK_TIMEOUT: '3', STUB_ROUTE: ROUTE_NONE }, shell)
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

// --- Under launchd -----------------------------------------------------------
//
// What a pass proves: run the way launchd runs them -- `/bin/sh -c <command>`
// with exactly the EnvironmentVariables the rendered plist sets -- the chezmoi,
// cf, and rea jobs reach the deployed ~/.cron/wait-for-network.sh, and it can
// evaluate: it finds route and dscacheutil where macOS ships them
// (/sbin/route and /usr/bin/dscacheutil, checked on macOS 27). With no default
// route the job skips and never runs its update; with the network up the job
// runs. macOS dirs are emulated by prefixing a sandbox root to every absolute
// dir in the plist PATH (and to /sbin, /usr/sbin, and /usr/bin/dscacheutil in
// the deployed scripts, so an absolute-path fix counts too); the real /usr/bin
// and /bin follow for sh's own tools and hold no route or dscacheutil (first
// test above). It says nothing about the real launchd or real macOS output.

const cskip = has('chezmoi') ? false : 'chezmoi not installed (see the run command at the top)'
const MAC_TOOLS = { route: '/sbin', dscacheutil: '/usr/bin' }
const JOBS = [
  { job: 'chezmoi', runs: 'chezmoi update --force' },
  { job: 'cf', runs: 'npm install --global cf@latest' },
  { job: 'rea', runs: 'npm install --global rea-agents@latest' },
]

// Rewrites absolute macOS system paths in a deployed script to live under root.
const macify = (text, root) =>
  text
    .replace(/(?<![\w./~-])\/(usr\/)?sbin(?![\w.-])/g, (m) => root + m)
    .replace(/(?<![\w./~-])\/usr\/bin\/dscacheutil/g, (m) => root + m)

function renderPlist(job, home) {
  const xml = spawnSync('chezmoi', ['--source', ROOT.pathname, '--destination', home, 'execute-template'], {
    encoding: 'utf8',
    input: read(`private_Library/LaunchAgents/com.rdegges.${job}.plist.tmpl`),
    env: { PATH: process.env.PATH, HOME: home },
  })
  assert.equal(xml.status, 0, xml.stderr)
  const json = spawnSync('python3', ['-c', 'import plistlib,sys,json; json.dump(plistlib.loads(sys.stdin.buffer.read()), sys.stdout)'], {
    encoding: 'utf8',
    input: xml.stdout,
  })
  assert.equal(json.status, 0, json.stderr)
  return JSON.parse(json.stdout)
}

// Deploys every dot_cron script into a sandbox HOME, puts stub macOS tools and
// stub job tools under root, and runs the job's plist command as launchd would.
function launchdRun(job, { route }) {
  const base = mkdtempSync(join(tmpdir(), 'wait-launchd-'))
  try {
    const root = join(base, 'root')
    const home = join(base, 'home')
    const calls = join(base, 'calls')
    writeFileSync(calls, '')
    mkdirSync(join(home, '.cron', 'logs'), { recursive: true })
    for (const f of readdirSync(new URL('dot_cron/', ROOT))) {
      if (!f.startsWith('executable_')) continue
      const dest = join(home, '.cron', f.slice('executable_'.length))
      writeFileSync(dest, macify(read(`dot_cron/${f}`), root))
      chmodSync(dest, 0o755)
    }
    const put = (dir, name, body) => {
      mkdirSync(join(root, dir), { recursive: true })
      writeFileSync(join(root, dir, name), body)
      chmodSync(join(root, dir, name), 0o755)
    }
    put(MAC_TOOLS.route, 'route', stub('route', 'ROUTE'))
    put(MAC_TOOLS.dscacheutil, 'dscacheutil', stub('dscacheutil', 'DNS'))
    // Job tools, where Homebrew would put them; each logs its call and exits 0.
    for (const t of ['chezmoi', 'npm']) put('/opt/homebrew/bin', t, `#!/bin/sh\necho "${t} $*" >> "$CALLS"\n`)

    const p = renderPlist(job, home)
    assert.deepEqual(p.ProgramArguments.slice(0, 2), ['/bin/sh', '-c'])
    const PATH = [...p.EnvironmentVariables.PATH.split(':').map((d) => root + d), SYS_PATH].join(':')
    const r = spawnSync('/bin/sh', ['-c', p.ProgramArguments[2]], {
      encoding: 'utf8',
      timeout: 120000,
      env: {
        ...p.EnvironmentVariables,
        PATH,
        HOME: home,
        CALLS: calls,
        STUB_ROUTE: route,
        STUB_DNS: DNS_UP,
        // Not in the plist; keeps the down case to one probe.
        WAIT_FOR_NETWORK_TIMEOUT: '0',
      },
    })
    return {
      status: r.status,
      log: readFileSync(join(home, '.cron', 'logs', `${job}.log`), 'utf8'),
      calls: readFileSync(calls, 'utf8').split('\n').filter(Boolean),
      marker: existsSync(join(home, '.cron', 'logs', `${job}.FAILED`)),
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

for (const { job, runs } of JOBS) {
  test(`launchd ${job}: under the plist's own PATH the network check can evaluate (finds route and dscacheutil)`, { skip: cskip }, () => {
    const r = launchdRun(job, { route: ROUTE_UP })
    assert.doesNotMatch(r.log, /wait-for-network: .*(not found|cannot check)/, r.log)
    assert.ok(r.calls.includes('route -n get default'), `route never probed; log:\n${r.log}`)
    assert.ok(r.calls.includes('dscacheutil -q host -a name github.com'), `dscacheutil never probed; log:\n${r.log}`)
  })

  for (const [name, route] of [['macOS no-route output', ROUTE_NONE], ['route exits 1', ROUTE_FAIL]]) {
    test(`launchd ${job}: no default route (${name}) -> the job skips and never runs its update`, { skip: cskip }, () => {
      const r = launchdRun(job, { route })
      assert.equal(r.status, 0, r.log)
      assert.match(r.log, new RegExp(`^${job}-update: network not up; skipped$`, 'm'), r.log)
      assert.ok(!r.calls.includes(runs), `ran "${runs}" with the network down; log:\n${r.log}`)
    })
  }

  test(`launchd ${job}: network up -> the job runs its update`, { skip: cskip }, () => {
    const r = launchdRun(job, { route: ROUTE_UP })
    assert.ok(r.calls.includes(runs), `"${runs}" never ran; log:\n${r.log}`)
    assert.doesNotMatch(r.log, /skipped/)
  })
}

// A timeout the validator accepts must not hit a shell error in the loop. Today
// a 20-digit value passes the [0-9] check, then every `[ -ge ]` fails with
// "Illegal number" / "integer expression expected", so the loop never gives up.
// Either rejecting it (exit 2) or handling it passes; a shell error does not.
for (const shell of SHELLS) {
  test(`[${shell.name}] an over-long WAIT_FOR_NETWORK_TIMEOUT never makes test(1) error`, { skip: shell.skip }, () =>
    withSandbox({}, (sb) => {
      const r = sb.run({ WAIT_FOR_NETWORK_TIMEOUT: '99999999999999999999', STUB_ROUTE: ROUTE_NONE }, shell, 3000)
      assert.doesNotMatch(r.stderr, /Illegal number|integer expression expected|out of range/, r.stderr)
    }))
}

// chezmoi apply also runs cf-update.sh and rea-update.sh (run_onchange_after_*),
// keyed on the ~/.tool-versions hash. A network skip there would exit 0, so
// chezmoi would record an install that did not happen as done. The templates
// bypass the wait (WAIT_FOR_NETWORK=true), so an offline apply fails loudly and
// runs again on the next apply.
for (const [tmpl, script] of [
  ['run_onchange_after_install-cloudflare-cli.sh.tmpl', 'cf-update.sh'],
  ['run_onchange_after_install-rea.sh.tmpl', 'rea-update.sh'],
]) {
  test(`${tmpl}: an offline chezmoi apply cannot record the install as done via a network skip`, () => {
    const src = read(tmpl)
    const execs = src.split('\n').filter((l) => l.includes(script) && /^\s*(\w+=\S*\s+)*exec\b/.test(l))
    assert.equal(execs.length, 1, `want one exec line for ${script}`)
    assert.equal(execs[0], `WAIT_FOR_NETWORK=true exec "$HOME/.cron/${script}"`, 'the apply-time run still takes the skip-and-exit-0 path')
  })

  test(`${tmpl}: run as written, the update runs and fails loudly even when the network wait would skip`, () => {
    const base = mkdtempSync(join(tmpdir(), 'wait-onchange-'))
    try {
      const home = join(base, 'home')
      const bin = join(base, 'bin')
      const calls = join(base, 'calls')
      writeFileSync(calls, '')
      mkdirSync(join(home, '.cron'), { recursive: true })
      mkdirSync(bin)
      const deployed = join(home, '.cron', script)
      writeFileSync(deployed, read(`dot_cron/executable_${script}`))
      chmodSync(deployed, 0o755)
      // A deployed wait that always reports the network down.
      writeFileSync(join(home, '.cron', 'wait-for-network.sh'), '#!/bin/sh\nexit 1\n')
      chmodSync(join(home, '.cron', 'wait-for-network.sh'), 0o755)
      writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho "npm $*" >> "$CALLS"\nexit 1\n')
      chmodSync(join(bin, 'npm'), 0o755)
      // The template body without its chezmoi {{ }} lines.
      const body = read(tmpl).split('\n').filter((l) => !l.includes('{{')).join('\n')
      const r = spawnSync('bash', ['-c', body], {
        encoding: 'utf8',
        env: { HOME: home, PATH: `${bin}:${SYS_PATH}`, CALLS: calls },
      })
      assert.equal(r.status, 1, r.stdout + r.stderr)
      assert.doesNotMatch(r.stdout, /skipped/)
      assert.match(readFileSync(calls, 'utf8'), /^npm install --global /m)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
}
