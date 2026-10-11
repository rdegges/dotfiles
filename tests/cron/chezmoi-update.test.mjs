// Behavior of the hourly dotfiles updater (dot_cron/executable_chezmoi-update.sh),
// its failure banner in dot_zshrc, and the crontab line that runs it.
//
// Run from the repo root (zsh is needed for the banner tests and chezmoi for
// the real-apply tests; without them those tests skip):
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'apt-get update -qq && apt-get install -y -qq zsh >/dev/null &&
//      sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin &&
//      node --test tests/cron/'
//
// What a pass proves: with a stub chezmoi (on PATH or via CHEZMOI), the script
// runs exactly `chezmoi update --force`, passes its output through to the log,
// exits with chezmoi's own status, writes ~/.cron/logs/chezmoi.FAILED (one
// entry, replaced, never appended) on any non-zero status -- chezmoi missing
// and chezmoi killed by a signal included -- and removes it on success. It
// holds under dash and under bash --posix (macOS /bin/sh is bash in POSIX
// mode). The crontab line, run as written, produces that log. With the real
// chezmoi: the deployed script is mode 0755; the crontab-install step runs
// after ~/.cron/chezmoi-update.sh is written, so a new crontab never points at
// a missing script; and a `chezmoi update` that rewrites the script while the
// script is running does not corrupt the running copy. It says nothing about
// a real `git pull`, macOS cron, or Full Disk Access.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, chmodSync, rmSync, statSync, copyFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('../../', import.meta.url)
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8')
const SCRIPT = new URL('dot_cron/executable_chezmoi-update.sh', ROOT).pathname
// Only system dirs, so no real chezmoi can answer in place of the stub.
const SYS_PATH = '/usr/bin:/bin'

const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0
const zskip = has('zsh') ? false : 'zsh not installed (see the run command at the top)'
const cskip = has('chezmoi') ? false : 'chezmoi not installed (see the run command at the top)'
const bskip = has('bash') ? false : 'bash not installed'

// dash is Debian's /bin/sh; macOS /bin/sh is bash in POSIX mode.
const SHELLS = [
  { name: 'sh', argv: ['sh'], skip: false },
  { name: 'bash --posix', argv: ['bash', '--posix'], skip: bskip },
]

const STUB =
  '#!/bin/sh\n' +
  'echo "chezmoi $*" >> "$CALLS"\n' +
  'echo "stub stdout"\n' +
  'echo "stub stderr" >&2\n' +
  'if [ -n "${STUB_SIGNAL:-}" ]; then kill -"$STUB_SIGNAL" $$; fi\n' +
  'exit "${STUB_CHEZMOI_RC:-0}"\n'

