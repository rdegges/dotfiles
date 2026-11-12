// The shared text helper for the ~/.cron jobs (dot_cron/lib/text.sh), the lint
// that keeps every job on it, the loader each job that calls oneline uses, and
// the failure banner in dot_zshrc that prints the markers.
//
// Run from the repo root (zsh is needed for the banner test, chezmoi for the
// deploy test):
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'apt-get update -qq && apt-get install -y -qq zsh >/dev/null &&
//      sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin &&
//      node --test tests/cron/'
//
// What a pass proves:
//   - oneline, under dash (sh), dash, and bash --posix -O xpg_echo with this
//     image's GNU sed, tr, and cut, turns each hostile input and each of 500
//     fixed-seed fuzz inputs (bytes 1-255, length 0-2000) into one line of
//     printable ASCII of at most 300 bytes, equal to the reference model
//     below, with no locale set and under LANG=C.UTF-8. CSI (`38:5:196`, `>4;2`, `3~` included), OSC ending in BEL or ST
//     (titles, OSC 8 links), and ESC ( B, ESC 7, ESC = leave no fragment;
//     bracketed text with no ESC stays; backslashes, `%`, and `-n` stay literal.
//   - lines, under the same shells and locales, turns each multi-line hostile
//     input, every byte 0x01-0xff, and each of 500 fixed-seed fuzz inputs into
//     lines that each match ^[ -~]{0,300}$, equal to oneline's model applied to
//     each line: the newlines stay, and the escape sequences of each line leave
//     no fragment. On one line of input it gives what oneline gives.
//   - Sourcing the lib sets only esc and bel, defines only oneline and lines,
//     and changes no `set` option. chezmoi deploys it to ~/.cron/lib/text.sh on
//     every machine, homelab or not.
//   - The lint: no file under dot_cron/ (lib/ excepted, .tmpl included) uses
//     echo, a printf whose format is not one single-quoted literal, tr -c,
//     cut -c, an ESC literal, esc= or bel=, or its own oneline() or lines(); a
//     file that calls oneline or lines has the loader, after `marker=` and
//     before the first call. It scans every file, and all eight current jobs
//     by name.
//   - The loader, in cf-update, rea-update, and tailscale-watchdog under sh
//     (dash) and bash --posix -O xpg_echo: a missing, unreadable, or
//     unparsable lib writes the job's marker ("cannot load") and exits 1.
//     An empty lib, or one cut short before oneline, still leaves the failure
//     reason in the cf and rea markers; with the real lib the first-step reason
//     reaches the marker.
//   - The banner removes every control character but newline from a marker
//     (ESC, BEL, CR, tab), keeps a multi-line marker's lines, and adds only its
//     own two color codes.
//     Under LANG=C.UTF-8 it also removes the C1 controls, NUL, and DEL.
//
// What a pass does not prove:
//   - That every untrusted value that reaches a marker or a mail went through
//     oneline. The lint finds private cleaning code, not a raw "$out" in a
//     marker; the banner keeps such a slip from reaching the terminal as an
//     escape sequence.
//   - BSD sed, tr, and cut (macOS). The rollout probe runs the lib under the
//     real /bin/sh on a Mac.
//   - That lines removes an escape sequence that a newline splits: each line
//     is cleaned alone, so its ESC goes and the rest stays as text.
//   - macOS /bin/sh (bash 3.2) running the loader, or the real launchd.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, chmodSync, chownSync, rmSync, readdirSync, statSync, copyFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const ROOT = new URL('../../', import.meta.url)
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8')
const LIB = new URL('dot_cron/lib/text.sh', ROOT).pathname
const SYS_PATH = '/usr/bin:/bin'
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0

const SHELLS = [
  ['sh', ['sh']],
  ['dash', ['dash']],
  ['bash --posix -O xpg_echo', ['bash', '--posix', '-O', 'xpg_echo']],
]
const skipFor = (argv) => (has(argv[0]) ? false : `${argv[0]} not installed`)

// --- oneline: reference model and runner ---------------------------------------

// What oneline must print, on latin1 strings (one char per byte). Each regex
// has disjoint character classes, so JS leftmost-first and POSIX
// leftmost-longest find the same matches; sed runs the expressions in order,
// each over the whole line, as these replaces do.
const reference = (s) =>
  s
    .replace(/[\n\t\r]/g, ' ')
    .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '')
    .replace(/\x1b\][^\x07\x1b]*\x07/g, '')
    .replace(/\x1b\][^\x07\x1b]*\x1b\\/g, '')
    .replace(/\x1b[\x20-\x2f]*[\x30-\x7e]/g, '')
    .replace(/[^\x20-\x7e]/g, '')
    .slice(0, 300)

