// The launchd agents that run the scheduled jobs (private_Library/LaunchAgents,
// .chezmoitemplates/launchagent.plist), the script that loads them
// (run_onchange_after_load-launch-agents.sh.tmpl), and the script that retires
// the old crontab (run_onchange_after_retire-crontab.sh.tmpl).
//
// Run from the repo root (chezmoi, python3, and bash are needed; without
// chezmoi or python3 these tests FAIL, they do not skip; zsh is needed for the
// banner test, which skips without it):
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'apt-get update -qq && apt-get install -y -qq zsh >/dev/null &&
//      sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin &&
//      node --test tests/cron/'
//
// What a pass proves: every agent renders to a plist that Python's plistlib
// parses, whose Label is its file name, whose command is byte for byte the
// command the old crontab ran for that job, whose schedule is that job's old
// cron schedule, and whose PATH is absolute (also for a HOME with spaces, `&`,
// `<`, and quotes). The loader's hash header covers the shared template and
// every agent. With a stub launchctl that keeps load state and refuses a
// bootstrap while a label is still loaded, the loader boots out and then
// bootstraps every agent, waits until a booted-out label is really gone, fails
// when that takes over 10s or a bootstrap fails, boots out orphaned
// com.rdegges.* labels and only those, and never touches the label in
// XPC_SERVICE_NAME (it loads the others and exits 1). With a stub crontab, the
// retire script clears crontab.FAILED when `crontab -l` is empty or absent,
// otherwise tries `crontab -r` once (also after a hung `crontab -l` is killed
// at 30s), writes the marker when that fails, and always exits 0. It says
// nothing about the real launchd, macOS bash 3.2, or TCC; those are checked by
// hand on the Mac after merge.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, chmodSync, rmSync, readdirSync, cpSync, appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SOURCE = new URL('../../', import.meta.url).pathname
const read = (p) => readFileSync(join(SOURCE, p), 'utf8')
const AGENTS_DIR = 'private_Library/LaunchAgents'
const LOADER = 'run_onchange_after_load-launch-agents.sh.tmpl'
const RETIRE = 'run_onchange_after_retire-crontab.sh.tmpl'
const SYS_PATH = '/usr/bin:/bin'
const DARWIN = JSON.stringify({ chezmoi: { os: 'darwin' } })

const hasZsh = spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).status === 0
const zskip = hasZsh ? false : 'zsh not installed (see the run command at the top)'

// The old crontab's job lines (dot_cron/crontab.tmpl before the move), verbatim.
const OLD_CRONTAB = {
  'brew': '0 10 * * * { date; brew update --quiet && brew upgrade --quiet --no-quit; } > $HOME/.cron/logs/brew.log 2>&1',
  'vault-snapshot': '5 * * * * { date; $HOME/.cron/vault-snapshot.sh; } > $HOME/.cron/logs/vault-snapshot.log 2>&1',
  'chezmoi': '15 * * * * { date; $HOME/.cron/chezmoi-update.sh; } > $HOME/.cron/logs/chezmoi.log 2>&1',
  'codex': '20 * * * * { date; "$HOME/.local/bin/codex" update < /dev/null; } > "$HOME/.cron/logs/codex.log" 2>&1',
  'cf': '10 10 * * * { date; $HOME/.cron/cf-update.sh; } > $HOME/.cron/logs/cf.log 2>&1',
  'rea': '25 10 * * * { date; $HOME/.cron/rea-update.sh; } > $HOME/.cron/logs/rea.log 2>&1',
  'asdf': '30 * * * * { date; asdf plugin update --all; } > $HOME/.cron/logs/asdf.log 2>&1',
  'pipx': '45 * * * * { date; pipx upgrade-all; } > $HOME/.cron/logs/pipx.log 2>&1',
  'docker-prune': '0 9 * * * { date; if docker info >/dev/null 2>&1; then docker builder prune -af --filter until=72h; docker image prune -af; else echo "docker not running; skipped"; fi; } > $HOME/.cron/logs/docker-prune.log 2>&1',
  'brew-cleanup': '0 11 * * 6 { date; brew cleanup --prune=30 --quiet; } > $HOME/.cron/logs/brew-cleanup.log 2>&1',
  'oh-my-zsh': '0 10 * * 6 { date; zsh -c \'cd $HOME/.oh-my-zsh && git pull -q\'; } > $HOME/.cron/logs/oh-my-zsh.log 2>&1',
}
const LABELS = Object.keys(OLD_CRONTAB).map((j) => `com.rdegges.${j}`).sort()

