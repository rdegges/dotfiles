// Behavior of the Cloudflare CLI updater (dot_cron/executable_cf-update.sh),
// its failure banner in dot_zshrc, and the wiring that runs it (crontab line,
// run_onchange_after_install-cloudflare-cli.sh.tmpl).
//
// Run from the repo root (zsh is needed for the banner tests; without it they
// skip):
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'apt-get update -qq && apt-get install -y -qq zsh >/dev/null && node --test tests/cron/'
//
// What a pass proves: with stub npm/asdf/cf on a PATH that has no real ones,
// the script calls `npm install --global <spec>` then `asdf reshim nodejs` then
// `cf --version`; writes ~/.cron/logs/cf.FAILED (one entry, replaced, never
// appended) on each failure step and removes it on success; and the zshrc loop
// prints every marker verbatim and nothing when there are none. It says nothing
// about the real npm registry, macOS /bin/sh (bash in POSIX mode; this runs
// under Debian dash), or cron itself; those were checked by hand in the gate run.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, chmodSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('../../', import.meta.url)
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8')
const SCRIPT = new URL('dot_cron/executable_cf-update.sh', ROOT).pathname
// Only system dirs: the node image has a real npm in /usr/local/bin.
const SYS_PATH = '/usr/bin:/bin'

const STUBS = {
  npm: '#!/bin/sh\necho "npm $*" >> "$CALLS"\nexit "${STUB_NPM_RC:-0}"\n',
  asdf: '#!/bin/sh\necho "asdf $*" >> "$CALLS"\nexit 0\n',
  cf:
    '#!/bin/sh\necho "cf $*" >> "$CALLS"\n' +
    'if [ "${STUB_CF_RC:-0}" != 0 ]; then echo "${STUB_CF_ERR:-boom}" >&2; exit "$STUB_CF_RC"; fi\n' +
    'printf "%s\\n" "${STUB_CF_OUT:-cf 9.9.9}"\n',
}

// A fresh HOME and stub bin dir. `stubs` picks which tools exist on PATH.
function sandbox({ stubs = ['npm', 'asdf', 'cf'], homeName = 'home' } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'cf-update-'))
  const home = join(base, homeName)
  const bin = join(base, 'bin')
  mkdirSync(home, { recursive: true })
  mkdirSync(bin)
  for (const s of stubs) {
    writeFileSync(join(bin, s), STUBS[s])
    chmodSync(join(bin, s), 0o755)
  }
  const calls = join(base, 'calls')
  writeFileSync(calls, '')
  const marker = join(home, '.cron', 'logs', 'cf.FAILED')
  return {
    home,
    marker,
    calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    run: (env = {}) =>
      spawnSync('sh', [SCRIPT], {
        encoding: 'utf8',
        // Built from scratch so the host's CF_UPDATE_PACKAGE etc. never leak in.
        env: { HOME: home, PATH: `${bin}:${SYS_PATH}`, CALLS: calls, ...env },
      }),
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

// --- cf-update.sh: success path ---------------------------------------------

test('success: installs cf@latest, reshims, checks cf, exits 0, leaves no marker', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({ STUB_CF_OUT: 'cf · v1.2.3' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), ['npm install --global cf@latest', 'asdf reshim nodejs', 'cf --version'])
    assert.match(r.stdout, /^cf-update: ok: cf · v1\.2\.3$/m)
    assert.equal(existsSync(sb.marker), false)
  }))

test('success removes a marker left by an earlier failure', () =>
  withSandbox({}, (sb) => {
    mkdirSync(join(sb.home, '.cron', 'logs'), { recursive: true })
    writeFileSync(sb.marker, 'old failure\n')
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.equal(existsSync(sb.marker), false)
  }))

test('CF_UPDATE_PACKAGE overrides the npm spec', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({ CF_UPDATE_PACKAGE: 'cf@1.0.0-beta.1' })
    assert.equal(r.status, 0)
    assert.equal(sb.calls()[0], 'npm install --global cf@1.0.0-beta.1')
  }))

test('an empty CF_UPDATE_PACKAGE falls back to cf@latest (never `npm install --global ""`)', () =>
  withSandbox({}, (sb) => {
    sb.run({ CF_UPDATE_PACKAGE: '' })
    assert.equal(sb.calls()[0], 'npm install --global cf@latest')
  }))

