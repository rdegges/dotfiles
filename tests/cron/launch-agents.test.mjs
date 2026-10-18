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
// `<`, and quotes) and passes the Codex installer's ~/.local/bin check, with
// ~/.local/bin ahead of the Homebrew prefixes. The loader's hash header covers the shared template and
// every agent. With a stub launchctl that keeps load state and refuses a
// bootstrap while a label is still loaded, the loader boots out and then
// bootstraps every agent, waits until a booted-out label is really gone, fails
// when that takes over 10s or a bootstrap fails, boots out orphaned
// com.rdegges.* labels and only those, and never touches the label in
// XPC_SERVICE_NAME (it loads the others and exits 1). A managed job that
// launchd reports as running, or whose state launchctl print cannot read, is
// neither booted out nor bootstrapped, and the run exits 1 (checked against
// stub output; the real text was confirmed by hand on launchd). With a stub
// crontab, the retire script clears crontab.FAILED when `crontab -l` is empty
// or absent, otherwise tries `crontab -r` once (also after a hung `crontab -l`
// is killed at 30s), writes the marker when that fails, and always exits 0. It says
// nothing about the real launchd, macOS bash 3.2, or TCC; those are checked by
// hand on the Mac after merge.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, chmodSync, rmSync, readdirSync, cpSync, appendFileSync, statSync, symlinkSync } from 'node:fs'
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
// macOS runs these scripts with /bin/bash 3.2. TEST_BASH=/path/to/bash-3.2 runs
// the loader and retire tests under that bash instead of the bash on PATH.
const BASH = process.env.TEST_BASH || 'bash'

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
      assert.equal(path, `${home}/.asdf/shims:${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`)
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

// `codex update` runs https://chatgpt.com/codex/install.sh. Its add_to_path()
// appends a `# >>> Codex installer >>>` block to ~/.zprofile unless
// `case ":$PATH:" in *":$BIN_DIR:"*)` matches, with BIN_DIR="$HOME/.local/bin";
// chezmoi then deletes that block on the next update. It also edits the profile
// when `command -v codex` finds a copy under /opt/homebrew or /usr/local (a
// "brew" conflict), so ~/.local/bin must come before those. This is the
// installer's check copied as of 2026-10-17, not the installer itself.
const INSTALLER_PATH_CHECK = 'case ":$PATH:" in *":$HOME/.local/bin:"*) exit 0 ;; esac; exit 1'

function agentPath(home, source = SOURCE) {
  const tmpl = readFileSync(join(source, AGENTS_DIR, 'com.rdegges.codex.plist.tmpl'), 'utf8')
  return parsePlist(execTemplate(tmpl, { source, home })).EnvironmentVariables.PATH
}