// "m h * * dow cmd" -> { schedule: [StartCalendarInterval dict], command }.
function parseCron(line) {
  const [m, h, dom, mon, dow, ...rest] = line.split(' ')
  assert.equal(dom + mon, '**', `table line uses day-of-month or month: ${line}`)
  const entry = { Minute: Number(m) }
  if (h !== '*') entry.Hour = Number(h)
  if (dow !== '*') entry.Weekday = Number(dow)
  return { schedule: [entry], command: rest.join(' ') }
}

function execTemplate(input, { source = SOURCE, home, data } = {}) {
  const ownHome = !home
  home ??= mkdtempSync(join(tmpdir(), 'launch-agents-'))
  try {
    const args = ['--source', source, '--destination', home]
    if (data) args.push('--override-data', data)
    const r = spawnSync('chezmoi', [...args, 'execute-template'], {
      encoding: 'utf8',
      input,
      env: { PATH: process.env.PATH, HOME: home },
    })
    assert.ifError(r.error)
    assert.equal(r.status, 0, `chezmoi execute-template exited ${r.status}: ${r.stderr}`)
    return r.stdout
  } finally {
    if (ownHome) rmSync(home, { recursive: true, force: true })
  }
}

function parsePlist(xml) {
  const r = spawnSync(
    'python3',
    ['-c', 'import plistlib,sys,json; json.dump(plistlib.loads(sys.stdin.buffer.read()), sys.stdout)'],
    { encoding: 'utf8', input: xml },
  )
  assert.ifError(r.error)
  assert.equal(r.status, 0, `plistlib rejected the plist: ${r.stderr}\n${xml}`)
  return JSON.parse(r.stdout)
}

// A HOME that breaks naive XML: spaces, non-ASCII, &, <, and both quotes.
function hostileHome() {
  const base = mkdtempSync(join(tmpdir(), 'launch-agents-'))
  const home = join(base, `Ränd a&b <c> "d" 'e'`)
  mkdirSync(home)
  return { base, home }
}

// --- Agents ---------------------------------------------------------------------

test('agents: exactly one plist template per old crontab job, named com.rdegges.<job>.plist.tmpl', () => {
  const files = readdirSync(join(SOURCE, AGENTS_DIR)).sort()
  assert.deepEqual(files, LABELS.map((l) => `${l}.plist.tmpl`).sort())
})

