// Behavior of the nightly app-update job (dot_cron/executable_app-update.sh)
// and the Downie updater run script
// (run_onchange_after_configure-homelab-updaters.sh.tmpl), which run only on the
// homelab server Mac. The gate (.chezmoiignore and the loader) and the launchd
// agent are tested in tests/cron/launch-agents.test.mjs.
//
// Run from the repo root:
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'apt-get update -qq && apt-get install -y -qq zsh >/dev/null &&
//      sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin &&
//      node --test tests/cron/'
//
// What a pass proves: against stub lsappinfo, open, plutil, ioreg, sysctl,
// docker, curl, himalaya, hostname, date (only the "+%H %w %F" call; the rest
// is the real date), and the network wait, on a PATH with only system dirs
// after them, with apps under a directory with a space, and with real
// processes for the apps, the ShipIt and herdr-core processes, and a Claude
// Code CLI (real ps, and the real `kill` builtin, so a signal reaches a real
// process and is logged by it):
//   - the hour guard and a catch-up run outside 02:00-05:59 exit 0 before any
//     probe; APP_UPDATE_ANY_HOUR=1 lifts only the hour guard; today's stamp,
//     a network that is down, each busy probe, and a probe that cannot
//     evaluate (ioreg, sysctl, date) all skip before any app is touched;
//   - each app is found by exact bundle id: lsappinfo output that names
//     another bundleID is a failure and nothing is signalled; a running
//     `claude` CLI process is never signalled, and pgrep, pkill, killall, and
//     osascript are never run;
//   - Herdr, T3 Code, Fastmail, and 1Password relaunch only when an update is
//     staged and the app runs (a staged update for an app that is not running
//     is mailed); a Squirrel update is staged only while the bundle that
//     ShipItState.plist's updateBundleURL names exists, and the plist, which
//     Squirrel never deletes, is never waited on; `open` runs only after the
//     app exited and, for Squirrel apps, after ShipIt finished, or, when the
//     wait runs out, anyway with FAILED, so the job never leaves an app it quit
//     down unless `open` fails; Herdr is opened as soon as it exits, and its
//     staged bundle, which the stub `open` applies as the app starts, must be
//     gone after the relaunch, or FAILED ("did not apply", the app left
//     running, no second "version is unchanged" line); an app that ignores
//     SIGTERM is left running and never gets SIGKILL; an app that does not
//     come back and a failed `open` each write FAILED; a herdr-core hold that
//     ends across the relaunch writes FAILED ("hold ended, sessions lost"),
//     and so does no --hc-launchd broker after it, but a broker with a new
//     PID does not; a terminal `herdr-core connect` client that the relaunch
//     ends is mailed for a reattach, and Herdr.app's own client is not; an
//     app left down stays FAILED on later nights until it runs again; no
//     herdr-core hold means no relaunch; the Herdr switch (report only) is a
//     one-line change that works; a missing or broken lib/text.sh writes the
//     marker and exits 1 before any probe;
//   - Claude Desktop is not relaunched while a claude process runs under it or
//     its session files or VM disk changed in the last hour, or when that
//     cannot be checked;
//   - Chrome, Downie, and Ghostty are never signalled: a staged Chrome, a newer
//     appcast version (attribute or element form, newest of several, dotted
//     numbers only, Ghostty from its published feed because its Info.plist has
//     none), and a feed that cannot be read are reported as such;
//   - Docker updates on Sunday or when its stamp is over 8 days old or missing,
//     not when a container runs or Docker does not answer, and a failed update
//     or a Docker that does not come back writes FAILED;
//   - the mail says "updated" only when the version changed; it goes to
//     r@rdegges.com from the himalaya account icloud (or
//     APP_UPDATE_MAIL_ACCOUNT), whole on stdin, only when something changed,
//     failed, or needs a hand, and not again for the same "relaunch by hand"
//     list; mail and marker text is printable ASCII; a mail that cannot be
//     sent writes FAILED and exits 1; the 7-day stale alert mails once; the
//     pass empties its log and the later runs of the night keep it;
//   - the run script renders only with homelab true and writes the two Sparkle
//     keys for Downie's measured bundle id, and a refused write leaves a marker
//     with the fix and does not fail the apply.
//
// What a pass does not prove: real ShipIt or Herdr installs (whether SIGTERM
// lets Squirrel install, whether ShipIt removes the update bundle in time;
// Herdr was measured once (2026-11-12, 0.1.13 to 0.1.15): the bundle is
// applied at launch, the broker restarts, hold survives. A pass does not prove
// a future Herdr keeps that behavior), real lsappinfo, ioreg, or Docker Desktop
// output beyond the shapes copied here from the homelab Mac, whether Downie's
// sandbox lets `defaults` write its keys, real launchd timing, macOS bash 3.2
// (this runs under Debian bash), or real mail delivery. Those need the
// user-present Herdr relaunch and the first night's run on the homelab Mac.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, chmodSync, rmSync, readdirSync, statSync, symlinkSync, utimesSync, copyFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('../../', import.meta.url)
const SOURCE = ROOT.pathname
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8')
const SCRIPT = new URL('dot_cron/executable_app-update.sh', ROOT).pathname
const RUN_SCRIPT = 'run_onchange_after_configure-homelab-updaters.sh.tmpl'
const SYS_PATH = '/usr/bin:/bin'
// macOS runs the job with /bin/bash 3.2. TEST_BASH=/path/to/bash-3.2 runs this
// file under that bash instead of the bash on PATH (as launch-agents.test.mjs).
const BASH = process.env.TEST_BASH || 'bash'
const which = (t) => {
  const r = spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' })
  assert.equal(r.status, 0, `${t} not found`)
  return r.stdout.trim()
}
const REAL_DATE = which('date')
const PERL = which('perl')
const TODAY = spawnSync(REAL_DATE, ['+%F'], { encoding: 'utf8' }).stdout.trim()

// The apps as measured on the homelab Mac (bundle ids from each Info.plist).
const APPS = {
  herdr: { name: 'Herdr', id: 'dev.herdr.app', bundle: 'Herdr.app', exe: 'Herdr', version: '0.1.13' },
  t3: { name: 'T3 Code', id: 'com.t3tools.t3code', bundle: 'T3 Code (Beta).app', exe: 'T3 Code (Beta)', version: '0.1.7' },
  fastmail: { name: 'Fastmail', id: 'com.fastmail.mac.Fastmail', bundle: 'Fastmail.app', exe: 'Fastmail', version: '1.9.0' },
  onepassword: { name: '1Password', id: 'com.1password.1password', bundle: '1Password.app', exe: '1Password', version: '8.12.44' },
  claude: { name: 'Claude Desktop', id: 'com.anthropic.claudefordesktop', bundle: 'Claude.app', exe: 'Claude', version: '5.1231.0' },
  chrome: { name: 'Chrome', id: 'com.google.Chrome', bundle: 'Google Chrome.app', exe: 'Google Chrome', version: '157.0.8103.52' },
  downie: { name: 'Downie', id: 'com.charliemonroe.Downie-4', bundle: 'Downie 4.app', exe: 'Downie 4', version: '4.13.3', feed: 'https://software.example.test/downie/v4/updates.xml' },
  // No SUFeedURL: the real Ghostty.app Info.plist has none, so the job uses
  // GHOSTTY_FEED.
  ghostty: { name: 'Ghostty', id: 'com.mitchellh.ghostty', bundle: 'Ghostty.app', exe: 'ghostty', version: '1.4.0' },
  docker: { name: 'Docker Desktop', id: 'com.docker.docker', bundle: 'Docker.app', exe: 'Docker', version: '4.98.0' },
}

const GHOSTTY_FEED = 'https://release.files.ghostty.org/appcast.xml'
// The shape of GHOSTTY_FEED as fetched on 2026-11-11 (element form, one item
// per line, release notes cut): the first item is a build label, not a version.
const ghosttyAppcast = (...versions) =>
  "<?xml version='1.0' encoding='utf-8'?>\n<rss xmlns:sparkle=\"http://www.andymatuschak.org/xml-namespaces/sparkle\" version=\"2.0\">\n    <channel>\n        <title>Ghostty</title>\n" +
  ['663205b5 (2024-12-20)', ...versions].map((v, i) => `    <item><title>Build ${8346 + i}</title><pubDate>Fri, 20 Dec 2024 22:38:00 +0000</pubDate><sparkle:version>${8346 + i}</sparkle:version><sparkle:shortVersionString>${v}</sparkle:shortVersionString><sparkle:minimumSystemVersion>13.0.0</sparkle:minimumSystemVersion><description>notes</description><enclosure url="https://release.files.ghostty.org/x/ghostty-macos-universal.zip" type="application/octet-stream" length="1" /></item>\n`).join('') +
  '    </channel>\n</rss>\n'

// A Sparkle appcast in the shape of Downie's real one (attribute form).
const appcast = (...versions) =>
  '<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">\n<channel>\n' +
  versions.map((v) => `    <item>\n        <title>Version ${v}</title>\n        <enclosure sparkle:shortVersionString="${v}" length="1" sparkle:version="5284" url="https://x.test/${v}.dmg"></enclosure>\n    </item>\n`).join('') +
  '</channel>\n</rss>\n'

// fakeapp <mode> <title> [helper title]: start a detached process whose ps
// args are <title>, print its PID, and append every SIGTERM it gets to
// $STATE/signals. Modes: app (exits on SIGTERM), stuck (ignores it), claude (a
// process named "claude", like the Claude Code CLI), with-claude (an app with
// a claude child), chrome:<version> (an app with a helper child whose args are
// [helper title]), with-connect (an app with a child whose args are [helper
// title] and that exits with the app, like Herdr.app's own `herdr-core
// connect`), shipit:<seconds>:<dir>:<app pid> (like the real ShipIt:
// waits until <app pid> has exited, then, <seconds> later, deletes the update
// bundle <dir> and exits; ShipItState.plist stays, as Squirrel never deletes
// it), herdrswap:<seconds>:<apps dir> (<seconds> later, moves
// Herdr.app.new.noindex over Herdr.app, as Herdr.app does at launch).
// Every PID goes to $STATE/pids for cleanup.
const FAKEAPP = String.raw`#!${PERL}
use strict; use warnings; use POSIX ();
my ($mode, $title, $helper) = @ARGV;
my $state = $ENV{STATE}; my $real = $ENV{REAL};
sub note { my ($f, $l) = @_; open(my $h, '>>', "$state/$f") or return; print $h "$l\n"; close $h }
my $CLAUDE = 'my ($t, $s) = @ARGV; open(my $p, ">>", "$s/pids"); print $p "$$\n"; close $p; $SIG{TERM} = sub { open(my $h, ">>", "$s/signals"); print $h "TERM $t\n"; close $h; exit 0 }; sleep 1 while 1';
my $pid = fork() // die "fork: $!";
if ($pid) { print "$pid\n"; exit 0 }
POSIX::setsid();
open(STDIN, '<', '/dev/null'); open(STDOUT, '>', '/dev/null'); open(STDERR, '>', '/dev/null');
note('pids', $$);
if ($mode eq 'claude') { exec { "$real/claude" } 'claude', '-e', $CLAUDE, $title, $state; die }
if ($mode eq 'with-claude') { my $c = fork() // die; if ($c == 0) { exec { "$real/claude" } 'claude', '-e', $CLAUDE, 'claude child', $state; die } }
if ($mode =~ /^chrome:/) { my $c = fork() // die; if ($c == 0) { note('pids', $$); $0 = $helper; sleep 1 while 1 } }
if ($mode eq 'with-connect') { my $app = $$; my $c = fork() // die; if ($c == 0) { note('pids', $$); $0 = $helper; select(undef, undef, undef, 0.2) while getppid() == $app; exit 0 } }
$0 = $title;
my $stuck = $mode eq 'stuck';
$SIG{TERM} = sub { note('signals', "TERM $title"); exit 0 unless $stuck };
sub wait_exit { my $app = shift; while (1) { my $st = qx(ps -o stat= -p $app 2>/dev/null); last if $? != 0 || $st =~ /^\s*(Z|$)/; select(undef, undef, undef, 0.2) } }
if ($mode =~ /^shipit:(\d+):(.*):(\d+)$/) {
  my ($n, $d, $app) = ($1, $2, $3);
  wait_exit($app); sleep $n; system('rm', '-rf', $d); exit 0
}
if ($mode =~ /^herdrswap:(\d+):(.*)$/) {
  my ($n, $apps) = ($1, $2);
  sleep $n;
  system('rm', '-rf', "$apps/Herdr.app"); rename("$apps/Herdr.app.new.noindex", "$apps/Herdr.app"); unlink("$apps/Herdr.app.new.json.noindex"); exit 0
}
sleep 1 while 1;
`