// Runs `oneline "$(cat <file>)"` once per input, in one shell process, the
// way the jobs call it. Inputs are Buffers or latin1 strings; outputs are
// latin1 strings. $(cat) drops trailing newlines, as the jobs' $(cmd) does.
function runOneline(shell, inputs, env = {}, fn = 'oneline') {
  const dir = mkdtempSync(join(tmpdir(), 'text-lib-'))
  try {
    inputs.forEach((s, i) => writeFileSync(join(dir, `${String(i).padStart(4, '0')}.in`), typeof s === 'string' ? Buffer.from(s, 'latin1') : s))
    const script = `. "$1" || exit 99\nfor f in "$2"/*.in; do out=$(${fn} "$(cat "$f")"); printf '%s' "$out" > "\${f%.in}.out"; done\n`
    const r = spawnSync(shell[0], [...shell.slice(1), '-c', script, 'sh', LIB, dir], { encoding: 'utf8', env: { PATH: SYS_PATH, ...env } })
    assert.equal(r.status, 0, r.stderr)
    return inputs.map((_, i) => readFileSync(join(dir, `${String(i).padStart(4, '0')}.out`), 'latin1'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const ONE_LINE = /^[ -~]{0,300}$/

// Captured from the real himalaya 1.2.0 (see tests/cron/tailscale-watchdog.test.mjs).
const HIMALAYA_COLORED_CONFIG_ERROR =
  'Error: \n   0: \x1b[91mcannot find configuration for account icloud\x1b[0m\n\n' +
  '\x1b[96mNote\x1b[0m: Run with --debug to enable logs with spantrace.\n' +
  '\x1b[96mNote\x1b[0m: Run with --trace to enable verbose logs with backtrace.\n'

// [name, input (latin1), exact output]
const CORPUS = [
  ['a real colored himalaya config error', HIMALAYA_COLORED_CONFIG_ERROR,
    'Error:     0: cannot find configuration for account icloud  Note: Run with --debug to enable logs with spantrace. Note: Run with --trace to enable verbose logs with backtrace.'],
  ['heavily colored text keeps all 300 visible characters', Array.from({ length: 400 }, () => '\x1b[1;31mv\x1b[0m').join(''), 'v'.repeat(300)],
  ['bracketed text with no ESC stays', 'bad value [31m in [0m and [?25l, kept', 'bad value [31m in [0m and [?25l, kept'],
  ['CSI with ":" and ">" parameters', '\x1b[38:5:196mred\x1b[0m and \x1b[4:3mwavy\x1b[4:0m and \x1b[>4;2mkeys\x1b[>4m', 'red and wavy and keys'],
  ['CSI ending in ~, and one with an intermediate byte', 'a\x1b[3~b\x1b[1 qc', 'abc'],
  ['ESC ( B', 'a\x1b(Bb\x1b[mc', 'abc'],
  ['OSC title ending in BEL', 'a\x1b]0;title\x07b', 'ab'],
  ['OSC 8 hyperlink ending in ST', 'a\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\b', 'alinkb'],
  ['ESC 7 and ESC 8', 'a\x1b7b\x1b8c', 'abc'],
  ['ESC = and ESC >', 'a\x1b=b\x1b>c', 'abc'],
  ['CRLF lines', 'line1\r\nline2\r\n', 'line1  line2 '],
  ['tabs', 'a\tb\t\tc', 'a b  c'],
  ['invalid UTF-8 and a valid multi-byte character', 'a\xffb\xc3(c\xe2\x98\x81d', 'ab(cd'],
  ['a 1000-character input is cut to 300', 'x'.repeat(999) + 'Z', 'x'.repeat(300)],
  ['backslashes and % stay literal', 'a \\n b \\c c %s %n \\033', 'a \\n b \\c c %s %n \\033'],
  ['text starting with -n', '-n foo', '-n foo'],
  ['text starting with -e', '-e \\t bar', '-e \\t bar'],
  ['empty input', '', ''],
  ['the rollout probe', 'a\x1b[38:5:196mb\x1b[>4;2mc\x1b[1;31md\x1b[0me[31mf\r\tg\x1b(Bh\x1b]0;t\x07i\x1b]8;;http://x\x1b\\j\x1b]8;;\x1b\\k', 'abcde[31mf  ghijk'],
]

// Every byte 0x01-0xff once, in order.
const ALL_BYTES = Buffer.from(Array.from({ length: 255 }, (_, i) => i + 1))

// mulberry32: a small fixed-seed PRNG, so a failure reproduces.
function prng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 500 inputs of 0-2000 bytes in 1-255. Every other one draws from bytes that
// make escape sequences (ESC, [, ], BEL, \, parameter, intermediate, and final
// bytes), which uniform bytes almost never put together.
const ESCAPEY = Buffer.from('\x1b\x1b\x1b[[]]\x07\\0123456789:;<=>? !"#/(@ABmqz~\r\n\t\x7f\x80\x9b\xff', 'latin1')
const FUZZ = (() => {
  const rnd = prng(0x5eed)
  return Array.from({ length: 500 }, (_, i) => {
    const len = Math.floor(rnd() * 2001)
    const b = Buffer.alloc(len)
    for (let j = 0; j < len; j++) b[j] = i % 2 ? ESCAPEY[Math.floor(rnd() * ESCAPEY.length)] : 1 + Math.floor(rnd() * 255)
    return b
  })
})()

for (const [name, shell] of SHELLS) {
  test(`[${name}] oneline: each hostile input gives the exact clean line`, { skip: skipFor(shell) }, () => {
    const outs = runOneline(shell, CORPUS.map(([, input]) => input))
    CORPUS.forEach(([what, input, want], i) => {
      assert.equal(outs[i], want, `${what}: ${JSON.stringify(outs[i])}`)
      assert.equal(outs[i], reference(input.replace(/\n+$/, '')), `${what}: the reference model disagrees`)
    })
  })

  test(`[${name}] oneline: every byte 0x01-0xff gives three spaces and the printable ASCII range`, { skip: skipFor(shell) }, () => {
    const [out] = runOneline(shell, [ALL_BYTES])
    const printable = Array.from({ length: 95 }, (_, i) => String.fromCharCode(0x20 + i)).join('')
    assert.equal(out, '   ' + printable, JSON.stringify(out))
    assert.match(out, ONE_LINE)
  })

  test(`[${name}] oneline: 500 fixed-seed fuzz inputs are each one printable-ASCII line of at most 300 bytes, equal to the model`, { skip: skipFor(shell) }, () => {
    const outs = runOneline(shell, FUZZ)
    FUZZ.forEach((input, i) => {
      assert.match(outs[i], ONE_LINE, `fuzz input ${i}: ${JSON.stringify(outs[i])}`)
      assert.equal(outs[i], reference(input.toString('latin1').replace(/\n+$/, '')), `fuzz input ${i}`)
    })
  })

  // A job run from a shell (the run_onchange installs) inherits a UTF-8 locale;
  // cron and launchd set none. The output must not change.
  test(`[${name}] oneline: under LANG=C.UTF-8 the corpus and the fuzz inputs give the same lines`, { skip: skipFor(shell) }, () => {
    const inputs = [...CORPUS.map(([, input]) => input), ALL_BYTES, ...FUZZ]
    assert.deepEqual(runOneline(shell, inputs, { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }), runOneline(shell, inputs))
  })
}

// --- lines: oneline's rules on each line, newlines kept -----------------------------

const runLines = (shell, inputs, env = {}) => runOneline(shell, inputs, env, 'lines')

// What lines must print: the oneline model on each line. $(lines ...) drops
// the trailing newlines, as the jobs' $(cmd) does.
const referenceLines = (s) => s.split('\n').map(reference).join('\n').replace(/\n+$/, '')
const linesOk = (out) => out.split('\n').every((l) => ONE_LINE.test(l))

// [name, input (latin1), exact output]
const LINES_CORPUS = [
  ['the real colored himalaya error keeps its lines', HIMALAYA_COLORED_CONFIG_ERROR,
    'Error: \n   0: cannot find configuration for account icloud\n\nNote: Run with --debug to enable logs with spantrace.\nNote: Run with --trace to enable verbose logs with backtrace.'],
  ['CSI, OSC, and other ESC forms on separate lines',
    'a\x1b[38:5:196mb\x1b[>4;2mc\nd\x1b]0;t\x07e\x1b]8;;http://x\x1b\\f\x1b]8;;\x1b\\g\nh\x1b(Bi\x1b7j\x1b=k\x1b[3~l\x1b[1 qm',
    'abc\ndefg\nhijklm'],
  ['bracketed text with no ESC stays on its line', 'x [31m y\n[0m\n[?25l', 'x [31m y\n[0m\n[?25l'],
  ['CRLF and tabs: CR and tab become spaces, the lines stay', 'one\r\ntwo\tthree\r\n\tfour', 'one \ntwo three \n four'],
  ['each line is cut at 300, not the whole text', 'x'.repeat(400) + '\n\x1b[31m' + 'y'.repeat(400) + '\x1b[0m\nz', 'x'.repeat(300) + '\n' + 'y'.repeat(300) + '\nz'],
  ['heavily colored lines keep 300 visible characters each', [1, 2].map(() => Array.from({ length: 400 }, () => '\x1b[1;31mv\x1b[0m').join('')).join('\n'), 'v'.repeat(300) + '\n' + 'v'.repeat(300)],
  ['empty lines in the middle stay; trailing ones go', 'a\n\n\nb\n\n', 'a\n\n\nb'],
  ['invalid UTF-8 and multi-byte characters', 'a\xffb\n\xc3(c\xe2\x98\x81d', 'ab\n(cd'],
  ['backslashes, %, and -n stay literal', '-n \\c %s\n-e \\t %b \\033', '-n \\c %s\n-e \\t %b \\033'],
  ['an escape sequence split by a newline: the ESC goes, the rest is text', 'a\x1b[3\n1mb', 'a3\n1mb'],
  ['the rollout probe', 'a\x1b[38:5:196mb\r\nc\x1b]0;t\x07d\n[31me', 'ab \ncd\n[31me'],
  ['empty input', '', ''],
]

for (const [name, shell] of SHELLS) {
  test(`[${name}] lines: each multi-line hostile input gives the exact clean lines`, { skip: skipFor(shell) }, () => {
    const outs = runLines(shell, LINES_CORPUS.map(([, input]) => input))
    LINES_CORPUS.forEach(([what, input, want], i) => {
      assert.equal(outs[i], want, `${what}: ${JSON.stringify(outs[i])}`)
      assert.equal(outs[i], referenceLines(input.replace(/\n+$/, '')), `${what}: the reference model disagrees`)
      assert.ok(linesOk(outs[i]), `${what}: ${JSON.stringify(outs[i])}`)
    })
  })

  test(`[${name}] lines: every byte 0x01-0xff gives two lines, the second the printable ASCII range`, { skip: skipFor(shell) }, () => {
    const [out] = runLines(shell, [ALL_BYTES])
    const printable = Array.from({ length: 95 }, (_, i) => String.fromCharCode(0x20 + i)).join('')
    // 0x09 (tab) becomes a space and 0x0a ends the line; 0x0d (CR) becomes a space.
    assert.equal(out, ' \n ' + printable, JSON.stringify(out))
    assert.ok(linesOk(out))
  })

  test(`[${name}] lines: 500 fixed-seed fuzz inputs give lines that each match ^[ -~]{0,300}$, equal to the model`, { skip: skipFor(shell) }, () => {
    const outs = runLines(shell, FUZZ)
    FUZZ.forEach((input, i) => {
      assert.ok(linesOk(outs[i]), `fuzz input ${i}: ${JSON.stringify(outs[i])}`)
      assert.equal(outs[i], referenceLines(input.toString('latin1').replace(/\n+$/, '')), `fuzz input ${i}`)
    })
  })

  test(`[${name}] lines: under LANG=C.UTF-8 the corpus and the fuzz inputs give the same lines`, { skip: skipFor(shell) }, () => {
    const inputs = [...LINES_CORPUS.map(([, input]) => input), ALL_BYTES, ...FUZZ]
    assert.deepEqual(runLines(shell, inputs, { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }), runLines(shell, inputs))
  })

  test(`[${name}] lines: on one line of input it gives what oneline gives`, { skip: skipFor(shell) }, () => {
    const inputs = [...CORPUS.map(([, input]) => input), ...FUZZ.map((b) => b.toString('latin1'))].map((x) => x.replace(/\n/g, ''))
    assert.deepEqual(runLines(shell, inputs), runOneline(shell, inputs))
  })
}

// --- The lib's own shape ----------------------------------------------------------

test('lib: sourcing it under sh sets only esc and bel, defines oneline and lines, and changes no set option', () => {
  const script =
    'vars() { set | sed -n "s/^\\([A-Za-z_][A-Za-z_0-9]*\\)=.*/\\1/p" | sort; }\n' +
    'vars > "$2/v0"; set -o > "$2/o0"\n' +
    '. "$1"\n' +
    'vars > "$2/v1"; set -o > "$2/o1"\n' +
    'command -v oneline && command -v lines\n'
  const dir = mkdtempSync(join(tmpdir(), 'text-lib-shape-'))
  try {
    const r = spawnSync('sh', ['-c', script, 'sh', LIB, dir], { encoding: 'utf8', env: { PATH: SYS_PATH } })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(r.stdout.trim().split('\n'), ['oneline', 'lines'])
    const v0 = readFileSync(join(dir, 'v0'), 'utf8').split('\n')
    const added = readFileSync(join(dir, 'v1'), 'utf8').split('\n').filter((v) => !v0.includes(v) && v !== '_')
    assert.deepEqual(added, ['bel', 'esc'])
    assert.equal(readFileSync(join(dir, 'o1'), 'utf8'), readFileSync(join(dir, 'o0'), 'utf8'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lib: the source is dot_cron/lib/text.sh alone, not executable, and parses under sh -n', () => {
  assert.deepEqual(readdirSync(new URL('dot_cron/lib/', ROOT)), ['text.sh'])
  assert.equal(statSync(LIB).mode & 0o111, 0, 'the source file is executable')
  const r = spawnSync('sh', ['-n', LIB], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(read('.chezmoiignore'), /\.cron\/lib|lib\/text/)
})

for (const extra of [{}, { homelab: false }, { homelab: true }]) {
  test(`deploy: chezmoi manages ~/.cron/lib/text.sh on a Mac with ${JSON.stringify(extra)}`, () => {
    const home = mkdtempSync(join(tmpdir(), 'text-lib-home-'))
    try {
      const data = JSON.stringify({ work: false, chezmoi: { os: 'darwin' }, ...extra })
      const r = spawnSync('chezmoi', ['--source', ROOT.pathname, '--destination', home, '--override-data', data, 'managed', '--include=files'], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: home },
      })
      assert.ifError(r.error)
      assert.equal(r.status, 0, r.stderr)
      assert.ok(r.stdout.split('\n').includes('.cron/lib/text.sh'), r.stdout)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
}

// --- Lint: no job prints with echo or cleans text itself -------------------------
//
// What a pass proves: no file under dot_cron/ (lib/ excepted) uses echo, a
// printf with a non-literal format or a %b format, or private cleaning code
// (tr -c, cut -c, cut -b, head -c, an ESC literal, esc=/bel=, its own
// oneline or lines), and every file that calls oneline or lines loads the lib
// with the loader.
// It checks non-comment lines only (a line whose first non-blank character
// is #).
// What it does not prove: that every untrusted value reaching a marker or a
// mail went through oneline. The banner covers the terminal for that gap.

const RULES = [
  ['echo', /\becho\b/],
  ['a printf whose format is not one single-quoted literal', /\bprintf\b(?!\s+'[^']*'(?=[\s;|&)>]|$))/],
  ['tr -c or tr -cd', /\btr\s+(-\S+\s+)*-[A-Za-z]*[cC]/],
  ['cut -c', /\bcut\s+(-\S+\s+)*-[A-Za-z]*c/],
  ['an ESC literal (\\033, \\33, \\x1b, \\e, or the byte)', /\\0?33(?![0-9])|\\x1[bB]|\\e|\x1b/],
  ['printf %b', /\bprintf\b\s+'[^']*%b/],
  ['cut -b or head -c', /\bcut\s+(-\S+\s+)*-[A-Za-z]*b|\bhead\s+(-\S+\s+)*-[A-Za-z]*c/],
  ['esc= or bel=', /\b(esc|bel)=/],
  ['a oneline() or lines() definition', /\b(oneline|lines)\s*\(\s*\)|\bfunction\s+(oneline|lines)\b/],
]
const violations = (line) => RULES.filter(([, re]) => re.test(line)).map(([what]) => what)
const codeLines = (src) =>
  src.split('\n').map((text, i) => ({ n: i + 1, text })).filter(({ text }) => !text.trimStart().startsWith('#'))

// A call of a lib function. `lines` is also a common word, so only `lines "` counts.
const CALLS = /\boneline\b|\blines\s+"/

// The loader every job that calls oneline or lines runs; <job> is the job's name.
const LOADER = [
  'lib="$(dirname "$0")/lib/text.sh"',
  'if [ -r "$lib" ] && sh -n "$lib" 2>/dev/null && command . "$lib" && command -v oneline >/dev/null 2>&1; then :; else',
  "    printf '%s\\n' \"<job>: cannot load $lib\"",
  '    mkdir -p "${marker%/*}"',
  "    printf '%s\\n' \"$(date '+%F %R') <job>: cannot load ~/.cron/lib/text.sh; run chezmoi apply\" > \"$marker\"",
  '    exit 1',
  'fi',
]
// The first <job> captures the name; the second must be the same.
const loaderRe = new RegExp(
  '^' + LOADER.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\n').replace('<job>', '([a-z-]+)').replace('<job>', '\\1') + '$',
  'm',
)

const CRON = new URL('dot_cron/', ROOT).pathname
function cronFiles(dir = CRON) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return relative(CRON, p) === 'lib' ? [] : cronFiles(p)
    return [relative(CRON, p)]
  })
}

test('lint: the rules catch each banned form and pass the allowed ones', () => {
  const bad = [
    'echo hi', '    [ -n "$x" ] && echo "$x"', 'printf "$x"', 'printf "%s\\n" x', "printf '%s'\"$x\" y", 'printf $fmt', 'printf \\',
    "LC_ALL=C tr -cd '\\40-\\176'", 'tr -c a b', 'tr -dc a', 'tr -C a b', 'cut -c1-300', 'LC_ALL=C cut -b1 -c2',
    "x=$(printf '\\033')", 'a\\x1bb', 'a\\x1Bb', "printf '\\e[0m'", 'a\x1bb', 'esc=1', '  bel=$(x)', 'oneline() {', 'oneline () {', 'function oneline {',
    "printf '%b\\n' \"$x\"", "x=$(printf '\\33')", 'cut -b1-300', 'head -c 300', 'lines() {', 'function lines {',
  ]
  for (const l of bad) assert.notDeepEqual(violations(l), [], `not caught: ${l}`)
  const good = [
    "printf '%s\\n' \"a $b\"", "printf '%s' \"$msg\" | run 60 himalaya", "msg=$(printf 'From: %s\\nTo: %s\\n' \"$r\" \"$r\")",
    "n=$(git diff --cached --name-only | wc -l | tr -d ' ')", "tr '\\n' ' '", 'x=$(oneline "$out")', 'cut -f1 -d:',
    "x=$(lines \"$out\" | sed 's/^/  | /')", 'lastlines() {',
  ]
  for (const l of good) assert.deepEqual(violations(l), [], `false positive: ${l}`)
})

test('lint: every dot_cron file (lib/ excepted) is clean, and oneline callers load the lib first', () => {
  const files = cronFiles()
  assert.ok(files.length > 0, 'the lint scanned no files')
  for (const job of ['app-update', 'cf-update', 'chezmoi-update', 'rea-update', 'tailscale-watchdog', 'vault-snapshot', 'wait-for-network']) {
    assert.ok(files.includes(`executable_${job}.sh`), `${job} not scanned: ${files.join(', ')}`)
  }
  assert.ok(files.includes('executable_claude-remote-control.sh.tmpl'), `claude-remote-control not scanned: ${files.join(', ')}`)
  const found = []
  for (const f of files) {
    const src = readFileSync(join(CRON, f), 'utf8')
    const lines = codeLines(src)
    for (const { n, text } of lines) for (const what of violations(text)) found.push(`${f}:${n}: ${what}: ${text.trim()}`)
    const calls = lines.filter(({ text }) => CALLS.test(text))
    if (calls.length === 0) continue
    const m = src.match(loaderRe)
    if (!m) {
      found.push(`${f}: calls oneline without the loader`)
      continue
    }
    if (f !== `executable_${m[1]}.sh` && f !== `executable_${m[1]}.sh.tmpl`) found.push(`${f}: the loader names the job ${m[1]}`)
    const at = src.slice(0, m.index).split('\n').length
    const markerAt = lines.find(({ text }) => /^marker=/.test(text))
    if (!markerAt || markerAt.n > at) found.push(`${f}: marker is not assigned before the loader`)
    if (calls[0].n < at) found.push(`${f}:${calls[0].n}: oneline is called before the loader`)
  }
  assert.deepEqual(found, [])
})

test('lint: the jobs that call oneline or lines are exactly app-update, cf-update, claude-remote-control, rea-update, and tailscale-watchdog', () => {
  const callers = cronFiles().filter((f) => codeLines(readFileSync(join(CRON, f), 'utf8')).some(({ text }) => CALLS.test(text)))
  assert.deepEqual(callers.sort(), ['executable_app-update.sh', 'executable_cf-update.sh', 'executable_claude-remote-control.sh.tmpl', 'executable_rea-update.sh', 'executable_tailscale-watchdog.sh'])
})

// --- Loader: a missing or broken lib fails closed with a marker ------------------

const JOBS = [
  ['cf-update', 'cf.FAILED'],
  ['rea-update', 'rea.FAILED'],
  ['tailscale-watchdog', 'tailscale-watchdog.FAILED'],
]
const LOADER_SHELLS = [['sh', ['sh']], ['bash --posix -O xpg_echo', ['bash', '--posix', '-O', 'xpg_echo']]]
// Docker runs as root, and root reads a mode-000 file: run that case as nobody.
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0
const NOBODY = 65534

function chownTree(p, id) {
  chownSync(p, id, id)
  if (statSync(p).isDirectory()) for (const e of readdirSync(p)) chownTree(join(p, e), id)
}

// A copy of the job in an empty dir, with lib/text.sh as `libCase` says:
// 'ok' (the real lib), 'missing', 'unreadable' (mode 000), or 'syntax'.
function loaderRun(job, libCase, shell) {
  const base = mkdtempSync(join(tmpdir(), 'text-lib-loader-'))
  try {
    const dir = join(base, 'cron')
    const home = join(base, 'home')
    mkdirSync(dir)
    mkdirSync(home)
    const script = join(dir, `${job}.sh`)
    copyFileSync(new URL(`dot_cron/executable_${job}.sh`, ROOT), script)
    chmodSync(script, 0o755)
    if (libCase !== 'missing') {
      mkdirSync(join(dir, 'lib'))
      const lib = join(dir, 'lib', 'text.sh')
      if (libCase === 'syntax') writeFileSync(lib, 'oneline() {\n    printf "%s" "$1"\n')
      else if (libCase === 'empty') writeFileSync(lib, '')
      // Parses and sources fine, but stops before oneline (a cut-short copy).
      else if (libCase === 'no-oneline') writeFileSync(lib, readFileSync(LIB, 'utf8').split('\noneline()')[0])
      else copyFileSync(LIB, lib)
      if (libCase === 'unreadable') chmodSync(lib, 0o000)
    }
    const ids = {}
    if (asRoot && libCase === 'unreadable') {
      chmodSync(base, 0o755)
      chownTree(base, NOBODY)
      ids.uid = NOBODY
      ids.gid = NOBODY
    }
    const r = spawnSync(shell[0], [...shell.slice(1), script], {
      encoding: 'utf8',
      ...ids,
      // No npm, cf, rea, or Tailscale CLI: past the loader each job fails at its first step.
      env: { HOME: home, PATH: SYS_PATH, WAIT_FOR_NETWORK: 'true', TAILSCALE_CLI: join(base, 'no-cli'), TAILSCALE_WATCHDOG_WAIT: '0' },
    })
    const logs = join(home, '.cron', 'logs')
    const markers = existsSync(logs) ? readdirSync(logs).filter((f) => f.endsWith('.FAILED')) : []
    const text = Object.fromEntries(markers.map((f) => [f, readFileSync(join(logs, f), 'utf8')]))
    return { r, markers, read: (f) => text[f] }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

for (const [name, shell] of LOADER_SHELLS) {
  for (const [job, marker] of JOBS) {
    for (const libCase of ['missing', 'unreadable', 'syntax']) {
      test(`[${name}] loader: ${job} with a ${libCase} lib writes ${marker} ("cannot load") and exits 1`, { skip: skipFor(shell) }, () => {
        const { r, markers, read: readMarker } = loaderRun(job, libCase, shell)
        assert.equal(r.status, 1, r.stdout + r.stderr)
        assert.match(r.stdout, new RegExp(`^${job}: cannot load .*/lib/text\\.sh$`, 'm'))
        assert.deepEqual(markers, [marker])
        assert.match(readMarker(marker), new RegExp(`^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} ${job}: cannot load ~/\\.cron/lib/text\\.sh; run chezmoi apply\\n$`))
      })
    }

    // An empty lib, or one cut short before oneline, parses under sh -n and
    // sources fine, so the loader lets it through. cf-update and rea-update
    // then pass their whole failure reason through the missing oneline, and
    // the marker loses it ("update failed:  (see ...)"). Whatever the fix
    // (the loader checks that oneline is defined, or fail() keeps the reason),
    // the marker must still say why the job failed. Past the loader both jobs
    // fail at "npm not found on PATH" (no npm in this PATH).
    if (job !== 'tailscale-watchdog') {
      for (const libCase of ['empty', 'no-oneline']) {
        test(`[${name}] loader: ${job} with a lib that parses but has no oneline (${libCase}) still says why it failed`, { skip: skipFor(shell) }, () => {
          const { r, markers, read: readMarker } = loaderRun(job, libCase, shell)
          assert.equal(r.status, 1, r.stdout + r.stderr)
          assert.deepEqual(markers, [marker])
          assert.match(readMarker(marker), /cannot load|npm not found on PATH/, `${libCase} lib: ${JSON.stringify(readMarker(marker))}`)
        })
      }
    }

    test(`[${name}] loader: ${job} with the real lib gets past the loader`, { skip: skipFor(shell) }, () => {
      const { r, markers, read: readMarker } = loaderRun(job, 'ok', shell)
      assert.equal(r.status, 1, r.stdout + r.stderr)
      assert.doesNotMatch(r.stdout + r.stderr, /cannot load/)
      assert.deepEqual(markers, [marker])
      assert.doesNotMatch(readMarker(marker), /cannot load/)
      // The job's first-step reason reaches the marker, so the loaded oneline
      // works on it (before, this only checked for no "cannot load").
      const reason = job === 'tailscale-watchdog' ? 'Tailscale CLI not found or not executable' : 'npm not found on PATH'
      assert.ok(readMarker(marker).includes(reason), JSON.stringify(readMarker(marker)))
    })
  }
}

// --- dot_zshrc banner: no control characters reach the terminal -------------------

const zshrcLine = read('dot_zshrc')
  .split('\n')
  .find((l) => l.includes('.FAILED') && !l.trimStart().startsWith('#'))
const zskip = has('zsh') ? false : 'zsh not installed (see the run command at the top)'

// An interactive shell runs the banner under a UTF-8 locale, where
// [[:cntrl:]] also matches the C1 controls (U+0080-U+009F; U+009B is the
// one-character CSI). The test above runs with no locale. Non-ASCII text stays.
// Not covered: a raw 0x9B byte (invalid UTF-8) is not a character to zsh and
// stays; UTF-8 terminals show it as U+FFFD, not as a CSI.
test('banner: under LANG=C.UTF-8 the C1 controls, NUL, and DEL go too; UTF-8 text stays', { skip: zskip }, () => {
  const home = mkdtempSync(join(tmpdir(), 'text-lib-banner-'))
  try {
    const logs = join(home, '.cron', 'logs')
    mkdirSync(logs, { recursive: true })
    writeFileSync(join(logs, 'x.FAILED'), Buffer.from('a\u009b[2Jb\u0085c\x00d\x7fe ☁ f\n', 'utf8'))
    const r = spawnSync('zsh', ['-f', '-c', zshrcLine], { encoding: 'utf8', env: { HOME: home, PATH: SYS_PATH, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, '\x1b[31mcron: a[2Jbcde ☁ f\x1b[0m\n')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('banner: a marker with ESC, BEL, and CR prints with none of them but the two color codes; lines stay', { skip: zskip }, () => {
  const home = mkdtempSync(join(tmpdir(), 'text-lib-banner-'))
  try {
    const logs = join(home, '.cron', 'logs')
    mkdirSync(logs, { recursive: true })
    writeFileSync(join(logs, 'x.FAILED'), 'a\x1b[2J\x1b]0;x\x07\rb\nsecond\tline\r\n')
    const r = spawnSync('zsh', ['-f', '-c', zshrcLine], { encoding: 'latin1', env: { HOME: home, PATH: SYS_PATH } })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, '\x1b[31mcron: a[2J]0;xb\nsecondline\x1b[0m\n')
    const inner = r.stdout.slice('\x1b[31m'.length, -'\x1b[0m\n'.length)
    assert.doesNotMatch(inner, /[\x00-\x09\x0b-\x1f\x7f]/, JSON.stringify(inner))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