test('no asdf on PATH: still succeeds, skips the reshim', () =>
  withSandbox({ stubs: ['npm', 'cf'] }, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), ['npm install --global cf@latest', 'cf --version'])
  }))

// --- cf-update.sh: failure paths --------------------------------------------

function assertFailed(sb, r, reason) {
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /cf-update: FAILED: /)
  assert.ok(existsSync(sb.marker), 'no cf.FAILED marker written')
  const m = readFileSync(sb.marker, 'utf8')
  assert.match(m, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} cf update failed: /)
  assert.match(m, reason)
  assert.match(m, /see ~\/\.cron\/logs\/cf\.log/)
  return m
}

test('npm missing: exit 1, marker says so (logs dir created), nothing else runs', () =>
  withSandbox({ stubs: ['asdf', 'cf'] }, (sb) => {
    const r = sb.run()
    assertFailed(sb, r, /npm not found on PATH/)
    assert.deepEqual(sb.calls(), [])
  }))

test('npm install fails: exit 1, marker names the spec, no reshim or cf check', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({ STUB_NPM_RC: '1', CF_UPDATE_PACKAGE: 'cf-no-such-pkg@0' })
    assertFailed(sb, r, /npm install --global cf-no-such-pkg@0/)
    assert.deepEqual(sb.calls(), ['npm install --global cf-no-such-pkg@0'])
  }))

test('cf --version fails after install: exit 1, marker carries cf stderr', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({ STUB_CF_RC: '127', STUB_CF_ERR: 'dyld: missing symbol' })
    assertFailed(sb, r, /cf --version: dyld: missing symbol/)
  }))

test('cf missing after install (bin not linked): exit 1 with a marker', () =>
  withSandbox({ stubs: ['npm', 'asdf'] }, (sb) => {
    const r = sb.run()
    assertFailed(sb, r, /cf --version: /)
  }))

test('repeated failures replace the marker, they never append to it', () =>
  withSandbox({}, (sb) => {
    for (let i = 0; i < 3; i++) sb.run({ STUB_NPM_RC: '1' })
    const m = readFileSync(sb.marker, 'utf8')
    assert.equal(m.trimEnd().split('\n').length, 1, m)
  }))

test('HOME with spaces and non-ASCII: marker lands in that HOME', () =>
  withSandbox({ homeName: 'Ränd all ☁️' }, (sb) => {
    const r = sb.run({ STUB_NPM_RC: '1' })
    assertFailed(sb, r, /npm install/)
    assert.ok(sb.marker.includes('Ränd all ☁️'))
  }))

// --- dot_zshrc failure banner -----------------------------------------------

const zshrcLine = read('dot_zshrc')
  .split('\n')
  .find((l) => l.includes('.FAILED') && !l.trimStart().startsWith('#'))
const hasZsh = spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).status === 0
const zskip = hasZsh ? false : 'zsh not installed (see the run command at the top)'

function banner(home) {
  // -f: no startup files, so only the extracted line runs.
  return spawnSync('zsh', ['-f', '-c', zshrcLine], { encoding: 'utf8', env: { HOME: home, PATH: SYS_PATH } })
}

test('zshrc has exactly one failure-banner loop over ~/.cron/logs/*.FAILED with a null glob', () => {
  const lines = read('dot_zshrc')
    .split('\n')
    .filter((l) => l.includes('.FAILED') && !l.trimStart().startsWith('#'))
  assert.equal(lines.length, 1, lines.join('\n'))
  assert.match(lines[0], /~\/\.cron\/logs\/\*\.FAILED\(N\)/)
})

test('banner: prints nothing and exits 0 when ~/.cron/logs is missing or has no markers', { skip: zskip }, () =>
  withSandbox({}, (sb) => {
    let r = banner(sb.home)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout + r.stderr, '')
    mkdirSync(join(sb.home, '.cron', 'logs'), { recursive: true })
    writeFileSync(join(sb.home, '.cron', 'logs', 'cf.log'), 'ok\n')
    r = banner(sb.home)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout + r.stderr, '')
  }))