const LOG = 'echo "$(basename "$0") $*" >> "$CALLS"\n'
const STUBS = {
  // Like the real one on macOS 27: with -only, unused fields print [ NULL ];
  // an app that is not running prints nothing and exits 0.
  lsappinfo:
    '#!/bin/sh\n' + LOG +
    '[ -n "${STUB_LSAPPINFO_FAIL:-}" ] && { echo "lsappinfo: cannot reach launchservicesd" >&2; exit 1; }\n' +
    'id=; while [ $# -gt 0 ]; do [ "$1" = -app ] && id=$2; shift; done\n' +
    '[ -f "$STATE/apps/$id" ] || exit 0\n' +
    'p=$(cat "$STATE/apps/$id"); s=$(ps -o stat= -p "$p" 2>/dev/null) || exit 0\n' +
    'case "$s" in "" | Z*) exit 0 ;; esac\n' +
    'printf \'[ NULL ]  ASN:0x0-0x11c11c: \\n    bundleID="%s"\\n    bundle path=[ NULL ] \\n    executable path=[ NULL ] \\n    pid = %s !cgsConnection !signalled type=[ NULL ]  flavor=[ NULL ]  Version=[ NULL ]  Arch=!!none \\n\\n\' "${STUB_LSAPPINFO_BUNDLEID:-$id}" "$p"\n',
  open:
    '#!/bin/sh\n' + LOG +
    'id=$3\n' +
    'procs=$(ps -A -o args=)\n' +
    'if { [ -f "$STATE/upd/$id" ] && [ -e "$(cat "$STATE/upd/$id")" ]; } || printf "%s\\n" "$procs" | grep -F -q -- "/ShipIt $id.ShipIt"; then echo "$id" >> "$STATE/early"; fi\n' +
    'case " ${STUB_OPEN_FAIL:-} " in *" $id "*) echo "LSOpenURLsWithRole() failed with error -10814" >&2; exit 1 ;; esac\n' +
    'if [ -f "$STATE/update/$id" ]; then sed -i "s/^CFBundleShortVersionString=.*/CFBundleShortVersionString=$(cat "$STATE/update/$id")/" "$(cat "$STATE/plist/$id")"; fi\n' +
    // Herdr, as measured: the launch applies a staged bundle (1s later, in
    // the background). STUB_HERDR_RESTART=server restarts the --hc-launchd
    // broker (what the real launch does), hold restarts the holder, nobroker
    // ends the broker and starts none. STUB_HERDR_DETACH=1 ends the terminal
    // `herdr-core connect` client.
    'if [ "$id" = dev.herdr.app ]; then\n' +
    '  [ -e "$STATE/herdr-swap" ] && "$REAL/fakeapp" "herdrswap:1:$APP_UPDATE_APPS" "herdr swapper" > /dev/null\n' +
    '  case "${STUB_HERDR_RESTART:-}" in\n' +
    '  hold) kill "$(cat "$STATE/herdr-hold")"; "$REAL/fakeapp" app "$HOME/.local/bin/herdr-core hold --socket /tmp/holder-2.sock" > "$STATE/herdr-hold" ;;\n' +
    '  server) kill "$(cat "$STATE/herdr-server")"; "$REAL/fakeapp" app "$HOME/.local/bin/herdr-core --hc-launchd /tmp/hc-ready-2" > "$STATE/herdr-server" ;;\n' +
    '  nobroker) kill "$(cat "$STATE/herdr-server")" ;;\n' +
    '  esac\n' +
    '  [ -n "${STUB_HERDR_DETACH:-}" ] && kill "$(cat "$STATE/herdr-client")"\n' +
    'fi\n' +
    'case " ${STUB_NOAPP:-} " in *" $id "*) exit 0 ;; esac\n' +
    '"$REAL/fakeapp" app "$(cat "$STATE/title/$id")" > "$STATE/apps/$id"\n' +
    // STUB_HERDR_DIES=<seconds>: the new Herdr.app exits that long after it started.
    'if [ "$id" = dev.herdr.app ] && [ -n "${STUB_HERDR_DIES:-}" ]; then p=$(cat "$STATE/apps/$id"); (sleep "$STUB_HERDR_DIES"; kill "$p") > /dev/null 2>&1 & fi\n',
  // plutil -extract <key> raw -o - <file>; the fake Info.plist holds key=value lines.
  plutil:
    '#!/bin/sh\n' + LOG +
    'v=$(sed -n "s/^$2=//p" "$6" 2>/dev/null)\n' +
    '[ -n "$v" ] || { echo "$6: Could not extract value, error: No value at that key path or invalid key path: $2" >&2; exit 1; }\n' +
    'printf "%s\\n" "$v"\n',
  ioreg:
    '#!/bin/sh\n' + LOG +
    '[ -n "${STUB_IOREG_FAIL:-}" ] && exit 1\n' +
    'if [ -n "${STUB_IOREG_RAW+x}" ]; then printf "%s\\n" "$STUB_IOREG_RAW"; exit 0; fi\n' +
    'printf \'+-o IOHIDSystem  <class IOHIDSystem>\\n    | |   {\\n    | |     "HIDIdleTime" = %s\\n    | |   }\\n\' "${STUB_IDLE_NS:-7200000000000}"\n',
  sysctl:
    '#!/bin/sh\n' + LOG +
    '[ -n "${STUB_SYSCTL_FAIL:-}" ] && { echo "sysctl: unknown oid vm.loadavg" >&2; exit 1; }\n' +
    'if [ -n "${STUB_SYSCTL_RAW+x}" ]; then printf "%s\\n" "$STUB_SYSCTL_RAW"; exit 0; fi\n' +
    'printf "{ 0.50 %s 0.80 }\\n" "${STUB_LOAD5:-1.00}"\n',
  docker:
    '#!/bin/sh\n' + LOG +
    'case "$*" in\n' +
    'info) if [ -n "${STUB_DOCKER_DOWN:-}" ] || [ -e "$STATE/docker-dead" ]; then echo "Cannot connect to the Docker daemon" >&2; exit 1; fi; echo "Server Version: 29.9.2"; exit 0 ;;\n' +
    '"ps -q") [ -n "${STUB_DOCKER_PS_FAIL:-}" ] && { echo "error during connect" >&2; exit 1; }; [ -n "${STUB_DOCKER_PS:-}" ] && printf "%s\\n" $STUB_DOCKER_PS; exit 0 ;;\n' +
    '"desktop update --quiet")\n' +
    '  [ -n "${STUB_DOCKER_NEVER_BACK:-}" ] && touch "$STATE/docker-dead"\n' +
    '  if [ "${STUB_DOCKER_UPDATE_RC:-0}" != 0 ]; then echo "update failed: download error" >&2; exit "$STUB_DOCKER_UPDATE_RC"; fi\n' +
    '  if [ -f "$STATE/update/com.docker.docker" ]; then sed -i "s/^CFBundleShortVersionString=.*/CFBundleShortVersionString=$(cat "$STATE/update/com.docker.docker")/" "$(cat "$STATE/plist/com.docker.docker")"; fi\n' +
    '  exit 0 ;;\n' +
    'esac\nexit 64\n',
  curl:
    '#!/bin/sh\n' + LOG +
    'for a; do url=$a; done\n' +
    '[ -n "${STUB_CURL_FAIL:-}" ] && { echo "curl: (6) Could not resolve host: software.example.test" >&2; exit 6; }\n' +
    'f="$STATE/feeds/$(printf "%s" "$url" | tr -c "A-Za-z0-9" _)"\n' +
    '[ -f "$f" ] || { echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; }\n' +
    'cat "$f"\n',
  // Like the real himalaya 1.2.0 `message send`: the message comes from stdin
  // (an argument is ignored), an empty stdin panics (exit 101), and an
  // account it does not know fails. Each sent message lands in $STATE/mail.<n>.
  himalaya:
    '#!/bin/sh\necho "himalaya $1 $2 $3 $4 ($# args)" >> "$CALLS"\n' +
    'cat > "$STATE/stdin.tmp"\n' +
    'if [ ! -s "$STATE/stdin.tmp" ]; then printf "The application panicked (crashed).\\nMessage:  index out of bounds: the len is 0 but the index is 0\\n" >&2; exit 101; fi\n' +
    '[ "$4" = icloud ] || { echo "Error: cannot find account $4" >&2; exit 1; }\n' +
    'if [ "${STUB_MAIL_RC:-0}" != 0 ]; then echo "cannot send message: smtp connection refused" >&2; exit "$STUB_MAIL_RC"; fi\n' +
    'n=$(ls "$STATE" | grep -c "^mail\\.")\nmv "$STATE/stdin.tmp" "$STATE/mail.$((n + 1))"\n',
  hostname: '#!/bin/sh\necho testhost\n',
  date: `#!/bin/sh\nif [ "$*" = "+%H %w %F" ] && [ -n "\${STUB_NOW+x}" ]; then printf '%s\\n' "$STUB_NOW"; exit 0; fi\nexec ${REAL_DATE} "$@"\n`,
  net: '#!/bin/sh\necho "net" >> "$CALLS"\nexit "${STUB_NET_RC:-0}"\n',
}
// The job must never find or signal a process by name, or use Apple Events.
for (const t of ['pgrep', 'pkill', 'killall', 'osascript']) STUBS[t] = '#!/bin/sh\necho "FORBIDDEN $(basename "$0") $*" >> "$CALLS"\nexit 2\n'

const DAY = 86400
const CLAUDE_PATHS = ['claude-code-sessions/s1/state.json', 'local-agent-mode-sessions/s2/state.json', 'vm_bundles/claudevm.bundle/rootfs.img']
const ago = (file, seconds) => {
  const t = Date.now() / 1000 - seconds
  utimesSync(file, t, t)
}

function sandbox({ installed = Object.keys(APPS) } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'app-update-'))
  const home = join(base, 'home')
  const bin = join(base, 'bin')
  const state = join(base, 'state')
  const real = join(base, 'real')
  const apps = join(base, 'Apps dir')
  for (const d of [home, bin, real, apps, ...['apps', 'title', 'plist', 'update', 'upd', 'feeds'].map((s) => join(state, s))]) mkdirSync(d, { recursive: true })
  for (const [n, s] of Object.entries(STUBS)) {
    writeFileSync(join(bin, n), s)
    chmodSync(join(bin, n), 0o755)
  }
  writeFileSync(join(real, 'fakeapp'), FAKEAPP)
  chmodSync(join(real, 'fakeapp'), 0o755)
  symlinkSync(PERL, join(real, 'claude'))
  const logs = join(home, '.cron', 'logs')
  mkdirSync(logs, { recursive: true })

  const plistOf = (k) => join(apps, APPS[k].bundle, 'Contents', 'Info.plist')
  const writePlist = (file, a, version = a.version) => {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, `CFBundleIdentifier=${a.id}\nCFBundleShortVersionString=${version}\n${a.feed ? `SUFeedURL=${a.feed}\n` : ''}`)
  }
  const feedFile = (url) => join(state, 'feeds', url.replace(/[^A-Za-z0-9]/g, '_'))
  for (const k of installed) {
    const a = APPS[k]
    writePlist(plistOf(k), a)
    writeFileSync(join(state, 'plist', a.id), plistOf(k))
    writeFileSync(join(state, 'title', a.id), join(apps, a.bundle, 'Contents', 'MacOS', a.exe))
    if (a.feed) writeFileSync(feedFile(a.feed), appcast(a.version))
    if (k === 'ghostty') writeFileSync(feedFile(GHOSTTY_FEED), ghosttyAppcast('1.3.1', a.version))
  }
  // A pass ran yesterday, and Docker updated 2 days ago: not stale, not due.
  const stamp = join(logs, 'app-update.ok')
  const dstamp = join(logs, 'app-update-docker.ok')
  writeFileSync(stamp, '')
  ago(stamp, DAY)
  writeFileSync(dstamp, '')
  ago(dstamp, 2 * DAY)
  const calls = join(base, 'calls')
  writeFileSync(calls, '')
  const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : [])
  const fake = (mode, title, helper) => {
    const args = [join(real, 'fakeapp'), mode, title]
    if (helper) args.push(helper)
    const r = spawnSync(PERL, args, { encoding: 'utf8', env: { STATE: state, REAL: real } })
    assert.equal(r.status, 0, r.stderr)
    return Number(r.stdout.trim())
  }
  const shipitState = (k) => join(home, 'Library', 'Caches', `${APPS[k].id}.ShipIt`, 'ShipItState.plist')
  const updateBundle = (k) => join(home, 'Library', 'Caches', `${APPS[k].id}.ShipIt`, 'update.Ab C1', APPS[k].bundle)

  const sb = {
    base, home, bin, logs, apps, stamp, dstamp,
    marker: join(logs, 'app-update.FAILED'),
    plistOf,
    shipitState,
    // start <app> [mode]: the app runs; returns its PID.
    start(k, mode = 'app') {
      const a = APPS[k]
      const title = readFileSync(join(state, 'title', a.id), 'utf8')
      const helper = mode.startsWith('chrome:')
        ? join(apps, a.bundle, `Contents/Frameworks/Google Chrome Framework.framework/Versions/${mode.slice(7)}/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=renderer`)
        : mode === 'with-connect' ? `${home}/.local/bin/herdr-core connect` : undefined
      const pid = fake(mode, title, helper)
      writeFileSync(join(state, 'apps', a.id), String(pid))
      return pid
    },
    // stage <app> [new version] [{ swap }]: an update waits. Squirrel apps get
    // a ShipItState.plist whose updateBundleURL names an update bundle (in a
    // directory with a space, so the URL holds %20), and that bundle. Herdr
    // gets Herdr.app.new.noindex with that version, which the next `open`
    // moves into place unless swap is false. A Squirrel app's new version
    // lands at the next `open`.
    stage(k, version, { swap = true } = {}) {
      const a = APPS[k]
      if (k === 'herdr') {
        writePlist(join(apps, 'Herdr.app.new.noindex', 'Contents', 'Info.plist'), a, version ?? '0.1.15')
        writeFileSync(join(apps, 'Herdr.app.new.json.noindex'), `{"version":"${version ?? '0.1.15'}"}`)
        if (swap) writeFileSync(join(state, 'herdr-swap'), '')
        return
      }
      const upd = updateBundle(k)
      mkdirSync(join(upd, 'Contents'), { recursive: true })
      mkdirSync(join(shipitState(k), '..'), { recursive: true })
      writeFileSync(shipitState(k), `bundleIdentifier=${a.id}\nupdateBundleURL=file://${upd.replace(/ /g, '%20')}/\n`)
      writeFileSync(join(state, 'upd', a.id), upd)
      if (version) writeFileSync(join(state, 'update', a.id), version)
    },
    updateBundle: (k) => updateBundle(k),
    // shipit <app> <seconds>: a ShipIt for that app, with the real command
    // line shape, that waits for the running app to exit, then deletes the
    // update bundle and exits after <seconds>. Start the app first.
    shipit(k, seconds) {
      const a = APPS[k]
      const app = existsSync(join(state, 'apps', a.id)) ? readFileSync(join(state, 'apps', a.id), 'utf8').trim() : '999999'
      return fake(`shipit:${seconds}:${join(updateBundle(k), '..')}:${app}`, `${join(apps, a.bundle)}/Contents/Frameworks/Squirrel.framework/Resources/ShipIt ${a.id}.ShipIt ${shipitState(k)}`)
    },
    // The herdr-core broker (--hc-launchd) and holder: their own session
    // leaders, outside Herdr.app's process group, as measured. The holder
    // owns the agent shells.
    herdrCore({ hold: withHold = true } = {}) {
      const server = fake('app', `${home}/.local/bin/herdr-core --hc-launchd /tmp/hc-launchd-1/ready`)
      writeFileSync(join(state, 'herdr-server'), String(server))
      if (!withHold) return { server }
      const hold = fake('app', `${home}/.local/bin/herdr-core hold --socket ${home}/.local/state/herdr-core/default/default.holder.1.sock`)
      writeFileSync(join(state, 'herdr-hold'), String(hold))
      return { server, hold }
    },
    // herdrClient(): a `herdr-core connect` client in a terminal (its parent
    // is not Herdr.app).
    herdrClient() {
      const client = fake('app', `${home}/.local/bin/herdr-core connect`)
      writeFileSync(join(state, 'herdr-client'), String(client))
      return client
    },
    // claudeFiles([recent]): Claude Desktop's session dirs and VM disk, all
    // last changed 2 hours ago, except <recent> (a path under them), changed now.
    claudeFiles(recent) {
      const sup = join(home, 'Library/Application Support/Claude')
      for (const p of CLAUDE_PATHS) {
        mkdirSync(join(sup, p, '..'), { recursive: true })
        if (!existsSync(join(sup, p))) writeFileSync(join(sup, p), '')
      }
      const age = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) age(join(d, e.name))
          ago(join(d, e.name), 2 * 3600)
        }
      }
      age(sup)
      ago(sup, 2 * 3600)
      if (recent) writeFileSync(join(sup, recent), 'x')
    },
    // claudeCli(): a Claude Code CLI session outside Claude Desktop.
    claudeCli: () => fake('claude', 'claude cli'),
    feed(k, xml) { writeFileSync(feedFile(APPS[k].feed ?? (k === 'ghostty' ? GHOSTTY_FEED : undefined)), xml) },
    setVersion(k, v) { writePlist(plistOf(k), APPS[k], v) },
    calls: () => lines(calls),
    signals: () => lines(join(state, 'signals')),
    early: () => lines(join(state, 'early')),
    mails: () =>
      readdirSync(state)
        .filter((f) => f.startsWith('mail.'))
        .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
        .map((f) => readFileSync(join(state, f), 'utf8')),
    pidOf: (k) => Number(readFileSync(join(state, 'apps', APPS[k].id), 'utf8')),
    run(env = {}, { hour = '03', weekday = 3, script = SCRIPT } = {}) {
      const t0 = Date.now()
      const r = spawnSync(BASH, [script], {
        encoding: 'utf8',
        // Built from scratch so the host's APP_UPDATE_* never leak in.
        env: {
          HOME: home, PATH: `${bin}:${SYS_PATH}`, CALLS: calls, STATE: state, REAL: real,
          APP_UPDATE_APPS: apps, APP_UPDATE_WAIT: '3', WAIT_FOR_NETWORK: join(bin, 'net'),
          STUB_NOW: `${hour} ${weekday} ${TODAY}`, ...env,
        },
      })
      r.elapsed = (Date.now() - t0) / 1000
      return r
    },
    cleanup() {
      for (const p of lines(join(state, 'pids'))) {
        try { process.kill(Number(p), 'SIGKILL') } catch {}
      }
      rmSync(base, { recursive: true, force: true })
    },
  }
  return sb
}