for (const [job, line] of Object.entries(OLD_CRONTAB)) {
  const label = `com.rdegges.${job}`
  test(`agent ${label}: valid plist with the old crontab command, schedule, and log`, () => {
    const { base, home } = hostileHome()
    try {
      const xml = execTemplate(read(`${AGENTS_DIR}/${label}.plist.tmpl`), { home })
      assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n'), 'XML declaration is not at byte 0')
      const p = parsePlist(xml)
      const want = parseCron(line)

      assert.equal(p.Label, label)
      assert.deepEqual(p.ProgramArguments, ['/bin/sh', '-c', want.command])
      // Byte for byte, again, so a deepEqual quirk cannot hide a difference.
      assert.equal(Buffer.compare(Buffer.from(p.ProgramArguments[2]), Buffer.from(want.command)), 0)
      assert.match(want.command, new RegExp(`> "?\\$HOME/\\.cron/logs/${job}\\.log"? 2>&1$`))
      assert.deepEqual(p.StartCalendarInterval, want.schedule)

      const path = p.EnvironmentVariables.PATH
      assert.equal(path, `${home}/.asdf/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`)
      for (const dir of path.split(':')) assert.ok(dir.startsWith('/'), `relative PATH entry ${dir}`)
      assert.deepEqual(p.EnvironmentVariables, {
        PATH: path,
        HOMEBREW_NO_ENV_HINTS: '1',
        HOMEBREW_NO_AUTO_UPDATE: '1',
        HOMEBREW_NO_ASK: '1',
      })
      assert.equal(p.RunAtLoad, false)
      assert.equal(p.ProcessType, 'Background')
      // The command's own redirect keeps today's logs; launchd must not add its own.
      assert.deepEqual(Object.keys(p).sort(), [
        'EnvironmentVariables', 'Label', 'ProcessType', 'ProgramArguments', 'RunAtLoad', 'StartCalendarInterval',
      ])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
}

test('agents: the command is XML-escaped in the source XML, not passed through raw', () => {
  const xml = execTemplate(read(`${AGENTS_DIR}/com.rdegges.codex.plist.tmpl`))
  const cmd = xml.match(/<string>(\{ date;.*)<\/string>/)[1]
  assert.doesNotMatch(cmd, /[<>"']|&(?!(amp|lt|gt|#34|#39);)/, cmd)
  assert.match(cmd, /&lt; \/dev\/null/)
})

test('agents: each job file keeps its job comment and only calls the shared template', () => {
  for (const label of LABELS) {
    const src = read(`${AGENTS_DIR}/${label}.plist.tmpl`)
    assert.match(src, /^\{\{- \/\* \S[\s\S]*? \*\/ -\}\}\n\{\{ template "launchagent\.plist" \(dict\n/, label)
    assert.match(src, new RegExp(`"label" "${label.replace(/\./g, '\\.')}"\n`), label)
  }
})

test('chezmoiignore: Library/LaunchAgents is ignored off darwin and managed on darwin', () => {
  const ignored = (os) =>
    execTemplate(read('.chezmoiignore'), { data: JSON.stringify({ work: false, chezmoi: { os } }) })
      .split('\n')
      .includes('Library/LaunchAgents')
  assert.equal(ignored('linux'), true)
  assert.equal(ignored('darwin'), false)
})

test('chezmoiremove: the old ~/.cron/crontab goes, and its source and installer are gone', () => {
  assert.ok(read('.chezmoiremove').split('\n').includes('.cron/crontab'))
  assert.equal(existsSync(join(SOURCE, 'dot_cron/crontab.tmpl')), false)
  assert.equal(existsSync(join(SOURCE, 'run_onchange_install-crontab.sh.tmpl')), false)
})

// --- Loader: render ---------------------------------------------------------------

const renderLoader = (opts = {}) => execTemplate(readFileSync(join(opts.source ?? SOURCE, LOADER), 'utf8'), { data: DARWIN, ...opts })

test('loader: renders only on darwin; the darwin render parses under bash -n', () => {
  assert.equal(execTemplate(read(LOADER), { data: JSON.stringify({ chezmoi: { os: 'linux' } }) }), '')
  const s = renderLoader()
  assert.match(s, /^#!\/bin\/bash\n/)
  const r = spawnSync('bash', ['-n'], { encoding: 'utf8', input: s })
  assert.equal(r.status, 0, r.stderr)
})

test('loader: the hash header names the shared template and every agent; the label list is every agent', () => {
  const s = renderLoader()
  const hashes = [...s.matchAll(/^# (\S+) hash: ([0-9a-f]{64})$/gm)].map((m) => m[1])
  assert.deepEqual(hashes, ['launchagent.plist', ...LABELS.map((l) => `${l}.plist.tmpl`).sort()])
  const list = s.match(/^labels=\(\n([\s\S]*?)\n\)$/m)[1]
  assert.deepEqual(list.split('\n').map((l) => l.trim()).sort(), LABELS.map((l) => `'${l}'`))
})

test('loader: changing only the shared template, or only one agent, changes the rendered script', () => {
  const base = mkdtempSync(join(tmpdir(), 'launch-agents-src-'))
  try {
    for (const p of ['.chezmoitemplates', AGENTS_DIR, LOADER]) cpSync(join(SOURCE, p), join(base, p), { recursive: true })
    const before = renderLoader({ source: base })
    assert.equal(before, renderLoader({ source: base }), 'render is not stable')

    appendFileSync(join(base, '.chezmoitemplates/launchagent.plist'), '<!-- changed -->\n')
    const afterTemplate = renderLoader({ source: base })
    assert.notEqual(afterTemplate, before)
    const changed = (a, b) => a.split('\n').filter((l, i) => l !== b.split('\n')[i])
    assert.deepEqual(changed(afterTemplate, before).map((l) => l.split(' ')[1]), ['launchagent.plist'])

    appendFileSync(join(base, AGENTS_DIR, 'com.rdegges.pipx.plist.tmpl'), '\n')
    const afterAgent = renderLoader({ source: base })
    assert.deepEqual(changed(afterAgent, afterTemplate).map((l) => l.split(' ')[1]), ['com.rdegges.pipx.plist.tmpl'])
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// --- Loader: behavior with a stub launchctl ----------------------------------------

// Load state lives in $STATE/loaded/<label>. A bootstrap of a label that is still
// loaded fails like the real one, so a loader that does not wait out a slow
// bootout fails. STUB_SLOW labels stay visible to `print` for 3 calls after
// bootout; STUB_STICKY labels never go away; STUB_BOOTSTRAP_FAIL labels refuse
// to load; STUB_PRINT_DOMAIN_FAIL makes `launchctl print gui/<uid>` fail.
const LAUNCHCTL =
  '#!/bin/sh\n' +
  'echo "$*" >> "$CALLS"\n' +
  'dom="gui/$(id -u)"\n' +
  'has() { case " $2 " in *" $1 "*) return 0 ;; esac; return 1; }\n' +
  'case "$1" in\n' +
  'print)\n' +
  '  if [ "$2" = "$dom" ]; then\n' +
  '    [ -n "${STUB_PRINT_DOMAIN_FAIL:-}" ] && { echo "Bad request." >&2; exit 1; }\n' +
  '    echo "$dom = {"; echo "\tservices = {"\n' +
  '    for f in "$STATE"/loaded/*; do [ -e "$f" ] && printf "\\t\\t%s\\t-\\t%s\\n" 0 "${f##*/}"; done\n' +
  '    echo "\t}"; echo "}"; exit 0\n' +
  '  fi\n' +
  '  l=${2#"$dom"/}; [ "$l" != "$2" ] || exit 64\n' +
  '  [ -e "$STATE/loaded/$l" ] || { echo "Could not find service" >&2; exit 113; }\n' +
  '  if [ -e "$STATE/linger/$l" ]; then\n' +
  '    n=$(cat "$STATE/linger/$l")\n' +
  '    if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$STATE/linger/$l"; exit 0; fi\n' +
  '    rm -f "$STATE/linger/$l" "$STATE/loaded/$l"; echo "Could not find service" >&2; exit 113\n' +
  '  fi\n' +
  '  exit 0 ;;\n' +
  'bootout)\n' +
  '  l=${2#"$dom"/}; [ "$l" != "$2" ] || exit 64\n' +
  '  [ -e "$STATE/loaded/$l" ] || { echo "Boot-out failed: 3: No such process" >&2; exit 3; }\n' +
  '  has "$l" "${STUB_STICKY:-}" && exit 0\n' +
  '  if has "$l" "${STUB_SLOW:-}"; then echo 3 > "$STATE/linger/$l"; else rm -f "$STATE/loaded/$l"; fi\n' +
  '  exit 0 ;;\n' +
  'bootstrap)\n' +
  '  [ "$2" = "$dom" ] || exit 64\n' +
  '  l=$(basename "$3" .plist)\n' +
  '  [ -f "$3" ] || { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; }\n' +
  '  has "$l" "${STUB_BOOTSTRAP_FAIL:-}" && { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; }\n' +
  '  [ -e "$STATE/loaded/$l" ] && { echo "Bootstrap failed: 5: Input/output error (still loaded)" >&2; exit 5; }\n' +
  '  touch "$STATE/loaded/$l"; exit 0 ;;\n' +
  'esac\n' +
  'exit 64\n'

const LOADER_SCRIPT = renderLoader()

function loaderSandbox({ loaded = [], plists = LABELS } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'launch-agents-run-'))
  const home = join(base, 'home dir')
  const bin = join(base, 'bin')
  const state = join(base, 'state')
  const agents = join(home, 'Library', 'LaunchAgents')
  for (const d of [bin, join(state, 'loaded'), join(state, 'linger'), agents]) mkdirSync(d, { recursive: true })
  writeFileSync(join(bin, 'launchctl'), LAUNCHCTL)
  chmodSync(join(bin, 'launchctl'), 0o755)
  for (const l of plists) writeFileSync(join(agents, `${l}.plist`), '<plist/>\n')
  for (const l of loaded) writeFileSync(join(state, 'loaded', l), '')
  const script = join(base, 'load-launch-agents.sh')
  writeFileSync(script, LOADER_SCRIPT)
  const calls = join(base, 'calls')
  writeFileSync(calls, '')
  const uid = String(process.getuid())
  return {
    home,
    agents,
    calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    loaded: () => readdirSync(join(state, 'loaded')).sort(),
    dom: `gui/${uid}`,
    run(env = {}) {
      const t0 = Date.now()
      const r = spawnSync('bash', [script], {
        encoding: 'utf8',
        env: { HOME: home, PATH: `${bin}:${SYS_PATH}`, CALLS: calls, STATE: state, ...env },
      })
      r.elapsed = (Date.now() - t0) / 1000
      return r
    },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

function withLoader(opts, fn) {
  const sb = loaderSandbox(opts)
  try {
    return fn(sb)
  } finally {
    sb.cleanup()
  }
}

// The calls that name one label, in order.
const callsFor = (sb, label) =>
  sb.calls().filter((c) => c.endsWith(`/${label}`) || c.endsWith(`/${label}.plist`)).map((c) => c.split(' ')[0])

test('loader: fresh machine: bootstraps every agent from ~/Library/LaunchAgents, exits 0, makes ~/.cron/logs', () =>
  withLoader({}, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.loaded(), LABELS)
    for (const l of LABELS) {
      assert.ok(sb.calls().includes(`bootstrap ${sb.dom} ${join(sb.agents, `${l}.plist`)}`), l)
      assert.match(r.stdout, new RegExp(`^launch-agents: loaded ${l.replace(/\./g, '\\.')}$`, 'm'))
    }
    assert.ok(existsSync(join(sb.home, '.cron', 'logs')))
  }))

test('loader: already loaded: each label is booted out, confirmed gone, then bootstrapped', () =>
  withLoader({ loaded: LABELS }, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.loaded(), LABELS)
    for (const l of LABELS) assert.deepEqual(callsFor(sb, l), ['bootout', 'print', 'bootstrap'], l)
  }))

test('loader: a slow bootout is waited out before the bootstrap', () =>
  withLoader({ loaded: LABELS }, (sb) => {
    const r = sb.run({ STUB_SLOW: 'com.rdegges.brew com.rdegges.chezmoi' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.loaded(), LABELS)
    for (const l of ['com.rdegges.brew', 'com.rdegges.chezmoi'])
      assert.deepEqual(callsFor(sb, l), ['bootout', 'print', 'print', 'print', 'print', 'bootstrap'], l)
  }))

test('loader: a label still loaded 10s after bootout is not bootstrapped and fails the run', () =>
  withLoader({ loaded: LABELS }, (sb) => {
    const r = sb.run({ STUB_STICKY: 'com.rdegges.asdf' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.ok(r.elapsed >= 9 && r.elapsed < 25, `waited ${r.elapsed}s`)
    assert.match(r.stderr, /com\.rdegges\.asdf still loaded 10s after bootout/)
    const asdf = callsFor(sb, 'com.rdegges.asdf')
    assert.equal(asdf.includes('bootstrap'), false, asdf.join(' '))
    // Every other label still gets reloaded.
    for (const l of LABELS.filter((l) => l !== 'com.rdegges.asdf')) assert.ok(callsFor(sb, l).includes('bootstrap'), l)
  }))

test('loader: one failed bootstrap still loads the rest and exits non-zero', () =>
  withLoader({}, (sb) => {
    const r = sb.run({ STUB_BOOTSTRAP_FAIL: 'com.rdegges.cf' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stderr, /ERROR: launchctl bootstrap gui\/\d+ com\.rdegges\.cf failed/)
    assert.deepEqual(sb.loaded(), LABELS.filter((l) => l !== 'com.rdegges.cf'))
  }))

test('loader: a managed plist missing from ~/Library/LaunchAgents fails the run', () =>
  withLoader({ plists: LABELS.filter((l) => l !== 'com.rdegges.rea') }, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.deepEqual(sb.loaded(), LABELS.filter((l) => l !== 'com.rdegges.rea'))
  }))

test('loader: boots out orphaned com.rdegges.* labels only, even when their plist file is still there', () =>
  withLoader({ loaded: ['com.rdegges.old-job', 'com.apple.keep', 'org.other.rdegges'], plists: [...LABELS, 'com.rdegges.old-job'] }, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(callsFor(sb, 'com.rdegges.old-job'), ['bootout', 'print'])
    assert.deepEqual(sb.loaded(), [...LABELS, 'com.apple.keep', 'org.other.rdegges'].sort())
    assert.ok(!sb.calls().some((c) => c.includes('com.apple.keep') || c.includes('org.other.rdegges')), sb.calls().join('\n'))
  }))

test('loader: an orphan that will not go away fails the run', () =>
  withLoader({ loaded: ['com.rdegges.old-job'] }, (sb) => {
    const r = sb.run({ STUB_STICKY: 'com.rdegges.old-job' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.deepEqual(sb.loaded(), [...LABELS, 'com.rdegges.old-job'].sort())
  }))

test('loader: when the domain cannot be listed, orphans are not checked and the run fails', () =>
  withLoader({}, (sb) => {
    const r = sb.run({ STUB_PRINT_DOMAIN_FAIL: '1' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stderr, /orphaned agents not checked/)
    assert.deepEqual(sb.loaded(), LABELS)
  }))

test('loader: inside com.rdegges.chezmoi it never touches that label, loads the other ten, and exits 1', () =>
  withLoader({ loaded: LABELS }, (sb) => {
    const r = sb.run({ XPC_SERVICE_NAME: 'com.rdegges.chezmoi' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.deepEqual(callsFor(sb, 'com.rdegges.chezmoi'), [])
    const others = LABELS.filter((l) => l !== 'com.rdegges.chezmoi')
    assert.equal(others.length, 10)
    for (const l of others) assert.deepEqual(callsFor(sb, l), ['bootout', 'print', 'bootstrap'], l)
    assert.deepEqual(sb.loaded(), LABELS, 'the running job was unloaded')
    assert.equal(
      r.stderr,
      "launch-agents: com.rdegges.chezmoi not reloaded from inside itself; run 'chezmoi apply' interactively\n",
    )
  }))

test('loader: an XPC_SERVICE_NAME that is not a managed label (a terminal) changes nothing', () =>
  withLoader({ loaded: LABELS }, (sb) => {
    const r = sb.run({ XPC_SERVICE_NAME: 'application.com.apple.Terminal.1234' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    for (const l of LABELS) assert.deepEqual(callsFor(sb, l), ['bootout', 'print', 'bootstrap'], l)
  }))

test('loader: A->B->A: interactive apply, then the hourly job, then interactive again', () =>
  withLoader({}, (sb) => {
    let r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    r = sb.run({ XPC_SERVICE_NAME: 'com.rdegges.chezmoi' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.deepEqual(sb.loaded(), LABELS)
    r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.equal(r.stderr, '')
    assert.deepEqual(sb.loaded(), LABELS)
  }))

// --- Retire crontab ---------------------------------------------------------------

test('retire: darwin-only after_ script that runs after the loader', () => {
  assert.equal(execTemplate(read(RETIRE), { data: JSON.stringify({ chezmoi: { os: 'linux' } }) }), '')
  assert.match(read(RETIRE), /^\{\{- if eq \.chezmoi\.os "darwin" -\}\}\n#!\/bin\/bash\n/)
  assert.match(read(RETIRE), /Delete this script once every machine shows an empty `crontab -l`\./)
  // chezmoi runs after_ scripts in target-name order.
  assert.ok('load-launch-agents.sh' < 'retire-crontab.sh')
  assert.ok(LOADER.startsWith('run_onchange_after_') && RETIRE.startsWith('run_onchange_after_'))
})

const RETIRE_SCRIPT = execTemplate(read(RETIRE), { data: DARWIN })
const MARKER_TEXT = "run 'crontab -r && rm -f ~/.cron/logs/crontab.FAILED' once to finish the launchd migration\n"

// STUB_L: what `crontab -l` does; STUB_R: what `crontab -r` does.
const CRONTAB =
  '#!/bin/sh\n' +
  'echo "crontab $*" >> "$CALLS"\n' +
  'case "$1:${STUB_L:-empty}:${STUB_R:-ok}" in\n' +
  '-l:empty:*) exit 0 ;;\n' +
  '-l:comments:*) printf "# DO NOT EDIT THIS FILE\\n\\n   # another\\n\\t\\n"; exit 0 ;;\n' +
  '-l:jobs:*) printf "SHELL=/bin/sh\\n15 * * * * { date; true; }\\n"; exit 0 ;;\n' +
  '-l:none:*) echo "crontab: no crontab for $(id -un)" >&2; exit 1 ;;\n' +
  '-l:error:*) echo "crontab: tmp/tmp.42: Operation not permitted" >&2; exit 1 ;;\n' +
  '-l:hang:*) exec sleep 600 ;;\n' +
  '-r:*:ok) exit 0 ;;\n' +
  '-r:*:fail) echo "crontab: tmp/tmp.43: Operation not permitted" >&2; exit 1 ;;\n' +
  'esac\n' +
  'exit 64\n'

function retireSandbox() {
  const base = mkdtempSync(join(tmpdir(), 'retire-crontab-'))
  const home = join(base, 'Ränd all')
  const bin = join(base, 'bin')
  mkdirSync(home)
  mkdirSync(bin)
  writeFileSync(join(bin, 'crontab'), CRONTAB)
  chmodSync(join(bin, 'crontab'), 0o755)
  const script = join(base, 'retire-crontab.sh')
  writeFileSync(script, RETIRE_SCRIPT)
  const calls = join(base, 'calls')
  writeFileSync(calls, '')
  const logs = join(home, '.cron', 'logs')
  const marker = join(logs, 'crontab.FAILED')
  return {
    home,
    logs,
    marker,
    calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    resetCalls: () => writeFileSync(calls, ''),
    seedMarker() {
      mkdirSync(logs, { recursive: true })
      writeFileSync(marker, 'old\n')
      writeFileSync(join(logs, 'cf.FAILED'), 'cf is broken\n')
    },
    run(env = {}) {
      const t0 = Date.now()
      const r = spawnSync('bash', [script], {
        encoding: 'utf8',
        env: { HOME: home, PATH: `${bin}:${SYS_PATH}`, CALLS: calls, ...env },
      })
      r.elapsed = (Date.now() - t0) / 1000
      return r
    },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

function withRetire(fn) {
  const sb = retireSandbox()
  try {
    return fn(sb)
  } finally {
    sb.cleanup()
  }
}

function assertCleared(sb, r) {
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(existsSync(sb.marker), false, 'crontab.FAILED left behind')
  // Only its own marker.
  if (existsSync(join(sb.logs, 'cf.FAILED'))) assert.equal(readFileSync(join(sb.logs, 'cf.FAILED'), 'utf8'), 'cf is broken\n')
}

function assertMarked(sb, r) {
  assert.equal(r.status, 0, 'a failed removal must not fail the apply: ' + r.stdout + r.stderr)
  assert.equal(readFileSync(sb.marker, 'utf8'), MARKER_TEXT)
}

for (const kind of ['empty', 'comments', 'none']) {
  test(`retire: \`crontab -l\` ${kind}: no removal, marker cleared, exit 0`, () =>
    withRetire((sb) => {
      sb.seedMarker()
      const r = sb.run({ STUB_L: kind })
      assertCleared(sb, r)
      assert.deepEqual(sb.calls(), ['crontab -l'])
    }))
}

for (const kind of ['jobs', 'error']) {
  test(`retire: \`crontab -l\` ${kind}: one \`crontab -r\`; success clears the marker`, () =>
    withRetire((sb) => {
      sb.seedMarker()
      const r = sb.run({ STUB_L: kind, STUB_R: 'ok' })
      assertCleared(sb, r)
      assert.deepEqual(sb.calls(), ['crontab -l', 'crontab -r'])
    }))

  test(`retire: \`crontab -l\` ${kind}: one \`crontab -r\`; failure writes the marker and exits 0`, () =>
    withRetire((sb) => {
      const r = sb.run({ STUB_L: kind, STUB_R: 'fail' })
      assertMarked(sb, r)
      assert.deepEqual(sb.calls(), ['crontab -l', 'crontab -r'])
    }))
}

test('retire: a hung `crontab -l` is killed at 30s, then `crontab -r` is tried once', () =>
  withRetire((sb) => {
    const r = sb.run({ STUB_L: 'hang', STUB_R: 'fail' })
    assert.ok(r.elapsed >= 29 && r.elapsed < 45, `took ${r.elapsed}s`)
    assertMarked(sb, r)
    assert.deepEqual(sb.calls(), ['crontab -l', 'crontab -r'])
  }))

test('retire: A->B->A: failure marks, a later empty crontab clears, a new failure marks once (replaced)', () =>
  withRetire((sb) => {
    assertMarked(sb, sb.run({ STUB_L: 'jobs', STUB_R: 'fail' }))
    assertCleared(sb, sb.run({ STUB_L: 'none' }))
    assertMarked(sb, sb.run({ STUB_L: 'jobs', STUB_R: 'fail' }))
    assertMarked(sb, sb.run({ STUB_L: 'error', STUB_R: 'fail' }))
  }))

test('retire: the marker shows in the zshrc banner, and the command it names clears it', { skip: zskip }, () =>
  withRetire((sb) => {
    sb.run({ STUB_L: 'jobs', STUB_R: 'fail' })
    const line = read('dot_zshrc')
      .split('\n')
      .find((l) => l.includes('.FAILED') && !l.trimStart().startsWith('#'))
    const banner = () => spawnSync('zsh', ['-f', '-c', line], { encoding: 'utf8', env: { HOME: sb.home, PATH: SYS_PATH } }).stdout
    assert.equal(banner(), `\x1b[31mcron: ${MARKER_TEXT.trimEnd()}\x1b[0m\n`)
    // The marker's own fix, with the stub crontab standing in for the real one.
    const fix = MARKER_TEXT.match(/^run '(.*)' once/)[1]
    const r = spawnSync('sh', ['-c', fix], { encoding: 'utf8', env: { HOME: sb.home, PATH: `${join(sb.home, '..', 'bin')}:${SYS_PATH}`, CALLS: '/dev/null', STUB_R: 'ok' } })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(banner(), '')
  }))