test('banner: one red line per marker, content printed verbatim (no expansion)', { skip: zskip }, () =>
  withSandbox({}, (sb) => {
    const logs = join(sb.home, '.cron', 'logs')
    mkdirSync(logs, { recursive: true })
    const hostile = 'x $(touch PWNED) `id` %F \\e[0m -n ☁️'
    writeFileSync(join(logs, 'cf.FAILED'), hostile + '\n')
    writeFileSync(join(logs, 'other.FAILED'), 'other failed\n')
    const r = spawnSync('zsh', ['-f', '-c', zshrcLine], {
      encoding: 'utf8',
      cwd: sb.home,
      env: { HOME: sb.home, PATH: SYS_PATH },
    })
    assert.equal(r.status, 0, r.stderr)
    const lines = r.stdout.split('\n').filter(Boolean)
    assert.equal(lines.length, 2, r.stdout)
    assert.ok(lines.includes(`\x1b[31mcron: ${hostile}\x1b[0m`), JSON.stringify(lines))
    assert.ok(lines.includes('\x1b[31mcron: other failed\x1b[0m'), JSON.stringify(lines))
    assert.equal(existsSync(join(sb.home, 'PWNED')), false, 'marker content was executed')
  }))

test('end to end: a failed run shows in the banner, the next good run clears it', { skip: zskip }, () =>
  withSandbox({}, (sb) => {
    sb.run({ STUB_NPM_RC: '1' })
    assert.match(banner(sb.home).stdout, /cron: .* cf update failed: npm install --global cf@latest/)
    sb.run()
    assert.equal(banner(sb.home).stdout, '')
  }))

// --- Wiring ------------------------------------------------------------------

const crontab = read('dot_cron/crontab.tmpl')
const onchange = read('run_onchange_after_install-cloudflare-cli.sh.tmpl')

test('crontab: one daily 10:10 job runs ~/.cron/cf-update.sh and logs to cf.log', () => {
  const jobs = crontab.split('\n').filter((l) => l.includes('cf-update.sh') && !l.startsWith('#'))
  assert.equal(jobs.length, 1, jobs.join('\n'))
  assert.match(jobs[0], /^10 10 \* \* \* \{ date; \$HOME\/\.cron\/cf-update\.sh; \} > \$HOME\/\.cron\/logs\/cf\.log 2>&1$/)
})

test('crontab: PATH puts the asdf shims first so npm and cf resolve to the pinned Node', () => {
  const path = crontab.match(/^PATH=(.*)$/m)
  assert.ok(path, 'no PATH= line')
  assert.equal(path[1].split(':')[0], '{{ .chezmoi.homeDir }}/.asdf/shims')
})

test('crontab: the cf job comment describes the failure signal the script really sends', () => {
  // The script header says it deliberately does NOT send a macOS notification
  // (it writes ~/.cron/logs/cf.FAILED instead). A comment saying otherwise
  // sends the reader looking for a notification that never comes.
  const block = crontab.split('\n\n').find((b) => b.includes('cf-update.sh'))
  assert.doesNotMatch(block, /notification/i, block)
})

test('run_onchange: after_ script, re-runs on Node pin or script change, execs the cron script', () => {
  assert.match(onchange, /^\{\{- if eq \.chezmoi\.os "darwin" -\}\}\n#!\/bin\/bash\n/)
  assert.match(onchange, /\{\{ include "dot_tool-versions" \| sha256sum \}\}/)
  assert.match(onchange, /\{\{ include "dot_cron\/executable_cf-update\.sh" \| sha256sum \}\}/)
  assert.match(onchange, /^exec "\$HOME\/\.cron\/cf-update\.sh"$/m)
  // Every included source file must exist, or chezmoi apply errors out.
  for (const [, f] of onchange.matchAll(/include "([^"]+)"/g)) {
    assert.ok(existsSync(new URL(f, ROOT)), `include target ${f} missing`)
  }
})

test('cf-update.sh: POSIX sh shebang, parses under sh -n', () => {
  assert.match(read('dot_cron/executable_cf-update.sh'), /^#!\/bin\/sh\n/)
  const r = spawnSync('sh', ['-n', SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
})