function withSandbox(opts, fn) {
  const sb = sandbox(opts)
  try {
    return fn(sb)
  } finally {
    sb.cleanup()
  }
}

const alive = (pid) => {
  const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
  return r.status === 0 && r.stdout.trim() !== '' && !r.stdout.trim().startsWith('Z')
}
const subject = (mail) => mail.match(/^Subject: (.*)$/m)[1]
const called = (sb, tool) => sb.calls().filter((c) => c.startsWith(`${tool} `) || c === tool)
const opens = (sb) => called(sb, 'open').map((c) => c.split(' ').pop())

// Nothing past the gate ran: no app was looked up, signalled, opened, or updated.
function assertNoAction(sb) {
  assert.deepEqual(called(sb, 'lsappinfo'), [])
  assert.deepEqual(called(sb, 'open'), [])
  assert.deepEqual(sb.signals(), [])
  assert.ok(!sb.calls().some((c) => c.startsWith('docker desktop')), sb.calls().join('\n'))
}

function assertForbiddenUnused(sb) {
  assert.deepEqual(sb.calls().filter((c) => c.startsWith('FORBIDDEN')), [])
}

function assertMarker(sb, re) {
  const m = readFileSync(sb.marker, 'utf8')
  assert.match(m, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} app-update: .* \(see ~\/\.cron\/logs\/app-update\.log\)\n$/)
  assert.equal(m.split('\n').length, 2, `marker is not one line: ${JSON.stringify(m)}`)
  assert.match(m, re)
  return m
}

const stampIsToday = (sb) => spawnSync(REAL_DATE, ['-r', sb.stamp, '+%F'], { encoding: 'utf8' }).stdout.trim() === TODAY

// --- Gate ------------------------------------------------------------------------

for (const hour of ['01', '06', '09', '14', '23']) {
  test(`gate: hour ${hour} (also a launchd catch-up after a wake) is outside the window: exit 0, no probe`, () =>
    withSandbox({}, (sb) => {
      const r = sb.run({}, { hour })
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.match(r.stdout, new RegExp(`skipped: outside window \\(local hour ${hour};`))
      assert.deepEqual(called(sb, 'ioreg'), [])
      assert.deepEqual(called(sb, 'net'), [])
      assertNoAction(sb)
      assert.deepEqual(sb.mails(), [])
      assert.equal(existsSync(sb.marker), false)
    }))
}

for (const hour of ['02', '03', '04', '05']) {
  test(`gate: hour ${hour} is inside the window: the pass runs`, () =>
    withSandbox({}, (sb) => {
      const r = sb.run({}, { hour })
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.match(r.stdout, /gate passed/)
      assert.ok(stampIsToday(sb))
    }))
}

test('gate: APP_UPDATE_ANY_HOUR=1 lifts only the hour guard; the busy probes still skip', () =>
  withSandbox({}, (sb) => {
    let r = sb.run({ APP_UPDATE_ANY_HOUR: '1' }, { hour: '14' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /gate passed/)
    writeFileSync(sb.stamp, '')
    ago(sb.stamp, DAY)
    r = sb.run({ APP_UPDATE_ANY_HOUR: '1', STUB_IDLE_NS: String(60e9) }, { hour: '14' })
    assert.match(r.stdout, /skipped: busy: keyboard or mouse used 1 min ago/)
    r = sb.run({ APP_UPDATE_ANY_HOUR: 'yes' }, { hour: '14' })
    assert.match(r.stdout, /outside window/, 'only the value 1 lifts the guard')
  }))

test('gate: a stamp from today skips the run (the later runs of the night); yesterday runs', () =>
  withSandbox({}, (sb) => {
    writeFileSync(sb.stamp, '')
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, new RegExp(`already ran today \\(${TODAY}\\)`))
    assert.deepEqual(called(sb, 'ioreg'), [])
    assertNoAction(sb)
  }))

test('gate: stateful across nights: pass, same night skips, next night passes again (A->B->A)', () =>
  withSandbox({}, (sb) => {
    sb.start('t3')
    sb.stage('t3', '0.1.8')
    sb.shipit('t3', 1)
    let r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.equal(sb.mails().length, 1)
    r = sb.run({}, { hour: '04' })
    assert.match(r.stdout, /already ran today/)
    ago(sb.stamp, DAY)
    sb.stage('t3', '0.1.9')
    sb.shipit('t3', 1)
    r = sb.run({}, { hour: '02' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.mails().map((m) => m.match(/T3 Code updated and relaunched, (\S+ -> \S+)/)[1]), ['0.1.7 -> 0.1.8', '0.1.8 -> 0.1.9'])
  }))

test('gate: network down (wait-for-network exits 1): skipped before any probe', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({ STUB_NET_RC: '1' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /skipped: network not up/)
    assert.deepEqual(called(sb, 'ioreg'), [])
    assertNoAction(sb)
  }))

test('gate: the network helper missing or unable to check (exit 2) runs the job as before', () =>
  withSandbox({}, (sb) => {
    assert.match(sb.run({ STUB_NET_RC: '2' }).stdout, /gate passed/)
    ago(sb.stamp, DAY)
    assert.match(sb.run({ WAIT_FOR_NETWORK: join(sb.base, 'missing') }).stdout, /gate passed/)
  }))

for (const rel of ['.claude/projects', '.codex/sessions']) {
  test(`busy: a file under ~/${rel} changed in the last 20 min skips; one 25 min old does not`, () =>
    withSandbox({}, (sb) => {
      const dir = join(sb.home, rel, 'proj')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'session.jsonl'), '{}\n')
      let r = sb.run()
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.match(r.stdout, new RegExp(`skipped: busy: an agent session under ~/${rel.replace('.', '\\.')} changed in the last 20 min`))
      assertNoAction(sb)
      ago(join(dir, 'session.jsonl'), 25 * 60)
      r = sb.run()
      assert.match(r.stdout, /gate passed/)
    }))
}

test('busy: no ~/.claude/projects and no ~/.codex/sessions (the agent never ran) is not busy', () =>
  withSandbox({}, (sb) => {
    assert.equal(existsSync(join(sb.home, '.codex')), false)
    assert.match(sb.run().stdout, /gate passed/)
  }))

test('busy: keyboard or mouse used 29 min ago skips; 31 min ago passes', () =>
  withSandbox({}, (sb) => {
    let r = sb.run({ STUB_IDLE_NS: String(29 * 60e9) })
    assert.match(r.stdout, /skipped: busy: keyboard or mouse used 29 min ago \(under 30\)/)
    assertNoAction(sb)
    r = sb.run({ STUB_IDLE_NS: String(31 * 60e9) })
    assert.match(r.stdout, /gate passed/)
  }))

test('busy: a 5-minute load average of 4.5 skips; 4 and 3.9 pass', () =>
  withSandbox({}, (sb) => {
    let r = sb.run({ STUB_LOAD5: '4.50' })
    assert.match(r.stdout, /skipped: busy: 5-minute load average is 4\.50 \(over 4\)/)
    assertNoAction(sb)
    r = sb.run({ STUB_LOAD5: '4.00' })
    assert.match(r.stdout, /gate passed/)
    ago(sb.stamp, DAY)
    r = sb.run({ STUB_LOAD5: '3.90' })
    assert.match(r.stdout, /gate passed/)
  }))

for (const [name, env, re] of [
  ['ioreg fails', { STUB_IOREG_FAIL: '1' }, /cannot read HIDIdleTime from ioreg \(exit 1\)/],
  ['ioreg prints no HIDIdleTime', { STUB_IOREG_RAW: '+-o IOHIDSystem  <class IOHIDSystem>' }, /cannot read HIDIdleTime/],
  ['ioreg prints a non-number', { STUB_IOREG_RAW: '    | |     "HIDIdleTime" = <00>' }, /cannot read HIDIdleTime/],
  ['sysctl fails', { STUB_SYSCTL_FAIL: '1' }, /cannot read the load average from sysctl \(exit 1\)/],
  ['sysctl prints something else', { STUB_SYSCTL_RAW: 'vm.loadavg: 1.0 2.0 3.0' }, /cannot read the load average/],
  ['date prints something else', { STUB_NOW: 'garbage' }, /cannot read the local time/],
]) {
  test(`cannot evaluate: ${name}: counts as busy, so the run skips`, () =>
    withSandbox({}, (sb) => {
      const r = sb.run(env)
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.match(r.stdout, re)
      assert.match(r.stdout, /skipped: /)
      assertNoAction(sb)
      assert.equal(stampIsToday(sb), false)
    }))
}

// --- Stale alert -----------------------------------------------------------------