test('agents: the job PATH passes the Codex installer check, so `codex update` leaves ~/.zprofile alone', () => {
  for (const make of [() => { const b = mkdtempSync(join(tmpdir(), 'launch-agents-')); return { base: b, home: b } }, hostileHome]) {
    const { base, home } = make()
    try {
      const path = agentPath(home)
      const r = spawnSync('/bin/sh', ['-c', INSTALLER_PATH_CHECK], { encoding: 'utf8', env: { PATH: path, HOME: home } })
      assert.equal(r.status, 0, `installer would edit ~/.zprofile: HOME=${home} PATH=${path}`)

      const dirs = path.split(':')
      const local = dirs.indexOf(`${home}/.local/bin`)
      assert.ok(local >= 0, path)
      assert.ok(local < dirs.indexOf('/opt/homebrew/bin') && local < dirs.indexOf('/usr/local/bin'), `~/.local/bin is after a Homebrew prefix: ${path}`)

      // The codex in ~/.local/bin is the one `command -v codex` finds, so the
      // installer sees no conflicting install.
      mkdirSync(join(home, '.local/bin'), { recursive: true })
      writeFileSync(join(home, '.local/bin/codex'), '#!/bin/sh\n')
      chmodSync(join(home, '.local/bin/codex'), 0o755)
      const found = spawnSync('/bin/sh', ['-c', 'command -v codex'], { encoding: 'utf8', env: { PATH: path, HOME: home } })
      assert.equal(found.stdout.trim(), `${home}/.local/bin/codex`)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }
})

test('agents: the installer check fails on the old PATH without ~/.local/bin (the check is not vacuous)', () => {
  const src = mkdtempSync(join(tmpdir(), 'launch-agents-src-'))
  const home = mkdtempSync(join(tmpdir(), 'launch-agents-'))
  try {
    for (const p of ['.chezmoitemplates', AGENTS_DIR]) cpSync(join(SOURCE, p), join(src, p), { recursive: true })
    const tmpl = join(src, '.chezmoitemplates/launchagent.plist')
    const text = readFileSync(tmpl, 'utf8')
    const old = text.replace('{{ .home | html }}/.local/bin:', '')
    assert.notEqual(old, text, 'the shared template no longer has the ~/.local/bin entry this test removes')
    writeFileSync(tmpl, old)
    const path = agentPath(home, src)
    assert.equal(path, `${home}/.asdf/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`)
    const r = spawnSync('/bin/sh', ['-c', INSTALLER_PATH_CHECK], { encoding: 'utf8', env: { PATH: path, HOME: home } })
    assert.equal(r.status, 1)
  } finally {
    rmSync(src, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

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
  const r = spawnSync(BASH, ['-n'], { encoding: 'utf8', input: s })
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
// to load; STUB_BOOTSTRAP_HANG labels hang on bootstrap; STUB_DISABLED labels
// are listed under "disabled services" (as the real `launchctl print` does,
// loaded or not); STUB_PRINT_DOMAIN_FAIL makes `launchctl print gui/<uid>` fail.
// `print gui/<uid>/<label>` of a loaded label says `state = not running`, or
// `state = running` for STUB_RUNNING labels (a job that is running right now);
// for STUB_PRINT_FAIL labels it fails with an error other than "not found"
// (launchd busy or a bad request), so the job's state is unknown.
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
  '    echo "\t}"\n' +
  '    if [ -n "${STUB_DISABLED:-}" ]; then echo "\tdisabled services = {"; for d in $STUB_DISABLED; do printf "\\t\\t\\"%s\\" => disabled\\n" "$d"; done; echo "\t}"; fi\n' +
  '    echo "}"; exit 0\n' +
  '  fi\n' +
  '  l=${2#"$dom"/}; [ "$l" != "$2" ] || exit 64\n' +
  '  [ -e "$STATE/loaded/$l" ] || { echo "Could not find service" >&2; exit 113; }\n' +
  '  has "$l" "${STUB_PRINT_FAIL:-}" && { echo "Bad request." >&2; exit 1; }\n' +
  '  if has "$l" "${STUB_RUNNING:-}"; then printf "\\tstate = running\\n"; else printf "\\tstate = not running\\n"; fi\n' +
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
  '  has "$l" "${STUB_BOOTSTRAP_HANG:-}" && exec sleep 600\n' +
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
      const r = spawnSync(BASH, [script], {
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
    for (const l of LABELS) assert.deepEqual(callsFor(sb, l), ['print', 'bootout', 'print', 'bootstrap'], l)
  }))

test('loader: a slow bootout is waited out before the bootstrap', () =>
  withLoader({ loaded: LABELS }, (sb) => {
    const r = sb.run({ STUB_SLOW: 'com.rdegges.brew com.rdegges.chezmoi' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.loaded(), LABELS)
    for (const l of ['com.rdegges.brew', 'com.rdegges.chezmoi'])
      assert.deepEqual(callsFor(sb, l), ['print', 'bootout', 'print', 'print', 'print', 'print', 'bootstrap'], l)
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
    for (const l of others) assert.deepEqual(callsFor(sb, l), ['print', 'bootout', 'print', 'bootstrap'], l)
    assert.deepEqual(sb.loaded(), LABELS, 'the running job was unloaded')
    assert.equal(
      r.stderr,
      "launch-agents: com.rdegges.chezmoi not reloaded from inside itself; run 'chezmoi apply' interactively\n",
    )
  }))

test('loader: a managed job that is running now is not booted out; the other ten load and the run fails', () =>
  withLoader({ loaded: LABELS }, (sb) => {
    const r = sb.run({ STUB_RUNNING: 'com.rdegges.brew' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.deepEqual(callsFor(sb, 'com.rdegges.brew'), ['print'], 'only asked for its state')
    const others = LABELS.filter((l) => l !== 'com.rdegges.brew')
    assert.equal(others.length, 10)
    for (const l of others) assert.deepEqual(callsFor(sb, l), ['print', 'bootout', 'print', 'bootstrap'], l)
    assert.deepEqual(sb.loaded(), LABELS, 'the running job was unloaded')
    assert.match(r.stderr, /^launch-agents: com\.rdegges\.brew is running; not reloaded/m)
  }))

test('loader: a job skipped while running is reloaded by the next apply once it has finished', () =>
  withLoader({ loaded: LABELS }, (sb) => {
    let r = sb.run({ STUB_RUNNING: 'com.rdegges.codex' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.doesNotMatch(r.stdout, /loaded com\.rdegges\.codex$/m)
    const before = sb.calls().length
    r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.equal(r.stderr, '')
    assert.match(r.stdout, /^launch-agents: loaded com\.rdegges\.codex$/m)
    const second = sb.calls().slice(before).filter((c) => c.endsWith('/com.rdegges.codex') || c.endsWith('/com.rdegges.codex.plist'))
    assert.deepEqual(second.map((c) => c.split(' ')[0]), ['print', 'bootout', 'print', 'bootstrap'])
    assert.deepEqual(sb.loaded(), LABELS)
  }))

test('loader: several running jobs are each skipped and reported; orphans are still cleaned up', () =>
  withLoader({ loaded: [...LABELS, 'com.rdegges.old-job'] }, (sb) => {
    const running = ['com.rdegges.brew', 'com.rdegges.docker-prune', 'com.rdegges.vault-snapshot']
    const r = sb.run({ STUB_RUNNING: running.join(' ') })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    for (const l of running) {
      assert.deepEqual(callsFor(sb, l), ['print'], l)
      assert.match(r.stderr, new RegExp(`^launch-agents: ${l.replace(/\./g, '\\.')} is running; not reloaded`, 'm'))
    }
    for (const l of LABELS.filter((x) => !running.includes(x))) assert.deepEqual(callsFor(sb, l), ['print', 'bootout', 'print', 'bootstrap'], l)
    assert.deepEqual(callsFor(sb, 'com.rdegges.old-job'), ['bootout', 'print'])
    assert.deepEqual(sb.loaded(), LABELS)
  }))

test('loader: inside com.rdegges.chezmoi, which is running, the self rule wins: no launchctl call names it', () =>
  withLoader({ loaded: LABELS }, (sb) => {
    const r = sb.run({ XPC_SERVICE_NAME: 'com.rdegges.chezmoi', STUB_RUNNING: 'com.rdegges.chezmoi com.rdegges.rea' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.deepEqual(callsFor(sb, 'com.rdegges.chezmoi'), [])
    assert.deepEqual(callsFor(sb, 'com.rdegges.rea'), ['print'])
    assert.doesNotMatch(r.stderr, /com\.rdegges\.chezmoi is running/)
    assert.match(r.stderr, /com\.rdegges\.chezmoi not reloaded from inside itself/)
    assert.match(r.stderr, /com\.rdegges\.rea is running; not reloaded/)
    assert.deepEqual(sb.loaded(), LABELS)
  }))

test('loader: a "state = not running" job is not mistaken for a running one', () =>
  withLoader({ loaded: ['com.rdegges.pipx'] }, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(callsFor(sb, 'com.rdegges.pipx'), ['print', 'bootout', 'print', 'bootstrap'])
    assert.doesNotMatch(r.stderr, /is running/)
  }))

test('loader: a loaded job whose state cannot be read is not booted out, and the run fails', () =>
  withLoader({ loaded: LABELS }, (sb) => {
    const r = sb.run({ STUB_PRINT_FAIL: 'com.rdegges.brew' })
    assert.ok(!callsFor(sb, 'com.rdegges.brew').includes('bootout'), callsFor(sb, 'com.rdegges.brew').join(' '))
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stderr, /com\.rdegges\.brew failed \(exit 1\); not reloaded/)
  }))

// Orphans (retired com.rdegges.* jobs) get no running check: one that is mid-run
// when its plist is retired is killed by the bootout.
test.todo('PROPOSED CONTRACT: loader: a running orphan is not booted out until it finishes', () =>
  withLoader({ loaded: ['com.rdegges.old-job'] }, (sb) => {
    sb.run({ STUB_RUNNING: 'com.rdegges.old-job' })
    assert.ok(!callsFor(sb, 'com.rdegges.old-job').includes('bootout'), callsFor(sb, 'com.rdegges.old-job').join(' '))
  }))

test('loader: an XPC_SERVICE_NAME that is not a managed label (a terminal) changes nothing', () =>
  withLoader({ loaded: LABELS }, (sb) => {
    const r = sb.run({ XPC_SERVICE_NAME: 'application.com.apple.Terminal.1234' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    for (const l of LABELS) assert.deepEqual(callsFor(sb, l), ['print', 'bootout', 'print', 'bootstrap'], l)
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

// A PATH dir with only the tools the scripts and stubs need, and no
// timeout/gtimeout: a Mac without Homebrew coreutils.
function noTimeoutPath(base) {
  const tools = join(base, 'tools')
  mkdirSync(tools)
  for (const t of ['bash', 'sh', 'mkdir', 'id', 'grep', 'sort', 'sleep', 'cat', 'rm', 'touch', 'basename', 'mktemp']) {
    const r = spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' })
    assert.equal(r.status, 0, `${t} not found`)
    symlinkSync(r.stdout.trim(), join(tools, t))
  }
  return tools
}

test('loader: without timeout/gtimeout on PATH it still loads every agent unbounded and exits 0', () =>
  withLoader({ loaded: LABELS }, (sb) => {
    const tools = noTimeoutPath(join(sb.home, '..'))
    const PATH = `${join(sb.home, '..', 'bin')}:${tools}`
    assert.notEqual(spawnSync('sh', ['-c', 'command -v timeout || command -v gtimeout'], { env: { PATH } }).status, 0, 'timeout leaked onto PATH')
    const r = sb.run({ PATH, STUB_SLOW: 'com.rdegges.pipx' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.loaded(), LABELS)
    assert.deepEqual(callsFor(sb, 'com.rdegges.pipx'), ['print', 'bootout', 'print', 'print', 'print', 'print', 'bootstrap'])
  }))

test('loader: a hung bootstrap is killed at 30s; the other agents still load and the run fails', () =>
  withLoader({}, (sb) => {
    const r = sb.run({ STUB_BOOTSTRAP_HANG: 'com.rdegges.docker-prune' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.ok(r.elapsed >= 29 && r.elapsed < 45, `took ${r.elapsed}s`)
    assert.match(r.stderr, /ERROR: launchctl bootstrap gui\/\d+ com\.rdegges\.docker-prune failed/)
    assert.deepEqual(sb.loaded(), LABELS.filter((l) => l !== 'com.rdegges.docker-prune'))
  }))

test('loader: a com.rdegges.* label listed only under "disabled services" does not fail the run', () =>
  withLoader({ loaded: LABELS }, (sb) => {
    const r = sb.run({ STUB_DISABLED: 'com.rdegges.gone com.rdegges.brew' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.loaded(), LABELS)
    // A disabled managed label is still a managed label: never treated as an orphan.
    assert.doesNotMatch(r.stdout, /booting out com\.rdegges\.brew /)
  }))

// --- Retire crontab ---------------------------------------------------------------

test('retire: darwin-only after_ script that runs after the loader', () => {
  assert.equal(execTemplate(read(RETIRE), { data: JSON.stringify({ chezmoi: { os: 'linux' } }) }), '')
  assert.match(read(RETIRE), /^\{\{- if eq \.chezmoi\.os "darwin" -\}\}\n#!\/bin\/bash\n/)
  assert.match(read(RETIRE), /Delete this script once every machine shows an empty `crontab -l`\./)
  // chezmoi runs after_ scripts in target-name order (the real order is proven
  // by the `chezmoi apply` test below).
  const target = (f) => f.replace(/^run_onchange_after_/, '').replace(/\.tmpl$/, '')
  assert.ok(LOADER.startsWith('run_onchange_after_') && RETIRE.startsWith('run_onchange_after_'))
  assert.ok(target(LOADER) < target(RETIRE), `${target(LOADER)} sorts after ${target(RETIRE)}`)
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
      const r = spawnSync(BASH, [script], {
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

test('retire: without timeout/gtimeout on PATH a failed removal still writes the marker and exits 0', () =>
  withRetire((sb) => {
    const tools = noTimeoutPath(join(sb.home, '..'))
    const r = sb.run({ PATH: `${join(sb.home, '..', 'bin')}:${tools}`, STUB_L: 'jobs', STUB_R: 'fail' })
    assertMarked(sb, r)
    assert.deepEqual(sb.calls(), ['crontab -l', 'crontab -r'])
  }))

// --- Real chezmoi apply (agents, loader, retire; stub launchctl and crontab) -------

// A scratch source with only the launchd pieces, applied with .chezmoi.os forced
// to darwin so the loader and retire scripts really run, from chezmoi, against
// the stubs. Never touches the real HOME or the real launchd.
function applySandbox() {
  const base = mkdtempSync(join(tmpdir(), 'launch-agents-apply-'))
  const src = join(base, 'src')
  const home = join(base, 'home dir')
  const bin = join(base, 'bin')
  const state = join(base, 'state')
  for (const d of [src, home, bin, join(state, 'loaded'), join(state, 'linger')]) mkdirSync(d, { recursive: true })
  for (const p of ['.chezmoitemplates', AGENTS_DIR, LOADER, RETIRE]) cpSync(join(SOURCE, p), join(src, p), { recursive: true })
  writeFileSync(join(bin, 'launchctl'), LAUNCHCTL)
  writeFileSync(join(bin, 'crontab'), CRONTAB)
  chmodSync(join(bin, 'launchctl'), 0o755)
  chmodSync(join(bin, 'crontab'), 0o755)
  const cfg = join(base, 'chezmoi.toml')
  writeFileSync(cfg, '')
  const calls = join(base, 'calls')
  writeFileSync(calls, '')
  const cz = ['--source', src, '--destination', home, '--config', cfg, '--no-tty', '--override-data', DARWIN]
  return {
    src,
    home,
    agents: join(home, 'Library', 'LaunchAgents'),
    loaded: () => readdirSync(join(state, 'loaded')).sort(),
    calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    resetCalls: () => writeFileSync(calls, ''),
    apply: (env = {}) =>
      spawnSync('chezmoi', [...cz, 'apply', '--force'], {
        encoding: 'utf8',
        env: { HOME: home, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, STATE: state, STUB_L: 'jobs', STUB_R: 'ok', ...env },
      }),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

test('apply: every agent lands at the path the loader bootstraps, not group/world-writable, under a private ~/Library', () => {
  const sb = applySandbox()
  try {
    const r = sb.apply()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    // The loader hard-codes $HOME/Library/LaunchAgents/<label>.plist for every
    // label in its list; chezmoi must write exactly those files.
    const labels = LOADER_SCRIPT.match(/^labels=\(\n([\s\S]*?)\n\)$/m)[1].split('\n').map((l) => l.trim().replace(/^'|'$/g, ''))
    assert.deepEqual(readdirSync(sb.agents).sort(), labels.map((l) => `${l}.plist`).sort())
    for (const l of labels) {
      const f = join(sb.agents, `${l}.plist`)
      const st = statSync(f)
      assert.ok(st.isFile(), f)
      // launchd refuses an agent plist that group or others can write.
      assert.equal(st.mode & 0o022, 0, `${l}.plist mode ${(st.mode & 0o777).toString(8)}`)
      assert.equal(parsePlist(readFileSync(f, 'utf8')).Label, l)
    }
    assert.equal(statSync(join(sb.home, 'Library')).mode & 0o077, 0, '~/Library is not private')
    assert.deepEqual(sb.loaded(), LABELS)
  } finally {
    sb.cleanup()
  }
})

test('apply: loader then retire, in that order; a self-run failure is retried by the next apply; then neither reruns until an agent changes', () => {
  const sb = applySandbox()
  try {
    const idx = (calls, re) => calls.map((c, i) => (re.test(c) ? i : -1)).filter((i) => i >= 0)
    // Within one apply, no crontab call comes before a launchctl call.
    const assertRetireAfterLoader = (calls) => {
      const lastLaunchctl = Math.max(-1, ...idx(calls, /^(bootstrap|bootout|print) /))
      for (const i of idx(calls, /^crontab /)) assert.ok(i > lastLaunchctl, `crontab ran before the loader finished:\n${calls.join('\n')}`)
    }

    // 1. The hourly job (inside com.rdegges.chezmoi): the other ten load, apply fails.
    let r = sb.apply({ XPC_SERVICE_NAME: 'com.rdegges.chezmoi' })
    assert.notEqual(r.status, 0, 'a self-run must fail the apply so the banner shows: ' + r.stdout + r.stderr)
    assert.equal(idx(sb.calls(), /^bootstrap /).length, 10, sb.calls().join('\n'))
    assert.deepEqual(sb.loaded(), LABELS.filter((l) => l !== 'com.rdegges.chezmoi'))

    assertRetireAfterLoader(sb.calls())
    const retiredInStep1 = idx(sb.calls(), /^crontab -l$/).length

    // 2. Interactive apply: the failed loader is not recorded as done, so it runs again.
    sb.resetCalls()
    r = sb.apply()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    let calls = sb.calls()
    assert.equal(idx(calls, /^bootstrap /).length, 11, calls.join('\n'))
    assert.deepEqual(sb.loaded(), LABELS)
    // Retire ran in step 1 or here, exactly once overall, and only after the loader.
    assertRetireAfterLoader(calls)
    assert.equal(retiredInStep1 + idx(calls, /^crontab -l$/).length, 1, 'retire must run exactly once')

    // 3. Nothing changed: neither script runs.
    sb.resetCalls()
    r = sb.apply()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), [])

    // 4. One agent changes: the loader reloads everything; retire stays done.
    appendFileSync(join(sb.src, AGENTS_DIR, 'com.rdegges.pipx.plist.tmpl'), '\n')
    r = sb.apply()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    calls = sb.calls()
    assert.equal(idx(calls, /^bootstrap /).length, 11, calls.join('\n'))
    assert.deepEqual(idx(calls, /^crontab /), [])
  } finally {
    sb.cleanup()
  }
})