// A fresh HOME and stub bin dir. `stub` puts a stub chezmoi on PATH.
function sandbox({ stub = true, homeName = 'home' } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'chezmoi-update-'))
  const home = join(base, homeName)
  const bin = join(base, 'bin')
  mkdirSync(home, { recursive: true })
  mkdirSync(bin)
  const stubPath = join(base, 'stub-chezmoi')
  writeFileSync(stubPath, STUB)
  chmodSync(stubPath, 0o755)
  if (stub) {
    copyFileSync(stubPath, join(bin, 'chezmoi'))
    chmodSync(join(bin, 'chezmoi'), 0o755)
  }
  const calls = join(base, 'calls')
  writeFileSync(calls, '')
  const logs = join(home, '.cron', 'logs')
  const marker = join(logs, 'chezmoi.FAILED')
  return {
    base,
    home,
    bin,
    logs,
    marker,
    stubPath,
    calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    env: (env = {}) => ({ HOME: home, PATH: `${bin}:${SYS_PATH}`, CALLS: calls, ...env }),
    run(env = {}, shell = SHELLS[0]) {
      // Built from scratch so the host's CHEZMOI etc. never leak in.
      return spawnSync(shell.argv[0], [...shell.argv.slice(1), SCRIPT], { encoding: 'utf8', env: this.env(env) })
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

function assertFailed(sb, r, rc) {
  assert.equal(r.status, rc, r.stdout + r.stderr)
  assert.match(r.stdout, new RegExp(`^chezmoi-update: FAILED: exit ${rc}$`, 'm'))
  assert.doesNotMatch(r.stdout, /chezmoi-update: ok/)
  assert.ok(existsSync(sb.marker), 'no chezmoi.FAILED marker written')
  const m = readFileSync(sb.marker, 'utf8')
  assert.match(
    m,
    new RegExp(
      `^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} chezmoi update failed: exit ${rc} ` +
        `\\(see ~/\\.cron/logs/chezmoi\\.log, then run 'chezmoi update'\\)\\n$`,
    ),
  )
  return m
}

// --- chezmoi-update.sh: behavior, under each /bin/sh flavor ------------------

for (const shell of SHELLS) {
  const t = (name, fn) => test(`[${shell.name}] ${name}`, { skip: shell.skip }, fn)

  t('success: runs exactly `chezmoi update --force` once, exits 0, prints ok, leaves no marker', () =>
    withSandbox({}, (sb) => {
      const r = sb.run({}, shell)
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.deepEqual(sb.calls(), ['chezmoi update --force'])
      assert.match(r.stdout, /^chezmoi-update: ok$/m)
      assert.equal(existsSync(sb.marker), false)
      // Nothing created under HOME on success: no stray logs dir.
      assert.equal(existsSync(sb.logs), false)
    }))

  t("chezmoi's stdout and stderr pass through (the cron log is the only record)", () =>
    withSandbox({}, (sb) => {
      const r = sb.run({ STUB_CHEZMOI_RC: '1' }, shell)
      assert.match(r.stdout, /^stub stdout$/m)
      assert.match(r.stderr, /^stub stderr$/m)
    }))

  t('success removes a marker left by an earlier failure', () =>
    withSandbox({}, (sb) => {
      mkdirSync(sb.logs, { recursive: true })
      writeFileSync(sb.marker, 'old failure\n')
      writeFileSync(join(sb.logs, 'cf.FAILED'), 'cf is broken\n')
      const r = sb.run({}, shell)
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.equal(existsSync(sb.marker), false)
      // Only its own marker: another job's marker stays.
      assert.equal(readFileSync(join(sb.logs, 'cf.FAILED'), 'utf8'), 'cf is broken\n')
    }))

  t('failure exit 1: exits 1, creates the logs dir and a marker that says what to do', () =>
    withSandbox({}, (sb) => {
      const r = sb.run({ STUB_CHEZMOI_RC: '1' }, shell)
      assertFailed(sb, r, 1)
      assert.deepEqual(sb.calls(), ['chezmoi update --force'])
    }))

  t("a non-1 status is passed through as the script's own exit code and named in the marker", () =>
    withSandbox({}, (sb) => {
      assertFailed(sb, sb.run({ STUB_CHEZMOI_RC: '3' }, shell), 3)
    }))

  t('chezmoi not on PATH: exit 127 with a marker (cron PATH drift is the likely cause)', () =>
    withSandbox({ stub: false }, (sb) => {
      const r = sb.run({}, shell)
      assertFailed(sb, r, 127)
    }))

  t('chezmoi killed by a signal (e.g. an OOM or hung-run kill): non-zero exit with a marker', () =>
    withSandbox({}, (sb) => {
      const r = sb.run({ STUB_SIGNAL: 'KILL' }, shell)
      // 128 + SIGKILL(9).
      assertFailed(sb, r, 137)
    }))

  t('repeated failures replace the marker, they never append to it', () =>
    withSandbox({}, (sb) => {
      for (let i = 0; i < 3; i++) sb.run({ STUB_CHEZMOI_RC: String(i + 1) }, shell)
      const m = readFileSync(sb.marker, 'utf8')
      assert.equal(m.trimEnd().split('\n').length, 1, m)
      assert.match(m, /exit 3 /)
    }))

  t('CHEZMOI overrides the command; an empty CHEZMOI falls back to chezmoi on PATH', () =>
    withSandbox({ stub: false }, (sb) => {
      let r = sb.run({ CHEZMOI: sb.stubPath }, shell)
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.deepEqual(sb.calls(), ['chezmoi update --force'])
      // Empty CHEZMOI with no chezmoi on PATH: must try `chezmoi`, not run "".
      r = sb.run({ CHEZMOI: '' }, shell)
      assertFailed(sb, r, 127)
      assert.doesNotMatch(r.stderr, /: : not found|permission denied/i, r.stderr)
    }))

  t('HOME with spaces and non-ASCII: marker lands in that HOME', () =>
    withSandbox({ homeName: 'Ränd all ☁️' }, (sb) => {
      const r = sb.run({ STUB_CHEZMOI_RC: '1' }, shell)
      assertFailed(sb, r, 1)
      assert.ok(sb.marker.includes('Ränd all ☁️'))
    }))
}

test('chezmoi-update.sh: POSIX sh shebang, parses under sh -n and bash --posix -n', () => {
  assert.match(read('dot_cron/executable_chezmoi-update.sh'), /^#!\/bin\/sh\n/)
  for (const shell of SHELLS) {
    if (shell.skip) continue
    const r = spawnSync(shell.argv[0], [...shell.argv.slice(1), '-n', SCRIPT], { encoding: 'utf8' })
    assert.equal(r.status, 0, `${shell.name}: ${r.stderr}`)
  }
})

// --- dot_zshrc failure banner -------------------------------------------------

const zshrcLine = read('dot_zshrc')
  .split('\n')
  .find((l) => l.includes('.FAILED') && !l.trimStart().startsWith('#'))

function banner(home) {
  // -f: no startup files, so only the extracted line runs.
  return spawnSync('zsh', ['-f', '-c', zshrcLine], { encoding: 'utf8', env: { HOME: home, PATH: SYS_PATH } })
}

test('end to end: a failed run shows a red banner line, the next good run clears it', { skip: zskip }, () =>
  withSandbox({}, (sb) => {
    sb.run({ STUB_CHEZMOI_RC: '1' })
    const shown = banner(sb.home)
    assert.equal(shown.status, 0, shown.stderr)
    assert.match(
      shown.stdout,
      /^\x1b\[31mcron: \d{4}-\d{2}-\d{2} \d{2}:\d{2} chezmoi update failed: exit 1 \(see ~\/\.cron\/logs\/chezmoi\.log, then run 'chezmoi update'\)\x1b\[0m\n$/,
    )
    sb.run()
    assert.equal(banner(sb.home).stdout, '')
  }))

// --- Wiring -------------------------------------------------------------------

const crontab = read('dot_cron/crontab.tmpl')
const jobLines = crontab.split('\n').filter((l) => l.trim() && !l.trimStart().startsWith('#') && !/^[A-Z_]+=/.test(l))

test('crontab: one hourly :15 job runs ~/.cron/chezmoi-update.sh and logs to chezmoi.log', () => {
  const jobs = jobLines.filter((l) => l.includes('chezmoi-update.sh'))
  assert.equal(jobs.length, 1, jobs.join('\n'))
  assert.match(jobs[0], /^15 \* \* \* \* \{ date; \$HOME\/\.cron\/chezmoi-update\.sh; \} > \$HOME\/\.cron\/logs\/chezmoi\.log 2>&1$/)
})

test('crontab: no job still runs a bare `chezmoi update` that bypasses the marker', () => {
  const bare = jobLines.filter((l) => /\bchezmoi (update|apply)\b/.test(l))
  assert.deepEqual(bare, [])
})

test('crontab: the chezmoi job comment names the marker the script really writes', () => {
  const block = crontab.split('\n\n').find((b) => b.includes('chezmoi-update.sh'))
  assert.match(block, /~\/\.cron\/logs\/chezmoi\.FAILED/)
  assert.doesNotMatch(block, /notification/i, block)
})

// The job line minus its 5 schedule fields, as cron hands it to SHELL=/bin/sh.
const cronCommand = jobLines.find((l) => l.includes('chezmoi-update.sh')).split(/\s+/).slice(5).join(' ')

for (const shell of SHELLS) {
  test(`[${shell.name}] the crontab command, run as written, logs a date, chezmoi output, and the result`, { skip: shell.skip }, () =>
    withSandbox({}, (sb) => {
      mkdirSync(join(sb.home, '.cron'), { recursive: true })
      mkdirSync(sb.logs, { recursive: true })
      const deployed = join(sb.home, '.cron', 'chezmoi-update.sh')
      copyFileSync(SCRIPT, deployed)
      chmodSync(deployed, 0o755)
      const log = join(sb.logs, 'chezmoi.log')
      const runCron = (env) =>
        spawnSync(shell.argv[0], [...shell.argv.slice(1), '-c', cronCommand], { encoding: 'utf8', env: sb.env(env) })

      let r = runCron({ STUB_CHEZMOI_RC: '2' })
      assert.equal(r.stdout + r.stderr, '', 'everything should go to the log')
      let l = readFileSync(log, 'utf8')
      assert.match(l, /^\S.*\d{2}:\d{2}:\d{2}.*\n/, 'first line is `date` output')
      assert.match(l, /^stub stdout$/m)
      assert.match(l, /^stub stderr$/m)
      assert.match(l, /^chezmoi-update: FAILED: exit 2$/m)
      assert.ok(existsSync(sb.marker))

      r = runCron({})
      l = readFileSync(log, 'utf8')
      assert.match(l, /^chezmoi-update: ok$/m)
      assert.doesNotMatch(l, /FAILED/, 'log is truncated each run, not appended')
      assert.equal(existsSync(sb.marker), false)
    }))
}

// --- Real chezmoi: deploy, ordering, self-rewrite -------------------------------

// A minimal chezmoi source + config in a scratch dir. Never touches the real HOME.
function chezmoiSandbox() {
  const sb = sandbox({ stub: false })
  const src = join(sb.base, 'src')
  mkdirSync(join(src, 'dot_cron'), { recursive: true })
  copyFileSync(SCRIPT, join(src, 'dot_cron', 'executable_chezmoi-update.sh'))
  copyFileSync(new URL('dot_cron/crontab.tmpl', ROOT), join(src, 'dot_cron', 'crontab.tmpl'))
  const cfg = join(sb.base, 'chezmoi.toml')
  writeFileSync(cfg, '')
  const cz = ['--source', src, '--destination', sb.home, '--config', cfg, '--no-tty']
  const realPath = process.env.PATH
  sb.src = src
  sb.apply = (env = {}) =>
    spawnSync('chezmoi', [...cz, 'apply', '--force'], { encoding: 'utf8', env: { ...sb.env(), PATH: realPath, ...env } })
  sb.cz = cz
  return sb
}

test('chezmoi apply deploys ~/.cron/chezmoi-update.sh as an executable the crontab can run directly', { skip: cskip }, () => {
  const sb = chezmoiSandbox()
  try {
    const r = sb.apply()
    assert.equal(r.status, 0, r.stderr)
    const deployed = join(sb.home, '.cron', 'chezmoi-update.sh')
    assert.equal(statSync(deployed).mode & 0o111, 0o111, 'not executable by cron')
    assert.equal(readFileSync(deployed, 'utf8'), readFileSync(SCRIPT, 'utf8'))
  } finally {
    sb.cleanup()
  }
})

test('ordering: the crontab-install step runs after ~/.cron/chezmoi-update.sh is written', { skip: cskip }, () => {
  // Same target name as run_onchange_install-crontab.sh.tmpl (that one is
  // darwin-only, so it renders empty here): chezmoi runs a script with no
  // before_/after_ in target-name order among files, and ".cron/..." sorts
  // before "install-crontab.sh". If that ever flips, a new crontab would point
  // at a script that does not exist yet, and the job would fail with no marker.
  const sb = chezmoiSandbox()
  try {
    const probe = join(sb.base, 'probe')
    writeFileSync(
      join(sb.src, 'run_onchange_install-crontab.sh'),
      '#!/bin/sh\n' +
        `{ test -x "$HOME/.cron/chezmoi-update.sh" && echo script=yes || echo script=no;\n` +
        `  test -f "$HOME/.cron/crontab" && echo crontab=yes || echo crontab=no; } > "${probe}"\n`,
    )
    const r = sb.apply()
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readFileSync(probe, 'utf8'), 'script=yes\ncrontab=yes\n')
  } finally {
    sb.cleanup()
  }
})

for (const shell of SHELLS) {
  test(
    `[${shell.name}] self-rewrite: a chezmoi update that replaces the running script does not corrupt the run`,
    { skip: cskip || shell.skip },
    () => {
      // The cron job runs ~/.cron/chezmoi-update.sh, and the `chezmoi update`
      // inside it may rewrite that same file. bash reads a script as it goes,
      // so an in-place rewrite would make it run bytes of the new version from
      // the old offset. chezmoi must replace the file (new inode), not rewrite it.
      const sb = chezmoiSandbox()
      try {
        assert.equal(sb.apply().status, 0)
        const deployed = join(sb.home, '.cron', 'chezmoi-update.sh')
        const inodeBefore = statSync(deployed).ino
        // v2: a long new header shifts every offset, and a different ok line.
        const v2 =
          '#!/bin/sh\n' +
          '# padding\n'.repeat(200) +
          'echo "V2 RAN: should not run in this process"\nexit 42\n'
        const wrapper = join(sb.base, 'chezmoi-wrapper')
        writeFileSync(
          wrapper,
          '#!/bin/sh\n' +
            `cp "${join(sb.base, 'v2')}" "${join(sb.src, 'dot_cron', 'executable_chezmoi-update.sh')}"\n` +
            `exec chezmoi ${sb.cz.map((a) => `'${a}'`).join(' ')} apply --force\n`,
        )
        chmodSync(wrapper, 0o755)
        writeFileSync(join(sb.base, 'v2'), v2)
        const r = spawnSync(shell.argv[0], [...shell.argv.slice(1), deployed], {
          encoding: 'utf8',
          env: { ...sb.env({ CHEZMOI: wrapper }), PATH: process.env.PATH },
        })
        assert.equal(readFileSync(deployed, 'utf8'), v2, 'the apply did not land')
        assert.equal(r.status, 0, r.stdout + r.stderr)
        assert.match(r.stdout, /^chezmoi-update: ok$/m)
        assert.doesNotMatch(r.stdout + r.stderr, /V2 RAN|padding|not found/)
        assert.notEqual(statSync(deployed).ino, inodeBefore, 'file was rewritten in place')
      } finally {
        sb.cleanup()
      }
    },
  )
}