test('stale: no pass in 7 days: a skip writes the marker and mails once; later skips stay quiet', () =>
  withSandbox({}, (sb) => {
    ago(sb.stamp, 8 * DAY)
    let r = sb.run({ STUB_LOAD5: '9.00' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assertMarker(sb, /no completed pass in the last 7 days; the last skip was: busy: 5-minute load average is 9\.00/)
    const m = sb.mails()
    assert.equal(m.length, 1)
    assert.equal(subject(m[0]), 'App updates stalled on testhost')
    r = sb.run({}, { hour: '14' })
    assert.equal(r.status, 0)
    assert.equal(sb.mails().length, 1)
    // A completed pass clears it.
    r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.equal(existsSync(sb.marker), false)
  }))

test('stale: a catch-up run outside the window with no stamp at all (fresh install) alerts too', () =>
  withSandbox({}, (sb) => {
    rmSync(sb.stamp)
    const r = sb.run({}, { hour: '09' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assertMarker(sb, /no completed pass in the last 7 days; the last skip was: outside window/)
    assert.equal(sb.mails().length, 1)
  }))

test('stale: a pass 6 days ago is not stale', () =>
  withSandbox({}, (sb) => {
    ago(sb.stamp, 6 * DAY)
    sb.run({ STUB_LOAD5: '9.00' })
    assert.equal(existsSync(sb.marker), false)
    assert.deepEqual(sb.mails(), [])
  }))

test('stale: the alert mail fails (APP_UPDATE_MAIL_ACCOUNT names no account): the marker says so, exit 1', () =>
  withSandbox({}, (sb) => {
    rmSync(sb.stamp)
    const r = sb.run({ APP_UPDATE_MAIL_ACCOUNT: 'no-such-account', STUB_IDLE_NS: '0' }, { hour: '14' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assertMarker(sb, /no completed pass in the last 7 days.*; the alert mail failed too/)
    assert.match(r.stdout, /mail failed: Error: cannot find account no-such-account/)
    assert.deepEqual(called(sb, 'himalaya'), ['himalaya message send -a no-such-account (4 args)'])
  }))

// --- No-op night -----------------------------------------------------------------

test('no-op night: nothing staged, everything current: no signal, no open, no mail, stamp touched, old marker removed', () =>
  withSandbox({}, (sb) => {
    for (const k of ['herdr', 't3', 'fastmail', 'onepassword', 'claude', 'downie', 'ghostty']) sb.start(k)
    sb.start('chrome', `chrome:${APPS.chrome.version}`)
    writeFileSync(sb.marker, 'old\n')
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.signals(), [])
    assert.deepEqual(called(sb, 'open'), [])
    assert.deepEqual(called(sb, 'himalaya'), [])
    assert.ok(stampIsToday(sb))
    assert.equal(existsSync(sb.marker), false)
    assert.match(r.stdout, /nothing to report; no mail/)
    // Ghostty has no SUFeedURL (as on the real Mac): its published feed is
    // checked instead, and the build label in it is not taken for a version.
    assert.match(r.stdout, /Ghostty: no SUFeedURL in its Info\.plist; using https:\/\/release\.files\.ghostty\.org\/appcast\.xml/)
    assert.match(r.stdout, /Ghostty: up to date \(1\.4\.0; newest in the appcast: 1\.4\.0\)/)
    assert.doesNotMatch(r.stdout, /warning:/)
    assertForbiddenUnused(sb)
  }))

test('no-op night: apps that are not installed are skipped quietly', () =>
  withSandbox({ installed: [] }, (sb) => {
    const r = sb.run({}, { weekday: 0 })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /Herdr: not installed/)
    assert.match(r.stdout, /Docker Desktop: not installed/)
    assert.deepEqual(sb.mails(), [])
    assert.deepEqual(called(sb, 'docker'), [])
  }))

// --- Herdr -----------------------------------------------------------------------

const HOLD_ARGS = (sb) => `${sb.home}/.local/bin/herdr-core hold --socket ${sb.home}/.local/state/herdr-core/default/default.holder.1.sock`

test('Herdr staged: SIGTERM to Herdr.app only, relaunched, 0.1.13 -> 0.1.15, hold unchanged; Herdr.app\'s own client and an attached terminal client are not mailed', () =>
  withSandbox({}, (sb) => {
    const { server, hold } = sb.herdrCore()
    const client = sb.herdrClient()
    const old = sb.start('herdr', 'with-connect')
    sb.stage('herdr')
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.signals(), [`TERM ${join(sb.apps, 'Herdr.app/Contents/MacOS/Herdr')}`])
    assert.deepEqual(opens(sb), ['dev.herdr.app'])
    assert.notEqual(sb.pidOf('herdr'), old)
    assert.ok(alive(server) && alive(hold) && alive(client), 'herdr-core was touched')
    assert.equal(existsSync(join(sb.apps, 'Herdr.app.new.noindex')), false)
    assert.ok(r.stdout.includes(`Herdr: herdr-core hold before: ${hold} ${HOLD_ARGS(sb)}\n`), r.stdout)
    assert.ok(r.stdout.includes(`Herdr: herdr-core --hc-launchd before: ${server}; connect clients outside Herdr.app: ${client}\n`), r.stdout)
    assert.ok(r.stdout.includes(`Herdr: herdr-core hold after: ${hold} ${HOLD_ARGS(sb)}\n`), r.stdout)
    assert.doesNotMatch(r.stdout, /detached/)
    const m = sb.mails()
    assert.equal(m.length, 1)
    assert.equal(subject(m[0]), 'App updates on testhost')
    assert.match(m[0], /\nUpdated or relaunched:\n- Herdr updated and relaunched, 0\.1\.13 -> 0\.1\.15\n\nLog:/)
    assert.equal(existsSync(sb.marker), false)
  }))

// The case measured on the homelab Mac: the launch restarts the broker, and
// the holder keeps its PID and socket.
test('Herdr: the --hc-launchd broker restarts with a new PID and hold survives: "updated and relaunched, 0.1.13 -> 0.1.15", no FAILED', () =>
  withSandbox({}, (sb) => {
    const { server, hold } = sb.herdrCore()
    sb.start('herdr')
    sb.stage('herdr')
    const r = sb.run({ STUB_HERDR_RESTART: 'server' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.ok(!alive(server) && alive(hold))
    assert.match(r.stdout, new RegExp(`Herdr: herdr-core --hc-launchd restarted \\(${server} -> \\d+\\); expected, not a failure`))
    assert.match(r.stdout, /changed: Herdr updated and relaunched, 0\.1\.13 -> 0\.1\.15/)
    assert.doesNotMatch(r.stdout, /FAILED/)
    assert.equal(existsSync(sb.marker), false)
    assert.doesNotMatch(sb.mails()[0], /Failed:/)
  }))

test('Herdr: a herdr-core hold that restarts across the relaunch is FAILED: "hold ended, sessions lost"', () =>
  withSandbox({}, (sb) => {
    const { hold } = sb.herdrCore()
    sb.start('herdr')
    sb.stage('herdr')
    const r = sb.run({ STUB_HERDR_RESTART: 'hold' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assertMarker(sb, new RegExp(`Herdr: herdr-core hold ended, sessions lost \\(before: ${hold} `))
    assert.match(r.stdout, /Herdr: herdr-core hold after: \d+ \S+ hold --socket \/tmp\/holder-2\.sock\n/)
    const m = sb.mails()[0]
    assert.equal(subject(m), 'App updates on testhost: FAILED')
    assert.match(m, /\nFailed:\n- Herdr: herdr-core hold ended, sessions lost/)
  }))

test('Herdr: no herdr-core --hc-launchd after the relaunch is FAILED', () =>
  withSandbox({}, (sb) => {
    sb.herdrCore()
    sb.start('herdr')
    sb.stage('herdr')
    const r = sb.run({ STUB_HERDR_RESTART: 'nobroker' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assertMarker(sb, /Herdr: no herdr-core --hc-launchd server after the relaunch; sessions unreachable until it starts/)
    assert.doesNotMatch(r.stdout, /hold ended/)
  }))

test('Herdr: the staged bundle is never applied: FAILED "did not apply", the app runs, no second "version is unchanged" line', () =>
  withSandbox({}, (sb) => {
    const { server, hold } = sb.herdrCore()
    sb.start('herdr')
    sb.stage('herdr', '0.1.15', { swap: false })
    const r = sb.run()
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.deepEqual(opens(sb), ['dev.herdr.app'])
    assert.ok(alive(sb.pidOf('herdr')), 'Herdr was left down')
    assert.ok(alive(server) && alive(hold))
    assertMarker(sb, /Herdr: relaunched, but the staged update did not apply \(still at Herdr\.app\.new\.noindex after 3s\) \(see/)
    assert.doesNotMatch(r.stdout, /version is unchanged|started anyway/)
    assert.doesNotMatch(sb.mails()[0], /version is unchanged|Updated or relaunched:/)
  }))

test('Herdr: a terminal herdr-core connect client that the relaunch ends is mailed for a reattach, not FAILED', () =>
  withSandbox({}, (sb) => {
    sb.herdrCore()
    const client = sb.herdrClient()
    sb.start('herdr', 'with-connect')
    sb.stage('herdr')
    const r = sb.run({ STUB_HERDR_RESTART: 'server', STUB_HERDR_DETACH: '1' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.equal(existsSync(sb.marker), false)
    const m = sb.mails()[0]
    assert.match(m, /\nUpdated or relaunched:\n- Herdr updated and relaunched, 0\.1\.13 -> 0\.1\.15\n/)
    assert.ok(m.includes(`\nRelaunch by hand:\n- Herdr: terminal clients attached with herdr-core connect were detached (PIDs ${client}); sessions survive in hold; reattach\n`), m)
  }))

test('Herdr: Herdr.app exits again during the broker wait: FAILED, left down, no "updated" line', () =>
  withSandbox({}, (sb) => {
    const { hold } = sb.herdrCore()
    sb.start('herdr')
    sb.stage('herdr')
    const r = sb.run({ STUB_HERDR_DIES: '2' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.ok(alive(hold))
    assertMarker(sb, /Herdr: relaunched, but the app was not running 3s later/)
    assert.match(readFileSync(join(sb.logs, 'app-update.down'), 'utf8'), /^dev\.herdr\.app \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n$/)
    assert.doesNotMatch(r.stdout, /changed: Herdr/)
  }))

test('Herdr: no herdr-core hold found (only the broker runs): not relaunched, reported for a relaunch by hand', () =>
  withSandbox({}, (sb) => {
    sb.herdrCore({ hold: false })
    sb.start('herdr')
    sb.stage('herdr')
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.signals(), [])
    assert.deepEqual(called(sb, 'open'), [])
    assert.match(sb.mails()[0], /Relaunch by hand:\n- Herdr: update staged; not relaunched: no herdr-core hold found, so the job cannot prove the sessions survive; relaunch by hand\n/)
  }))

test('Herdr: nothing staged: not touched', () =>
  withSandbox({}, (sb) => {
    sb.herdrCore()
    sb.start('herdr')
    const r = sb.run()
    assert.match(r.stdout, /Herdr: no update staged/)
    assert.deepEqual(sb.signals(), [])
  }))

test('Herdr: staged but Herdr.app not running: not started, and mailed for a start by hand', () =>
  withSandbox({}, (sb) => {
    sb.herdrCore()
    sb.stage('herdr')
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(called(sb, 'open'), [])
    assert.match(sb.mails()[0], /\nRelaunch by hand:\n- Herdr: update staged \(0\.1\.15\), but Herdr\.app is not running; not started; start it by hand\n/)
  }))

// A copy of the script in its own dir, with lib/text.sh next to it as the
// loader needs, and <from> replaced by <to>.
function scriptWith(sb, from, to) {
  const src = read('dot_cron/executable_app-update.sh')
  assert.equal(src.split(from).length, 2, `the script has no single line ${from}`)
  mkdirSync(join(sb.base, 'lib'), { recursive: true })
  copyFileSync(new URL('dot_cron/lib/text.sh', ROOT), join(sb.base, 'lib', 'text.sh'))
  const copy = join(sb.base, 'app-update.sh')
  writeFileSync(copy, src.replace(from, to))
  return copy
}

// The switch at the top of the script: one line to change.
test('Herdr switch: herdr_class=report: a staged update is mailed, Herdr is never signalled', () =>
  withSandbox({}, (sb) => {
    sb.herdrCore()
    sb.start('herdr')
    sb.stage('herdr')
    const r = sb.run({}, { script: scriptWith(sb, '\nherdr_class=relaunch\n', '\nherdr_class=report\n') })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.signals(), [])
    assert.deepEqual(called(sb, 'open'), [])
    assert.match(sb.mails()[0], /- Herdr: update staged \(0\.1\.15\); relaunch by hand\n/)
  }))

// --- The shared text lib ---------------------------------------------------------

for (const libCase of ['missing', 'syntax']) {
  test(`lib: a ${libCase} lib/text.sh writes app-update.FAILED ("cannot load") and exits 1 before any probe`, () =>
    withSandbox({}, (sb) => {
      const dir = join(sb.base, 'nolib')
      mkdirSync(dir)
      const copy = join(dir, 'app-update.sh')
      writeFileSync(copy, read('dot_cron/executable_app-update.sh'))
      if (libCase === 'syntax') {
        mkdirSync(join(dir, 'lib'))
        writeFileSync(join(dir, 'lib', 'text.sh'), 'oneline() {\n    printf "%s" "$1"\n')
      }
      const r = sb.run({}, { script: copy })
      assert.equal(r.status, 1, r.stdout + r.stderr)
      assert.match(r.stdout, /^app-update: cannot load .*\/lib\/text\.sh$/m)
      assert.match(readFileSync(sb.marker, 'utf8'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} app-update: cannot load ~\/\.cron\/lib\/text\.sh; run chezmoi apply\n$/)
      assert.deepEqual(called(sb, 'net'), [])
      assertNoAction(sb)
    }))
}

// --- Squirrel apps (T3 Code, Fastmail, 1Password) ----------------------------------

test('T3 Code staged: SIGTERM, wait for ShipIt to finish, then open; version 0.1.7 -> 0.1.8', () =>
  withSandbox({}, (sb) => {
    const old = sb.start('t3')
    sb.stage('t3', '0.1.8')
    sb.shipit('t3', 2)
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.signals(), [`TERM ${join(sb.apps, 'T3 Code (Beta).app/Contents/MacOS/T3 Code (Beta)')}`])
    assert.deepEqual(opens(sb), ['com.t3tools.t3code'])
    assert.deepEqual(sb.early(), [], '`open` ran while ShipIt was still at work')
    // Squirrel never deletes ShipItState.plist; the update bundle is what goes.
    assert.equal(existsSync(sb.shipitState('t3')), true)
    assert.equal(existsSync(sb.updateBundle('t3')), false)
    assert.ok(!alive(old))
    assert.ok(alive(sb.pidOf('t3')))
    assert.match(sb.mails()[0], /- T3 Code updated and relaunched, 0\.1\.7 -> 0\.1\.8\n/)
  }))

test('Squirrel: ShipIt still busy past the bound: after at most 60s more, `open` runs anyway, the app is up, FAILED', () =>
  withSandbox({}, (sb) => {
    const old = sb.start('fastmail')
    sb.stage('fastmail', '1.9.1')
    sb.shipit('fastmail', 600)
    const r = sb.run()
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.ok(r.elapsed >= 5 && r.elapsed < 30, `took ${r.elapsed}s (3s bound, then 3s more for ShipIt)`)
    assert.deepEqual(opens(sb), ['com.fastmail.mac.Fastmail'])
    assert.notEqual(sb.pidOf('fastmail'), old)
    assert.ok(alive(sb.pidOf('fastmail')), 'the job left Fastmail down')
    assertMarker(sb, /Fastmail: ShipIt did not finish within 3s \(ShipIt still runs\); started anyway/)
    assert.match(sb.mails()[0], /Failed:\n- Fastmail: ShipIt did not finish within 3s \(ShipIt still runs\); started anyway\n/)
    assert.equal(existsSync(join(sb.logs, 'app-update.down')), false, 'the app is up, so it is not on the down list')
  }))

test('Squirrel: ShipItState.plist stays after ShipIt finished (as Squirrel leaves it): no wait on it, relaunched', () =>
  withSandbox({}, (sb) => {
    sb.start('fastmail')
    sb.stage('fastmail', '1.9.1')
    sb.shipit('fastmail', 0)
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.ok(r.elapsed < 5.5, `waited ${r.elapsed}s: a wait on the plist would run out the 3s bound and 3s more`)
    assert.ok(existsSync(sb.shipitState('fastmail')))
    assert.match(r.stdout, /changed: Fastmail updated and relaunched, 1\.9\.0 -> 1\.9\.1/)
  }))

test('Squirrel: no ShipIt runs and the update bundle stays: `open` anyway after the wait, FAILED, app up', () =>
  withSandbox({}, (sb) => {
    sb.start('fastmail')
    sb.stage('fastmail', '1.9.1')
    const r = sb.run()
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.deepEqual(opens(sb), ['com.fastmail.mac.Fastmail'])
    assert.ok(alive(sb.pidOf('fastmail')))
    assertMarker(sb, /Fastmail: ShipIt did not finish within 3s \(the update bundle is still there\); started anyway/)
  }))

test('Squirrel: ShipItState.plist there but its update bundle gone (the state after an install): no update staged, not touched', () =>
  withSandbox({}, (sb) => {
    const pid = sb.start('claude')
    sb.stage('claude', '5.1232.0')
    rmSync(join(sb.updateBundle('claude'), '..'), { recursive: true })
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /Claude Desktop: no update staged/)
    assert.deepEqual(sb.signals(), [])
    assert.ok(alive(pid))
  }))

test('Squirrel: the updateBundleURL is decoded (%20 is a space) and must be a file:// URL', () =>
  withSandbox({}, (sb) => {
    sb.start('t3')
    sb.stage('t3', '0.1.8')
    assert.match(readFileSync(sb.shipitState('t3'), 'utf8'), /updateBundleURL=file:\/\/.*update\.Ab%20C1\/T3%20Code%20\(Beta\)\.app\/\n/)
    writeFileSync(sb.shipitState('t3'), 'updateBundleURL=https://example.test/T3.app/\n')
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.signals(), [])
    assert.match(sb.mails()[0], /- T3 Code: cannot read updateBundleURL from its ShipItState\.plist; not relaunched/)
  }))

test('Squirrel: a ShipIt for another bundle id does not hold this app back', () =>
  withSandbox({}, (sb) => {
    sb.start('fastmail')
    sb.stage('fastmail', '1.9.1')
    sb.shipit('fastmail', 1)
    sb.stage('claude')
    sb.shipit('claude', 600)
    const r = sb.run()
    assert.match(r.stdout, /changed: Fastmail updated and relaunched, 1\.9\.0 -> 1\.9\.1/)
  }))

test('1Password relaunched: the mail says it is now locked and `op` fails until unlocked', () =>
  withSandbox({}, (sb) => {
    sb.start('onepassword')
    sb.stage('onepassword', '8.12.46')
    sb.shipit('onepassword', 1)
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(sb.mails()[0], /- 1Password updated and relaunched, 8\.12\.44 -> 8\.12\.46; now locked: `op` fails until 1Password is unlocked\n/)
  }))

test('Squirrel: an update staged but the app not running: not started, and mailed for a start by hand', () =>
  withSandbox({}, (sb) => {
    sb.stage('t3', '0.1.8')
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(called(sb, 'open'), [])
    assert.match(sb.mails()[0], /\nRelaunch by hand:\n- T3 Code: update staged, but the app is not running; not started; start it by hand\n/)
  }))

// --- Relaunch failures ------------------------------------------------------------

test('quit: an app that ignores SIGTERM is FAILED after the wait, left running, never SIGKILLed, never reopened', () =>
  withSandbox({}, (sb) => {
    const pid = sb.start('t3', 'stuck')
    sb.stage('t3', '0.1.8')
    sb.shipit('t3', 1)
    const r = sb.run()
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.ok(r.elapsed >= 2 && r.elapsed < 20, `took ${r.elapsed}s`)
    assertMarker(sb, new RegExp(`T3 Code: PID ${pid} still runs 3s after SIGTERM; left running \\(the job never sends SIGKILL\\)`))
    assert.ok(alive(pid), 'the app was killed')
    assert.equal(sb.signals().length, 1, 'more than one signal')
    assert.deepEqual(called(sb, 'open'), [])
  }))

test('relaunch: `open` runs but the app does not come back: FAILED', () =>
  withSandbox({}, (sb) => {
    sb.start('t3')
    sb.stage('t3', '0.1.8')
    sb.shipit('t3', 1)
    const r = sb.run({ STUB_NOAPP: 'com.t3tools.t3code' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assertMarker(sb, /T3 Code: quit and `open -g -b com\.t3tools\.t3code` ran, but the app was not running 3s later/)
  }))

test('relaunch: `open` fails: FAILED with its error', () =>
  withSandbox({}, (sb) => {
    sb.start('t3')
    sb.stage('t3', '0.1.8')
    sb.shipit('t3', 1)
    const r = sb.run({ STUB_OPEN_FAIL: 'com.t3tools.t3code' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assertMarker(sb, /T3 Code: quit, but `open -g -b com\.t3tools\.t3code` failed: LSOpenURLsWithRole\(\) failed with error -10814/)
  }))

test('relaunch: version unchanged: a warning in the mail, never "updated", not FAILED', () =>
  withSandbox({}, (sb) => {
    sb.start('t3')
    sb.stage('t3')
    sb.shipit('t3', 1)
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const m = sb.mails()[0]
    assert.match(m, /- T3 Code relaunched, but the version is unchanged \(0\.1\.7\): WARNING, the staged update did not apply\n/)
    assert.doesNotMatch(m, /updated/)
    assert.equal(subject(m), 'App updates on testhost')
    assert.equal(existsSync(sb.marker), false)
  }))

test('relaunch: one app fails, the others still run, and the marker counts the rest', () =>
  withSandbox({}, (sb) => {
    sb.start('t3')
    sb.stage('t3', '0.1.8')
    sb.shipit('t3', 1)
    sb.start('fastmail')
    sb.stage('fastmail', '1.9.1')
    sb.shipit('fastmail', 1)
    sb.start('onepassword')
    sb.stage('onepassword', '8.12.46')
    sb.shipit('onepassword', 1)
    const r = sb.run({ STUB_OPEN_FAIL: 'com.t3tools.t3code com.1password.1password' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assertMarker(sb, /T3 Code: quit, but `open .*` failed: .* \(and 1 more\) \(see /)
    assert.match(sb.mails()[0], /Fastmail updated and relaunched, 1\.9\.0 -> 1\.9\.1/)
    assert.ok(stampIsToday(sb), 'a pass with failures is still complete')
  }))

// --- Exact bundle id (never by name) ------------------------------------------------

test('bundle id: a running `claude` CLI is never signalled, also while Claude Desktop is relaunched; no pgrep/pkill/killall/osascript', () =>
  withSandbox({}, (sb) => {
    const cli = sb.claudeCli()
    sb.claudeFiles()
    sb.start('claude')
    sb.stage('claude', '5.1232.0')
    sb.shipit('claude', 1)
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /changed: Claude Desktop updated and relaunched, 5\.1231\.0 -> 5\.1232\.0/)
    assert.deepEqual(sb.signals(), [`TERM ${join(sb.apps, 'Claude.app/Contents/MacOS/Claude')}`])
    assert.ok(alive(cli), 'the claude CLI process is gone')
    assertForbiddenUnused(sb)
    assert.ok(called(sb, 'lsappinfo').every((c) => /-app (dev\.herdr\.app|com\.[A-Za-z0-9.-]+)$/.test(c)), called(sb, 'lsappinfo').join('\n'))
  }))

test('bundle id: lsappinfo output that names another bundleID is FAILED and nothing is signalled', () =>
  withSandbox({}, (sb) => {
    const pid = sb.start('t3')
    sb.stage('t3', '0.1.8')
    const r = sb.run({ STUB_LSAPPINFO_BUNDLEID: 'com.anthropic.claude-code' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assertMarker(sb, /T3 Code: update staged, but its PID cannot be read \(lsappinfo output does not name exactly bundleID "com\.t3tools\.t3code"/)
    assert.deepEqual(sb.signals(), [])
    assert.ok(alive(pid))
  }))

test('bundle id: lsappinfo fails: FAILED, nothing signalled', () =>
  withSandbox({}, (sb) => {
    sb.start('t3')
    sb.stage('t3', '0.1.8')
    const r = sb.run({ STUB_LSAPPINFO_FAIL: '1' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assertMarker(sb, /T3 Code: update staged, but its PID cannot be read \(lsappinfo exit 1/)
    assert.deepEqual(sb.signals(), [])
  }))

test('bundle id: an Info.plist with another bundle id is skipped with a warning', () =>
  withSandbox({}, (sb) => {
    writeFileSync(sb.plistOf('t3'), 'CFBundleIdentifier=com.example.other\nCFBundleShortVersionString=1\n')
    sb.start('t3')
    sb.stage('t3', '0.1.8')
    const r = sb.run()
    assert.match(r.stdout, /warning: T3 Code: .* has bundle id 'com\.example\.other', not com\.t3tools\.t3code; skipped/)
    assert.deepEqual(sb.signals(), [])
  }))

// --- Claude Desktop ------------------------------------------------------------------

test('Claude Desktop: a claude process under Claude.app: skipped, session active, reported; nothing signalled', () =>
  withSandbox({}, (sb) => {
    sb.start('claude', 'with-claude')
    sb.stage('claude', '5.1232.0')
    sb.shipit('claude', 1)
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.signals(), [])
    assert.deepEqual(called(sb, 'open'), [])
    assert.match(sb.mails()[0], /Relaunch by hand:\n- Claude Desktop: update staged; skipped: session active \(a claude process \(PID \d+\) runs under Claude\.app\); relaunch by hand\n/)
  }))

for (const rel of CLAUDE_PATHS) {
  test(`Claude Desktop: ${rel} changed in the last 60 min: skipped, session active; 2 hours old: relaunched`, () =>
    withSandbox({}, (sb) => {
      sb.claudeFiles(rel)
      sb.start('claude')
      sb.stage('claude', '5.1232.0')
      sb.shipit('claude', 1)
      let r = sb.run()
      assert.match(r.stdout, /by hand: Claude Desktop: update staged; skipped: session active \(Claude session files or the VM disk changed in the last 60 min\)/)
      assert.deepEqual(sb.signals(), [])

      sb.claudeFiles()
      sb.stage('claude', '5.1232.0')
      sb.shipit('claude', 1)
      ago(sb.stamp, DAY)
      r = sb.run()
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.match(r.stdout, /changed: Claude Desktop updated and relaunched, 5\.1231\.0 -> 5\.1232\.0/)
    }))
}

test('Claude Desktop: the session files cannot be checked (a path is missing): reported, not relaunched', () =>
  withSandbox({}, (sb) => {
    const sup = join(sb.home, 'Library/Application Support/Claude')
    mkdirSync(join(sup, 'claude-code-sessions'), { recursive: true })
    sb.start('claude')
    sb.stage('claude', '5.1232.0')
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.signals(), [])
    assert.match(sb.mails()[0], /- Claude Desktop: update staged; not relaunched: cannot check Claude session files \(find exit 1\)/)
  }))

// --- Report only -------------------------------------------------------------------

test('Chrome: installed version newer than the running helpers: "update staged, relaunch by hand"; never signalled', () =>
  withSandbox({}, (sb) => {
    sb.start('chrome', 'chrome:157.0.8103.40')
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.signals(), [])
    assert.match(sb.mails()[0], /- Chrome: update staged \(running 157\.0\.8103\.40, installed 157\.0\.8103\.52\); relaunch by hand \(the job never quits Chrome: a quit loses tabs\)\n/)
  }))

test('Chrome: running and installed the same: nothing to report', () =>
  withSandbox({}, (sb) => {
    sb.start('chrome', 'chrome:157.0.8103.52')
    const r = sb.run()
    assert.match(r.stdout, /Chrome: up to date \(157\.0\.8103\.52\)/)
    assert.deepEqual(sb.mails(), [])
  }))

test('Chrome: no helper shows a framework version: could not check (warning)', () =>
  withSandbox({}, (sb) => {
    sb.start('chrome')
    const r = sb.run()
    assert.match(r.stdout, /warning: Chrome: could not check \(no single framework version in the running helpers/)
    assert.deepEqual(sb.mails(), [])
  }))

test('Downie: the appcast has a newer version: "update available, relaunch by hand"; never signalled', () =>
  withSandbox({}, (sb) => {
    sb.start('downie')
    sb.feed('downie', appcast('4.13.4'))
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.signals(), [])
    assert.deepEqual(called(sb, 'curl').filter((c) => !c.endsWith(GHOSTTY_FEED)), [`curl -fsSL --max-time 20 ${APPS.downie.feed}`])
    assert.match(sb.mails()[0], /- Downie: update available \(4\.13\.3 -> 4\.13\.4\); relaunch by hand\n/)
  }))

test('Downie: the newest of several versions counts, in attribute or element form, numerically (4.13 > 4.9)', () =>
  withSandbox({}, (sb) => {
    sb.feed('downie', appcast('4.9.9', '4.13.10', '4.10.0') + '<item><sparkle:shortVersionString>4.13.2</sparkle:shortVersionString></item>\n')
    let r = sb.run()
    assert.match(r.stdout, /Downie: update available \(4\.13\.3 -> 4\.13\.10\)/)
    ago(sb.stamp, DAY)
    sb.feed('downie', '<rss><channel><item><sparkle:shortVersionString>4.14</sparkle:shortVersionString></item></channel></rss>\n')
    r = sb.run()
    assert.match(r.stdout, /Downie: update available \(4\.13\.3 -> 4\.14\)/)
  }))

test('Downie: same or older version in the appcast: nothing to report', () =>
  withSandbox({}, (sb) => {
    sb.feed('downie', appcast('4.13.3', '4.12.0'))
    const r = sb.run()
    assert.match(r.stdout, /Downie: up to date \(4\.13\.3; newest in the appcast: 4\.13\.3\)/)
    assert.deepEqual(sb.mails(), [])
  }))

for (const [name, setup, env, re] of [
  ['the fetch fails', () => {}, { STUB_CURL_FAIL: '1' }, /Downie: could not check \(fetch of https:\/\/software\.example\.test\/downie\/v4\/updates\.xml failed: curl: \(6\) Could not resolve host/],
  ['the appcast has no version', (sb) => sb.feed('downie', '<html>maintenance</html>'), {}, /Downie: could not check \(no dotted version number in the appcast at /],
]) {
  test(`Downie: ${name}: "could not check" is a warning, not FAILED, and sends no mail alone`, () =>
    withSandbox({}, (sb) => {
      setup(sb)
      const r = sb.run(env)
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.match(r.stdout, re)
      assert.equal(existsSync(sb.marker), false)
      assert.deepEqual(sb.mails(), [])
    }))
}

test('warnings ride along in a mail that goes out for another reason', () =>
  withSandbox({}, (sb) => {
    sb.start('chrome', 'chrome:157.0.8103.40')
    const r = sb.run({ STUB_CURL_FAIL: '1' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const m = sb.mails()[0]
    assert.match(m, /\n\nRelaunch by hand:\n- Chrome: .*\n\nWarnings:\n- Downie: could not check .*\n- Ghostty: could not check \(fetch of https:\/\/release\.files\.ghostty\.org\/appcast\.xml failed: .*\n\nLog: ~\/\.cron\/logs\/app-update\.log$/)
  }))

test('Ghostty with a feed that has a newer version: reported, never signalled', () =>
  withSandbox({}, (sb) => {
    APPS.ghostty.feed = 'https://release.example.test/ghostty/appcast.xml'
    try {
      sb.setVersion('ghostty', '1.4.0')
      sb.feed('ghostty', appcast('1.4.1'))
      sb.start('ghostty')
      const r = sb.run()
      assert.deepEqual(sb.signals(), [])
      assert.match(sb.mails()[0], /- Ghostty: update available \(1\.4\.0 -> 1\.4\.1\); relaunch by hand \(the job never quits Ghostty: a quit closes its shells\)\n/)
    } finally {
      delete APPS.ghostty.feed
    }
  }))

// --- Docker Desktop -------------------------------------------------------------------

test('Docker on Sunday, nothing running: `docker desktop update --quiet`, Docker answers, 4.98.0 -> 4.99.0, stamp touched', () =>
  withSandbox({}, (sb) => {
    writeFileSync(join(sb.base, 'state/update/com.docker.docker'), '4.99.0')
    const r = sb.run({}, { weekday: 0 })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(called(sb, 'docker'), ['docker info', 'docker ps -q', 'docker desktop update --quiet', 'docker info'])
    assert.match(sb.mails()[0], /- Docker Desktop updated, 4\.98\.0 -> 4\.99\.0\n/)
    assert.ok(statSync(sb.dstamp).mtimeMs > Date.now() - 60000)
  }))

test('Docker on Sunday, no newer version: no mail, stamp touched', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({}, { weekday: 0 })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /Docker Desktop: up to date \(4\.98\.0\)/)
    assert.deepEqual(sb.mails(), [])
    assert.ok(statSync(sb.dstamp).mtimeMs > Date.now() - 60000)
  }))

test('Docker on Sunday with containers running: not updated, reported', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({ STUB_DOCKER_PS: 'abc123 def456' }, { weekday: 0 })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.ok(!sb.calls().includes('docker desktop update --quiet'))
    assert.match(sb.mails()[0], /- Docker Desktop: not updated \(Sunday\): 2 container\(s\) running\n/)
    assert.ok(statSync(sb.dstamp).mtimeMs < Date.now() - DAY * 1000)
  }))

test('Docker on Sunday, Docker not answering (or `docker ps` failing): not updated, reported', () =>
  withSandbox({}, (sb) => {
    let r = sb.run({ STUB_DOCKER_DOWN: '1' }, { weekday: 0 })
    assert.match(sb.mails()[0], /- Docker Desktop: not updated \(Sunday\): Docker does not answer `docker info`\n/)
    ago(sb.stamp, DAY)
    r = sb.run({ STUB_DOCKER_PS_FAIL: '1' }, { weekday: 0 })
    assert.equal(r.status, 0)
    assert.match(sb.mails()[1], /- Docker Desktop: not updated \(Sunday\): `docker ps -q` failed: error during connect\n/)
    assert.ok(!sb.calls().includes('docker desktop update --quiet'))
  }))

test('Docker: the update succeeds but Docker never answers again: FAILED after the wait, stamp not touched', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({ STUB_DOCKER_NEVER_BACK: '1' }, { weekday: 0 })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assertMarker(sb, /Docker Desktop: `docker info` did not answer within 3s after the update/)
    assert.ok(statSync(sb.dstamp).mtimeMs < Date.now() - DAY * 1000)
  }))

test('Docker: `docker desktop update` fails: FAILED, stamp not touched, so the catch-up retries', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({ STUB_DOCKER_UPDATE_RC: '1' }, { weekday: 0 })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assertMarker(sb, /Docker Desktop: `docker desktop update --quiet` failed \(exit 1; 124 or 137 is the 20 min timeout\): update failed: download error/)
    assert.ok(statSync(sb.dstamp).mtimeMs < Date.now() - DAY * 1000)
  }))

test('Docker catch-up: on a weekday, a Docker stamp 9 days old updates; 7 days old does not; missing updates', () =>
  withSandbox({}, (sb) => {
    let r = sb.run({}, { weekday: 3 })
    assert.match(r.stdout, /Docker Desktop: not due/)
    assert.deepEqual(called(sb, 'docker'), [])

    ago(sb.stamp, DAY)
    ago(sb.dstamp, 7 * DAY)
    r = sb.run({}, { weekday: 4 })
    assert.match(r.stdout, /Docker Desktop: not due/)

    ago(sb.stamp, DAY)
    ago(sb.dstamp, 9 * DAY)
    writeFileSync(join(sb.base, 'state/update/com.docker.docker'), '4.99.0')
    r = sb.run({}, { weekday: 5 })
    assert.match(r.stdout, /Docker Desktop: docker desktop update --quiet \(no Docker update in the last 8 days\)/)
    assert.match(sb.mails()[0], /Docker Desktop updated, 4\.98\.0 -> 4\.99\.0/)

    ago(sb.stamp, DAY)
    rmSync(sb.dstamp)
    r = sb.run({}, { weekday: 6 })
    assert.match(r.stdout, /docker desktop update --quiet \(no Docker update in the last 8 days\)/)
  }))

test('Docker catch-up: busy Sundays leave the stamp old, so the next idle weekday updates', () =>
  withSandbox({}, (sb) => {
    ago(sb.dstamp, 6 * DAY)
    sb.run({ STUB_LOAD5: '9.00' }, { weekday: 0 })
    ago(sb.dstamp, 9 * DAY)
    const r = sb.run({}, { weekday: 1 })
    assert.ok(sb.calls().includes('docker desktop update --quiet'), r.stdout)
  }))

// --- Mail -------------------------------------------------------------------------------

test('mail: account icloud, From and To r@rdegges.com, the whole message on stdin and no message argument', () =>
  withSandbox({}, (sb) => {
    sb.start('chrome', 'chrome:157.0.8103.40')
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(called(sb, 'himalaya'), ['himalaya message send -a icloud (4 args)'])
    const m = sb.mails()[0]
    assert.match(m, /^From: r@rdegges\.com\nTo: r@rdegges\.com\nSubject: App updates on testhost\n\nApp update pass on testhost, \d{4}-\d{2}-\d{2} \d{2}:\d{2}\.\n\nRelaunch by hand:\n- Chrome: /)
  }))

test('mail: the caller\'s stdin never reaches himalaya', () =>
  withSandbox({}, (sb) => {
    sb.start('chrome', 'chrome:157.0.8103.40')
    const r = spawnSync(BASH, [SCRIPT], {
      encoding: 'utf8',
      input: 'From: attacker@example.com\nSubject: CALLER STDIN\n\nleaked\n',
      env: { HOME: sb.home, PATH: `${sb.bin}:${SYS_PATH}`, CALLS: join(sb.base, 'calls'), STATE: join(sb.base, 'state'), REAL: join(sb.base, 'real'), APP_UPDATE_APPS: sb.apps, APP_UPDATE_WAIT: '3', WAIT_FOR_NETWORK: join(sb.bin, 'net'), STUB_NOW: `03 3 ${TODAY}` },
    })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.doesNotMatch(sb.mails()[0], /CALLER STDIN|leaked|attacker/)
  }))

test('mail: the send fails: FAILED marker says so, exit 1, the pass still counts (stamp touched)', () =>
  withSandbox({}, (sb) => {
    sb.start('chrome', 'chrome:157.0.8103.40')
    const r = sb.run({ STUB_MAIL_RC: '1' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assertMarker(sb, /app-update: the report mail failed/)
    assert.match(r.stdout, /mail failed: cannot send message: smtp connection refused/)
    assert.ok(stampIsToday(sb))
  }))

test('mail: APP_UPDATE_MAIL_ACCOUNT replaces the account; an unknown one fails the send', () =>
  withSandbox({}, (sb) => {
    sb.start('chrome', 'chrome:157.0.8103.40')
    const r = sb.run({ APP_UPDATE_MAIL_ACCOUNT: 'broken' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.deepEqual(called(sb, 'himalaya'), ['himalaya message send -a broken (4 args)'])
    assertMarker(sb, /the report mail failed/)
  }))

test('mail: a failure and a failed send: the marker names both', () =>
  withSandbox({}, (sb) => {
    sb.start('t3')
    sb.stage('t3', '0.1.8')
    sb.shipit('t3', 1)
    const r = sb.run({ STUB_OPEN_FAIL: 'com.t3tools.t3code', STUB_MAIL_RC: '1' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assertMarker(sb, /T3 Code: quit, but `open .*` failed: .*; the report mail failed too \(see /)
  }))

test('mail: himalaya missing: a failure still writes the marker, with the mail failure', () =>
  withSandbox({}, (sb) => {
    rmSync(join(sb.bin, 'himalaya'))
    sb.start('chrome', 'chrome:157.0.8103.40')
    const r = sb.run()
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assertMarker(sb, /the report mail failed/)
  }))

test('mail and marker: non-ASCII, %, and backslashes in untrusted text arrive as printable ASCII, literally', () =>
  withSandbox({}, (sb) => {
    sb.setVersion('t3', '0.1.7-\u03b2%s\\n')
    sb.start('t3')
    sb.stage('t3', '0.1.8 \u2601\ufe0f 100%')
    sb.shipit('t3', 1)
    let r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const m = sb.mails()[0]
    // eslint-disable-next-line no-control-regex
    assert.match(m, /^[\x09\x0a\x20-\x7e]*$/, JSON.stringify(m))
    assert.ok(m.includes('- T3 Code updated and relaunched, 0.1.7-%s\\n -> 0.1.8  100%\n'), JSON.stringify(m))

    rmSync(sb.stamp)
    r = sb.run({ STUB_NOW: 'garbag\u00e9 \u2601\ufe0f %s' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const marker = assertMarker(sb, /cannot read the local time \(date printed: garbag  %s\)/)
    // eslint-disable-next-line no-control-regex
    assert.match(marker, /^[\x0a\x20-\x7e]*$/, JSON.stringify(marker))
  }))

// --- Portability and wiring ----------------------------------------------------------

test('without timeout/gtimeout on PATH it still runs, unbounded', () =>
  withSandbox({}, (sb) => {
    const tools = join(sb.base, 'tools')
    mkdirSync(tools)
    for (const t of ['bash', 'sh', 'mkdir', 'cat', 'sed', 'tr', 'cut', 'sleep', 'rm', 'touch', 'head', 'tail', 'wc', 'mv', 'ls', 'grep', 'find', 'sort', 'awk', 'ps', 'basename', 'dirname']) {
      symlinkSync(which(t), join(tools, t))
    }
    const PATH = `${sb.bin}:${tools}`
    assert.notEqual(spawnSync('sh', ['-c', 'command -v timeout || command -v gtimeout'], { env: { PATH } }).status, 0, 'timeout leaked onto PATH')
    sb.start('t3')
    sb.stage('t3', '0.1.8')
    sb.shipit('t3', 1)
    const r = sb.run({ PATH })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(sb.mails()[0], /T3 Code updated and relaunched, 0\.1\.7 -> 0\.1\.8/)
  }))

test('HOME with spaces and non-ASCII: logs, stamp, and marker land in that HOME', () =>
  withSandbox({}, (sb) => {
    const home = join(sb.base, 'Ränd all ☁️')
    mkdirSync(home)
    const r = sb.run({ HOME: home, STUB_LOAD5: '9.00' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.ok(existsSync(join(home, '.cron/logs/app-update.FAILED')), 'no stamp in a new HOME: the stale alert fires')
  }))

const CODE = read('dot_cron/executable_app-update.sh').split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')

test('script: bash shebang, parses under bash -n', () => {
  assert.match(read('dot_cron/executable_app-update.sh'), /^#!\/bin\/bash\n/)
  const r = spawnSync(BASH, ['-n', SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
})

test('script: never finds processes by name, never SIGKILLs, no Apple Events, no `claude update`', () => {
  assert.doesNotMatch(CODE, /\b(pgrep|pkill|killall|osascript)\b/)
  assert.doesNotMatch(CODE, /kill\s+-(9|KILL|s\s*KILL)\b/)
  assert.doesNotMatch(CODE, /claude\s+update/)
  assert.deepEqual([...new Set([...CODE.matchAll(/\bkill -\w+/g)].map((m) => m[0]))], ['kill -TERM'])
})

test('script: the bounds are 60s quit, 120s ShipIt, 60s relaunch, 20 min update, 10 min Docker wait, 20s fetch', () => {
  assert.match(CODE, /t=\$\(bound 60\); deadline=[^\n]*\n\s+while alive "\$old"/)
  assert.match(CODE, /t=\$\(bound 120\)/)
  assert.match(CODE, /run 1200 docker desktop update --quiet/)
  assert.match(CODE, /t=\$\(bound 600\)/)
  assert.match(CODE, /curl -fsSL --max-time 20/)
  assert.match(CODE, /run 30 open -g -b "\$id"/)
})

// --- Downie updater run script ----------------------------------------------------------

function execTemplate(input, data) {
  const home = mkdtempSync(join(tmpdir(), 'app-update-tmpl-'))
  try {
    const r = spawnSync('chezmoi', ['--source', SOURCE, '--destination', home, '--override-data', JSON.stringify(data), 'execute-template'], {
      encoding: 'utf8',
      input,
      env: { PATH: process.env.PATH, HOME: home },
    })
    assert.ifError(r.error)
    assert.equal(r.status, 0, `chezmoi execute-template exited ${r.status}: ${r.stderr}`)
    return r.stdout
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

for (const [name, extra] of [['missing', {}], ['false', { homelab: false }]]) {
  test(`run script: homelab ${name}: renders empty, so chezmoi never runs it`, () => {
    assert.equal(execTemplate(read(RUN_SCRIPT), { work: false, chezmoi: { os: 'darwin' }, ...extra }), '')
  })
}

test('run script: gated by wrapping its body in `if (index . "homelab")`, not by .chezmoiignore', () => {
  assert.match(read(RUN_SCRIPT), /^\{\{- if \(index \. "homelab"\) -\}\}\n#!\/bin\/bash\n[\s\S]*\n\{\{ end -\}\}\n$/)
  assert.doesNotMatch(read('.chezmoiignore'), /configure-homelab-updaters/)
})

// The stub `defaults` keeps one value per key in $STATE/defaults/<domain>.<key>;
// STUB_DEFAULTS_DENY makes writes and reads fail as a TCC refusal of Downie's
// container would.
const DEFAULTS =
  '#!/bin/sh\necho "defaults $*" >> "$CALLS"\n' +
  '[ -n "${STUB_DEFAULTS_DENY:-}" ] && { echo "Could not write domain $2; exiting" >&2; exit 1; }\n' +
  'case "$1" in\n' +
  'write) [ "$4" = -bool ] && [ "$5" = true ] && { echo 1 > "$STATE/defaults/$2.$3"; exit 0; }; exit 1 ;;\n' +
  'read) cat "$STATE/defaults/$2.$3" 2>/dev/null || { echo "The domain/default pair of ($2, $3) does not exist" >&2; exit 1; } ;;\n' +
  'esac\n'

function runScriptSandbox() {
  const base = mkdtempSync(join(tmpdir(), 'homelab-updaters-'))
  const home = join(base, 'home')
  const bin = join(base, 'bin')
  const state = join(base, 'state')
  for (const d of [home, bin, join(state, 'defaults')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(bin, 'defaults'), DEFAULTS)
  chmodSync(join(bin, 'defaults'), 0o755)
  const script = join(base, 'configure-homelab-updaters.sh')
  writeFileSync(script, execTemplate(read(RUN_SCRIPT), { work: false, chezmoi: { os: 'darwin' }, homelab: true }))
  const calls = join(base, 'calls')
  writeFileSync(calls, '')
  return {
    base,
    home,
    marker: join(home, '.cron/logs/homelab-updaters.FAILED'),
    calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    run: (env = {}) => spawnSync(BASH, [script], { encoding: 'utf8', env: { HOME: home, PATH: `${bin}:${SYS_PATH}`, CALLS: calls, STATE: state, ...env } }),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

test('run script: homelab true: writes SUEnableAutomaticChecks and SUAutomaticallyUpdate = true for Downie\'s bundle id, reads both back', () => {
  const sb = runScriptSandbox()
  try {
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const domain = APPS.downie.id
    assert.equal(domain, 'com.charliemonroe.Downie-4')
    assert.deepEqual(sb.calls(), [
      `defaults write ${domain} SUEnableAutomaticChecks -bool true`,
      `defaults read ${domain} SUEnableAutomaticChecks`,
      `defaults write ${domain} SUAutomaticallyUpdate -bool true`,
      `defaults read ${domain} SUAutomaticallyUpdate`,
    ])
    assert.equal(existsSync(sb.marker), false)
    // The job and the run script name the same app.
    assert.match(read('dot_cron/executable_app-update.sh'), new RegExp(`appcast_app Downie ${domain.replace(/\./g, '\\.')} "Downie 4\\.app"`))
  } finally {
    sb.cleanup()
  }
})

test('run script: a refused write: marker with the fix, exit 0 (the apply goes on); the fix clears it', () => {
  const sb = runScriptSandbox()
  try {
    const r = sb.run({ STUB_DEFAULTS_DENY: '1' })
    assert.equal(r.status, 0, 'a refused write must not fail the hourly apply: ' + r.stdout + r.stderr)
    const m = readFileSync(sb.marker, 'utf8')
    const fix = m.match(/^run '(.*)' once in Terminal \(macOS may ask to allow access to Downie's data\)\n$/)[1]
    const f = spawnSync('sh', ['-c', fix], { encoding: 'utf8', env: { HOME: sb.home, PATH: `${join(sb.base, 'bin')}:${SYS_PATH}`, CALLS: '/dev/null', STATE: join(sb.base, 'state') } })
    assert.equal(f.status, 0, f.stderr)
    assert.equal(existsSync(sb.marker), false)
    // A later run that succeeds also clears it.
    writeFileSync(sb.marker, 'old\n')
    assert.equal(sb.run().status, 0)
    assert.equal(existsSync(sb.marker), false)
  } finally {
    sb.cleanup()
  }
})

test('run script: a write that seems to work but does not read back is caught', () => {
  const sb = runScriptSandbox()
  try {
    writeFileSync(join(sb.base, 'bin/defaults'), DEFAULTS.replace('echo 1 > "$STATE/defaults/$2.$3"; ', ''))
    const r = sb.run()
    assert.equal(r.status, 0)
    assert.ok(existsSync(sb.marker))
  } finally {
    sb.cleanup()
  }
})

// --- Tester pass: probe failures, real process shapes, a full night ---------------------
//
// Extra stubs for the cases below, written into one sandbox only. `ps` passes
// through to the real ps, except that STUB_PS_FAIL names one exact argument
// list that fails, STUB_PS_GHOST names a PID that `ps -o stat= -p` reports as
// running though no such process exists, and STUB_PS_EXTRA adds lines (with
// @CLAUDE@ for Claude Desktop's PID) to the `ps -A -o pid= -o ppid= -o comm=`
// listing, in the macOS shape: comm is the full executable path, with spaces.
// `find` fails for the one start path STUB_FIND_FAIL (root in Docker reads
// every directory, so a chmod cannot make it fail).
const REAL_PS = which('ps')
const REAL_FIND = which('find')
const PS_STUB =
  '#!/bin/sh\n' +
  'if [ -n "${STUB_PS_FAIL:-}" ] && [ "$*" = "$STUB_PS_FAIL" ]; then echo "ps: sysctl: Operation not permitted" >&2; exit 1; fi\n' +
  'if [ -n "${STUB_PS_GHOST:-}" ] && [ "$*" = "-o stat= -p $STUB_PS_GHOST" ]; then echo S; exit 0; fi\n' +
  `${REAL_PS} "$@"; rc=$?\n` +
  'if [ -n "${STUB_PS_EXTRA:-}" ] && [ "$*" = "-A -o pid= -o ppid= -o comm=" ]; then\n' +
  '  c=$(cat "$STATE/apps/com.anthropic.claudefordesktop"); printf "%s\\n" "$STUB_PS_EXTRA" | sed "s/@CLAUDE@/$c/g"\n' +
  'fi\nexit $rc\n'
const FIND_STUB =
  '#!/bin/sh\n' +
  'if [ -n "${STUB_FIND_FAIL:-}" ] && [ "$1" = "$STUB_FIND_FAIL" ]; then echo "find: \'$1\': Permission denied" >&2; exit 1; fi\n' +
  `exec ${REAL_FIND} "$@"\n`
function addStub(sb, name, body) {
  writeFileSync(join(sb.bin, name), body)
  chmodSync(join(sb.bin, name), 0o755)
}

test('full night: every relaunchable app staged, Chrome staged, Downie newer, Docker due: each app handled once, in order, one mail', () =>
  withSandbox({}, (sb) => {
    const { server, hold } = sb.herdrCore()
    sb.claudeFiles()
    sb.start('herdr')
    sb.stage('herdr')
    for (const [k, v] of [['t3', '0.1.8'], ['fastmail', '1.9.1'], ['onepassword', '8.12.46'], ['claude', '5.1232.0']]) {
      sb.start(k)
      sb.stage(k, v)
      sb.shipit(k, 1)
    }
    sb.start('chrome', 'chrome:157.0.8103.40')
    sb.feed('downie', appcast('4.13.4'))
    writeFileSync(join(sb.base, 'state/update/com.docker.docker'), '4.99.0')
    const r = sb.run({}, { weekday: 0 })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const exe = (k) => join(sb.apps, APPS[k].bundle, 'Contents/MacOS', APPS[k].exe)
    // Shared globals ($pid, $plist, $id, $out) must not leak from one app to the next.
    assert.deepEqual(sb.signals(), ['herdr', 't3', 'fastmail', 'onepassword', 'claude'].map((k) => `TERM ${exe(k)}`))
    assert.deepEqual(opens(sb), ['dev.herdr.app', 'com.t3tools.t3code', 'com.fastmail.mac.Fastmail', 'com.1password.1password', 'com.anthropic.claudefordesktop'])
    assert.deepEqual(sb.early(), [])
    assert.ok(alive(server) && alive(hold), 'herdr-core was touched')
    const m = sb.mails()
    assert.equal(m.length, 1)
    assert.equal(subject(m[0]), 'App updates on testhost')
    const body = m[0].split('\n\n').slice(1).join('\n\n')
    assert.match(body, new RegExp([
      '^App update pass on testhost, [^\\n]*\\.',
      '',
      'Updated or relaunched:',
      '- Herdr updated and relaunched, 0\\.1\\.13 -> 0\\.1\\.15',
      '- T3 Code updated and relaunched, 0\\.1\\.7 -> 0\\.1\\.8',
      '- Fastmail updated and relaunched, 1\\.9\\.0 -> 1\\.9\\.1',
      '- 1Password updated and relaunched, 8\\.12\\.44 -> 8\\.12\\.46; now locked[^\\n]*',
      '- Claude Desktop updated and relaunched, 5\\.1231\\.0 -> 5\\.1232\\.0',
      '- Docker Desktop updated, 4\\.98\\.0 -> 4\\.99\\.0',
      '',
      'Relaunch by hand:',
      '- Chrome: update staged \\(running 157\\.0\\.8103\\.40, installed 157\\.0\\.8103\\.52\\)[^\\n]*',
      '- Downie: update available \\(4\\.13\\.3 -> 4\\.13\\.4\\); relaunch by hand',
      '',
      'Log: ~/\\.cron/logs/app-update\\.log$',
    ].join('\\n')), JSON.stringify(m[0]))
    assert.equal(existsSync(sb.marker), false)
    assert.ok(stampIsToday(sb))
    assert.ok(statSync(sb.dstamp).mtimeMs > Date.now() - 60000)
    assertForbiddenUnused(sb)
  }))

test('Claude Desktop: a claude grandchild with the measured macOS shape (Claude -> Helpers/disclaimer -> .../Application Support/Claude/claude-code/<v>/claude.app/.../claude): skipped, session active', () =>
  withSandbox({}, (sb) => {
    addStub(sb, 'ps', PS_STUB)
    sb.claudeFiles()
    sb.start('claude')
    sb.stage('claude', '5.1232.0')
    sb.shipit('claude', 1)
    const r = sb.run({
      STUB_PS_EXTRA: [
        '900001 @CLAUDE@ /Applications/Claude.app/Contents/Helpers/disclaimer',
        `900002 900001 ${sb.home}/Library/Application Support/Claude/claude-code/2.1.321/ddbdf2b334e1/claude.app/Contents/MacOS/claude`,
      ].join('\n'),
    })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.signals(), [])
    assert.deepEqual(called(sb, 'open'), [])
    assert.match(sb.mails()[0], /- Claude Desktop: update staged; skipped: session active \(a claude process \(PID 900002\) runs under Claude\.app\); relaunch by hand\n/)
  }))

test('Claude Desktop: helpers with spaces in their paths, a claude-code process, and a claude outside its tree do not count as a session', () =>
  withSandbox({}, (sb) => {
    addStub(sb, 'ps', PS_STUB)
    sb.claudeFiles()
    sb.start('claude')
    sb.stage('claude', '5.1232.0')
    sb.shipit('claude', 1)
    const r = sb.run({
      STUB_PS_EXTRA: [
        '900001 @CLAUDE@ /Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)',
        '900003 @CLAUDE@ /Applications/Claude.app/Contents/Resources/claude-code',
        '900004 1 /Users/x/.local/share/claude/versions/2.1.321/claude',
      ].join('\n'),
    })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /changed: Claude Desktop updated and relaunched, 5\.1231\.0 -> 5\.1232\.0/)
  }))

for (const [name, setup, args, re] of [
  ['Herdr: ps cannot list the herdr-core processes', (sb) => { sb.herdrCore(); sb.start('herdr'); sb.stage('herdr') }, '-A -o pid= -o ppid= -o args=',
    /- Herdr: update staged; not relaunched: ps cannot list the herdr-core processes; relaunch by hand\n/],
  ['Claude Desktop: ps cannot list the process tree', (sb) => { sb.claudeFiles(); sb.start('claude'); sb.stage('claude', '5.1232.0'); sb.shipit('claude', 1) }, '-A -o pid= -o ppid= -o comm=',
    /- Claude Desktop: update staged; not relaunched: ps failed: ps: sysctl: Operation not permitted; relaunch by hand\n/],
]) {
  test(`cannot evaluate: ${name}: not relaunched, nothing signalled, reported for a relaunch by hand`, () =>
    withSandbox({}, (sb) => {
      addStub(sb, 'ps', PS_STUB)
      setup(sb)
      const r = sb.run({ STUB_PS_FAIL: args })
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.deepEqual(sb.signals(), [])
      assert.deepEqual(called(sb, 'open'), [])
      assert.match(sb.mails()[0], /\nRelaunch by hand:\n/)
      assert.match(sb.mails()[0], re)
    }))
}

test('cannot evaluate: ps cannot list ShipIt after the quit: counts as still running; after both waits `open` runs anyway, FAILED', () =>
  withSandbox({}, (sb) => {
    addStub(sb, 'ps', PS_STUB)
    sb.start('t3')
    sb.stage('t3', '0.1.8')
    sb.shipit('t3', 1)
    const r = sb.run({ STUB_PS_FAIL: '-A -o args=' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.deepEqual(opens(sb), ['com.t3tools.t3code'])
    assertMarker(sb, /T3 Code: ShipIt did not finish within 3s \(ShipIt still runs\); started anyway/)
  }))

test('cannot evaluate: Chrome with ps failing is "could not check" (a warning), and Chrome is never signalled', () =>
  withSandbox({}, (sb) => {
    addStub(sb, 'ps', PS_STUB)
    sb.start('chrome', 'chrome:157.0.8103.40')
    const r = sb.run({ STUB_PS_FAIL: '-A -o ppid= -o args=' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /warning: Chrome: could not check \(ps failed\)/)
    assert.deepEqual(sb.signals(), [])
    assert.deepEqual(sb.mails(), [])
  }))

test('quit: kill -TERM fails (the PID is gone between lookup and signal): FAILED, never opened', () =>
  withSandbox({}, (sb) => {
    addStub(sb, 'ps', PS_STUB)
    sb.stage('t3', '0.1.8')
    // lsappinfo names a PID that no longer exists; ps still lists it as running.
    writeFileSync(join(sb.base, 'state/apps/com.t3tools.t3code'), '999999')
    const r = sb.run({ STUB_PS_GHOST: '999999' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assertMarker(sb, /T3 Code: kill -TERM 999999 failed; not relaunched/)
    assert.deepEqual(called(sb, 'open'), [])
  }))

test('busy: find cannot read ~/.claude/projects: counts as busy, so the run skips', () =>
  withSandbox({}, (sb) => {
    addStub(sb, 'find', FIND_STUB)
    mkdirSync(join(sb.home, '.claude/projects'), { recursive: true })
    const r = sb.run({ STUB_FIND_FAIL: join(sb.home, '.claude/projects') })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /skipped: busy: cannot check agent activity under ~\/\.claude\/projects \(find exit 1\)/)
    assertNoAction(sb)
    assert.equal(stampIsToday(sb), false)
  }))

test('busy: idle exactly 30 min passes; with two HIDIdleTime values the smallest counts', () =>
  withSandbox({}, (sb) => {
    let r = sb.run({ STUB_IDLE_NS: String(30 * 60e9) })
    assert.match(r.stdout, /gate passed/)
    ago(sb.stamp, DAY)
    const two = (a, b) => `+-o IOHIDSystem\n    | |     "HIDIdleTime" = ${a}\n+-o IOHIDSystem\n    | |     "HIDIdleTime" = ${b}`
    const before = called(sb, 'lsappinfo').length
    r = sb.run({ STUB_IOREG_RAW: two(7200e9, 60e9) })
    assert.match(r.stdout, /skipped: busy: keyboard or mouse used 1 min ago/)
    r = sb.run({ STUB_IOREG_RAW: two(60e9, 7200e9) })
    assert.match(r.stdout, /skipped: busy: keyboard or mouse used 1 min ago/)
    assert.equal(called(sb, 'lsappinfo').length, before, 'a busy run looked up an app')
  }))

test('cannot evaluate: a 19-digit HIDIdleTime (would overflow) counts as busy', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({ STUB_IDLE_NS: '9'.repeat(19) })
    assert.match(r.stdout, /skipped: busy: cannot read HIDIdleTime from ioreg \(exit 0\)/)
    assertNoAction(sb)
  }))

test('appcast: a SUFeedURL that is not https is never fetched; a warning only', () =>
  withSandbox({}, (sb) => {
    writeFileSync(sb.plistOf('downie'), `CFBundleIdentifier=${APPS.downie.id}\nCFBundleShortVersionString=4.13.3\nSUFeedURL=http://software.example.test/downie/v4/updates.xml\n`)
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /warning: Downie: could not check \(SUFeedURL is not https: http:\/\/software\.example\.test/)
    assert.deepEqual(called(sb, 'curl').filter((c) => !c.endsWith(GHOSTTY_FEED)), [], 'the http feed was fetched')
    assert.deepEqual(sb.mails(), [])
  }))

test('appcast: equal versions written differently (4.13.3.0) and older ones (installed 4.13.10, feed 4.13.9) are never "update available"', () =>
  withSandbox({}, (sb) => {
    sb.feed('downie', appcast('4.13.3.0'))
    let r = sb.run()
    assert.match(r.stdout, /Downie: up to date \(4\.13\.3; newest in the appcast: 4\.13\.3\.0\)/)
    ago(sb.stamp, DAY)
    sb.setVersion('downie', '4.13.10')
    sb.feed('downie', appcast('4.13.9', '4.9.99'))
    r = sb.run()
    assert.match(r.stdout, /Downie: up to date \(4\.13\.10; newest in the appcast: 4\.13\.9\)/)
    assert.deepEqual(sb.mails(), [])
  }))

test('appcast: the measured Downie feed shape (one item, minimumSystemVersion element) parses', () =>
  withSandbox({}, (sb) => {
    // Shape of software.charliemonroe.net/trial/downie/v4/updates.xml on 2026-11-11.
    sb.feed('downie', '<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:dc="http://purl.org/dc/elements/1.1/">\n<channel>\n<title>Downie 4</title>\n<item>\n<title>Version 4.13.4</title>\n<sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>\n<enclosure url="https://x.test/Downie.dmg" sparkle:version="5300" sparkle:shortVersionString="4.13.4" length="1" type="application/octet-stream" />\n</item>\n</channel>\n</rss>\n')
    const r = sb.run()
    assert.match(sb.mails()[0], /- Downie: update available \(4\.13\.3 -> 4\.13\.4\); relaunch by hand\n/, r.stdout)
  }))

test('mail: a hostname with a newline cannot inject a header (the header block stays From, To, Subject)', () =>
  withSandbox({}, (sb) => {
    addStub(sb, 'hostname', '#!/bin/sh\nprintf "evil\\nBcc: attacker@example.com\\n"\n')
    sb.start('chrome', 'chrome:157.0.8103.40')
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const m = sb.mails()[0]
    const headers = m.split('\n\n')[0].split('\n')
    assert.deepEqual(headers.map((h) => h.split(':')[0]), ['From', 'To', 'Subject'], JSON.stringify(m))
    assert.doesNotMatch(m, /^Bcc:/m)
  }))

test('stale: a marker already showing (an earlier failure) is kept, and no stall mail goes out', () =>
  withSandbox({}, (sb) => {
    ago(sb.stamp, 8 * DAY)
    writeFileSync(sb.marker, 'earlier failure\n')
    const r = sb.run({ STUB_LOAD5: '9.00' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.equal(readFileSync(sb.marker, 'utf8'), 'earlier failure\n')
    assert.deepEqual(sb.mails(), [])
  }))

// --- Rework: apps left down, the kept log, repeat mails, Ghostty's feed -------------------

const downFile = (sb) => join(sb.logs, 'app-update.down')

for (const [how, env] of [['`open` fails', { STUB_OPEN_FAIL: 'com.t3tools.t3code' }], ['the app does not come back', { STUB_NOAPP: 'com.t3tools.t3code' }]]) {
  test(`left down (${how}): night 1 FAILED and listed; night 2, with only warnings otherwise, still FAILED and mailed; once it runs, cleared`, () =>
    withSandbox({}, (sb) => {
      sb.start('t3')
      sb.stage('t3', '0.1.8')
      sb.shipit('t3', 1)
      let r = sb.run(env)
      assert.equal(r.status, 1, r.stdout + r.stderr)
      const line = readFileSync(downFile(sb), 'utf8')
      assert.match(line, /^com\.t3tools\.t3code \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n$/)
      const when = line.trim().split(' ').slice(1).join(' ')

      // Night 2: nothing else to report but warnings (every feed fails).
      ago(sb.stamp, DAY)
      r = sb.run({ STUB_CURL_FAIL: '1' })
      assert.equal(r.status, 1, r.stdout + r.stderr)
      assertMarker(sb, new RegExp(`T3 Code: still not running since ${when}; the job quit it`))
      const m = sb.mails()
      assert.equal(m.length, 2)
      assert.equal(subject(m[1]), 'App updates on testhost: FAILED')
      assert.match(m[1], /\nFailed:\n- T3 Code: still not running since /)
      assert.equal(readFileSync(downFile(sb), 'utf8'), line, 'the down list changed')

      // Night 3: someone started it again.
      sb.start('t3')
      ago(sb.stamp, DAY)
      r = sb.run()
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.match(r.stdout, /T3 Code: runs again \(the job left it down at /)
      assert.equal(existsSync(downFile(sb)), false)
      assert.equal(existsSync(sb.marker), false)
    }))
}

test('left down: an app that the job brought back is never listed', () =>
  withSandbox({}, (sb) => {
    sb.start('t3')
    sb.stage('t3', '0.1.8')
    sb.shipit('t3', 1)
    assert.equal(sb.run().status, 0)
    assert.equal(existsSync(downFile(sb)), false)
  }))

test('log: the run that does the pass empties app-update.log; a later "already ran today" run leaves it alone', () =>
  withSandbox({}, (sb) => {
    const log = join(sb.logs, 'app-update.log')
    writeFileSync(log, 'last night\n')
    let r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.equal(readFileSync(log, 'utf8'), '', 'the pass did not start a fresh log')
    assert.match(r.stdout, /^app-update: run at \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/m)
    writeFileSync(log, 'tonight\'s pass\n')
    r = sb.run({}, { hour: '04' })
    assert.match(r.stdout, /already ran today/)
    assert.equal(readFileSync(log, 'utf8'), 'tonight\'s pass\n')
    r = sb.run({}, { hour: '09' })
    assert.equal(readFileSync(log, 'utf8'), 'tonight\'s pass\n')
  }))

test('repeat mail: the same "relaunch by hand" list on a later night sends no mail; a new item, a change, or a failure does', () =>
  withSandbox({}, (sb) => {
    const night = (env) => { ago(sb.stamp, DAY); return sb.run(env) }
    sb.feed('downie', appcast('4.13.4'))
    let r = sb.run()
    assert.equal(sb.mails().length, 1)

    writeFileSync(sb.marker, 'a marker from before\n')
    r = night()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /the same items as the last mail need a hand; no mail/)
    assert.equal(sb.mails().length, 1, 'two nights with Downie 4.13.4 available sent two mails')
    assert.equal(readFileSync(sb.marker, 'utf8'), 'a marker from before\n')
    rmSync(sb.marker)

    sb.start('chrome', 'chrome:157.0.8103.40')
    night()
    assert.equal(sb.mails().length, 2, 'a new item (Chrome) sent no mail')

    sb.start('t3')
    sb.stage('t3', '0.1.8')
    sb.shipit('t3', 1)
    night()
    assert.equal(sb.mails().length, 3, 'a change sent no mail')
    assert.match(sb.mails()[2], /- Downie: update available/)

    night()
    assert.equal(sb.mails().length, 3)

    // Everything current: the list is cleared, so the same item later mails again.
    sb.feed('downie', appcast('4.13.3'))
    process.kill(sb.pidOf('chrome'), 'SIGKILL')
    night()
    assert.equal(sb.mails().length, 3)
    assert.equal(existsSync(join(sb.logs, 'app-update.reported')), false)
    sb.feed('downie', appcast('4.13.4'))
    night()
    assert.equal(sb.mails().length, 4)

    // A failure always mails, also with the same list.
    sb.stage('t3', '0.1.9')
    sb.shipit('t3', 1)
    r = night({ STUB_OPEN_FAIL: 'com.t3tools.t3code' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.equal(sb.mails().length, 5, 'a failure sent no mail')
  }))

test('repeat mail: when the mail fails, the list is not recorded, so the next night mails it', () =>
  withSandbox({}, (sb) => {
    sb.feed('downie', appcast('4.13.4'))
    assert.equal(sb.run({ STUB_MAIL_RC: '1' }).status, 1)
    assert.equal(existsSync(join(sb.logs, 'app-update.reported')), false)
    ago(sb.stamp, DAY)
    assert.equal(sb.run().status, 0)
    assert.equal(sb.mails().length, 1)
  }))

test('Ghostty: no SUFeedURL, so its published feed is fetched; a newer version there is reported', () =>
  withSandbox({}, (sb) => {
    sb.feed('ghostty', ghosttyAppcast('1.4.0', '1.4.1'))
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.ok(called(sb, 'curl').includes(`curl -fsSL --max-time 20 ${GHOSTTY_FEED}`), called(sb, 'curl').join('\n'))
    assert.deepEqual(sb.signals(), [])
    assert.match(sb.mails()[0], /- Ghostty: update available \(1\.4\.0 -> 1\.4\.1\); relaunch by hand \(the job never quits Ghostty: a quit closes its shells\)\n/)
  }))

test('Ghostty: the build label "663205b5 (2024-12-20)" is never a version, also when it is the only entry', () =>
  withSandbox({}, (sb) => {
    sb.feed('ghostty', ghosttyAppcast())
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /warning: Ghostty: could not check \(no dotted version number in the appcast at https:\/\/release\.files\.ghostty\.org\/appcast\.xml\)/)
    assert.deepEqual(sb.mails(), [])
  }))

test('appcast: each feed is fetched once; Downie, which has a SUFeedURL, never gets the fallback', () =>
  withSandbox({}, (sb) => {
    sb.run()
    assert.deepEqual(called(sb, 'curl'), [`curl -fsSL --max-time 20 ${APPS.downie.feed}`, `curl -fsSL --max-time 20 ${GHOSTTY_FEED}`])
  }))
