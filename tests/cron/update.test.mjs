// The daily update job (dot_cron/executable_update.sh) and the script that
// proposes new asdf pins (dot_cron/executable_tool-versions-bump.sh).
//
// Run from the repo root:
//   docker run --rm -v "$PWD":/w -w /w node:latest node --test tests/cron/update.test.mjs
//
// What a pass proves, with stub tools on PATH that log each call:
//   - update.sh runs every updater that is installed, in order, with no stdin,
//     and skips one that is not installed. A failed step does not stop the
//     later steps; it writes update.FAILED (one line, replaced) with the names
//     of the failed steps and exits 1. A clean pass removes the marker and
//     touches update.ok. cf-update.sh writes to its own log, and its
//     status does not fail the pass. A network skip (wait
//     status 1) runs nothing and exits 0, and writes a marker only when
//     update.ok is missing or over 72 hours old.
//   - tool-versions-bump.sh reads dot_tool-versions from main through `gh api`,
//     keeps each pin's suffix (3.14.6t -> 3.15.2t, never 3.15.2), never lowers
//     a pin, does nothing when every pin is the newest, opens one pull request
//     on the branch bump-tool-versions, refreshes that pull request when the
//     pins moved again, and leaves it alone when it already has them. It fails
//     (exit 1, no write) when a tool's releases cannot be read.
// It says nothing about the real brew, mas, asdf, gh, or launchd; one real
// triggered run on the Mac covers those.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, chmodSync, rmSync, utimesSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('../../', import.meta.url)
const UPDATE = new URL('dot_cron/executable_update.sh', ROOT).pathname
const BUMP = new URL('dot_cron/executable_tool-versions-bump.sh', ROOT).pathname
const SYS_PATH = '/usr/bin:/bin'
const SHELLS = [['sh', ['sh']], ['bash --posix', ['bash', '--posix']]]

function exe(path, body) {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

// --- update.sh -------------------------------------------------------------------

const ALL_TOOLS = ['brew', 'asdf', 'pipx', 'git']
// Each stub logs its call and whether stdin is a terminal or a file with data,
// then exits STUB_<TOOL>_RC (default 0).
const toolStub = (t) =>
  `#!/bin/sh\necho "${t} $*" >> "$CALLS"\nif read -r x; then echo "${t} got stdin" >> "$CALLS"; fi\n` +
  `exit "\${STUB_${t.toUpperCase()}_RC:-0}"\n`

function updateSandbox({ tools = ALL_TOOLS, codex = true, subjobs = true, bump = true, omz = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'update-'))
  const home = join(base, 'home')
  const bin = join(base, 'bin')
  const logs = join(home, '.cron', 'logs')
  mkdirSync(logs, { recursive: true })
  mkdirSync(bin)
  const calls = join(base, 'calls')
  writeFileSync(calls, '')
  for (const t of tools) exe(join(bin, t), toolStub(t))
  if (omz) mkdirSync(join(home, '.oh-my-zsh', '.git'), { recursive: true })
  if (codex) {
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    exe(join(home, '.local', 'bin', 'codex'), toolStub('codex'))
  }
  if (subjobs) {
    for (const j of ['cf']) exe(join(home, '.cron', `${j}-update.sh`), `#!/bin/sh\necho "${j}-update" >> "$CALLS"\necho "${j} output"\nexit "\${STUB_SUB_RC:-0}"\n`)
  }
  if (bump) exe(join(home, '.cron', 'tool-versions-bump.sh'), toolStub('bump'))
  const wait = join(base, 'wait')
  exe(wait, '#!/bin/sh\nexit "${STUB_WAIT_RC:-0}"\n')
  return {
    home,
    logs,
    marker: join(logs, 'update.FAILED'),
    stamp: join(logs, 'update.ok'),
    calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    run(env = {}, shell = ['sh']) {
      return spawnSync(shell[0], [...shell.slice(1), UPDATE], {
        encoding: 'utf8',
        input: 'stdin data\n',
        env: { HOME: home, PATH: `${bin}:${SYS_PATH}`, CALLS: calls, WAIT_FOR_NETWORK: wait, ...env },
      })
    },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}
const withUpdate = (opts, fn) => {
  const sb = updateSandbox(opts)
  try {
    return fn(sb)
  } finally {
    sb.cleanup()
  }
}

const FULL_PASS = [
  'brew update --quiet',
  'brew upgrade --quiet --no-quit',
  'brew cleanup --prune=30 --quiet',
  'asdf plugin update --all',
  'pipx upgrade-all',
  'git -C HOME/.oh-my-zsh pull -q',
  'codex update',
  'cf-update',
  'bump ',
]

for (const [name, shell] of SHELLS) {
  test(`[${name}] update: a clean pass runs every updater in order with no stdin, clears the marker, touches update.ok`, () =>
    withUpdate({}, (sb) => {
      writeFileSync(sb.marker, 'old\n')
      const r = sb.run({}, shell)
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.deepEqual(sb.calls().map((c) => c.replace(sb.home, 'HOME')), FULL_PASS)
      assert.ok(!existsSync(sb.marker))
      assert.ok(existsSync(sb.stamp))
      assert.match(r.stdout, /^update: ok$/m)
      // The self-reporting job writes to its own log, not to this one.
      assert.match(readFileSync(join(sb.logs, 'cf.log'), 'utf8'), /cf output/)
      assert.doesNotMatch(r.stdout, /cf output/)
    }))

  test(`[${name}] update: a failed step does not stop the pass; the marker names each failed step; exit 1`, () =>
    withUpdate({}, (sb) => {
      const r = sb.run({ STUB_BREW_RC: '1', STUB_PIPX_RC: '3' }, shell)
      assert.equal(r.status, 1, r.stdout + r.stderr)
      // brew stops at its first failed command; every later step still runs.
      assert.deepEqual(sb.calls().map((c) => c.replace(sb.home, 'HOME')), FULL_PASS.filter((c) => !/^brew (upgrade|cleanup)/.test(c)))
      assert.match(readFileSync(sb.marker, 'utf8'), /^\d{4}-\d\d-\d\d \d\d:\d\d update failed: brew pipx \(see ~\/\.cron\/logs\/update\.log\)\n$/)
      assert.ok(!existsSync(sb.stamp))
      assert.match(r.stdout, /^update: pipx FAILED: exit 3$/m)
      // The next clean pass replaces nothing and removes the marker.
      assert.equal(sb.run({}, shell).status, 0)
      assert.ok(!existsSync(sb.marker))
    }))
}

test('update: no step needs sudo (the App Store step did, so the App Store keeps its own apps current)', () => {
  const code = readFileSync(UPDATE, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')
  assert.doesNotMatch(code, /\b(sudo|mas)\b/)
})

test('update: a tool that is not installed is skipped, and the pass still succeeds', () =>
  withUpdate({ tools: ['brew'], codex: false, subjobs: false, bump: false, omz: false }, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), FULL_PASS.slice(0, 3))
  }))

test('update: cf-update.sh reports for itself: its failure does not fail the pass', () =>
  withUpdate({}, (sb) => {
    const r = sb.run({ STUB_SUB_RC: '1' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.ok(!existsSync(sb.marker))
  }))

test('update: the pin bump is a step: its failure writes the marker', () =>
  withUpdate({}, (sb) => {
    const r = sb.run({ STUB_BUMP_RC: '1' })
    assert.equal(r.status, 1)
    assert.match(readFileSync(sb.marker, 'utf8'), /update failed: tool-versions \(see/)
  }))

test('update: network down: nothing runs, exit 0, an existing marker stays, and a fresh update.ok means no new marker', () =>
  withUpdate({}, (sb) => {
    writeFileSync(sb.stamp, '')
    let r = sb.run({ STUB_WAIT_RC: '1' })
    assert.equal(r.status, 0)
    assert.deepEqual(sb.calls(), [])
    assert.match(r.stdout, /^update: network not up; skipped$/m)
    assert.ok(!existsSync(sb.marker))
    writeFileSync(sb.marker, 'earlier failure\n')
    r = sb.run({ STUB_WAIT_RC: '1' })
    assert.equal(readFileSync(sb.marker, 'utf8'), 'earlier failure\n')
  }))

test('update: network down with update.ok missing or over 72 hours old writes a marker that does not say "update failed"', () =>
  withUpdate({}, (sb) => {
    sb.run({ STUB_WAIT_RC: '1' })
    assert.match(readFileSync(sb.marker, 'utf8'), /update: network check failed and no successful run in 72 hours/)
    rmSync(sb.marker)
    writeFileSync(sb.stamp, '')
    const old = new Date(Date.now() - 73 * 3600 * 1000)
    utimesSync(sb.stamp, old, old)
    sb.run({ STUB_WAIT_RC: '1' })
    assert.doesNotMatch(readFileSync(sb.marker, 'utf8'), /update failed/)
  }))

test('update: a wait status other than 1 (helper missing, cannot check) runs the pass', () =>
  withUpdate({}, (sb) => {
    for (const rc of ['2', '127']) assert.equal(sb.run({ STUB_WAIT_RC: rc }).status, 0)
    assert.equal(sb.calls().filter((c) => c === 'pipx upgrade-all').length, 2)
  }))

test('update.sh and tool-versions-bump.sh: POSIX sh shebang, parse under sh -n and bash --posix -n', () => {
  for (const f of [UPDATE, BUMP]) {
    assert.match(readFileSync(f, 'utf8'), /^#!\/bin\/sh\n/)
    for (const argv of [['sh', '-n', f], ['bash', '--posix', '-n', f]]) {
      const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
    }
  }
})

test('chezmoiignore: the pin bump is deployed on personal Macs and ignored on the work Mac', () => {
  const ignore = readFileSync(new URL('.chezmoiignore', ROOT), 'utf8')
  assert.match(ignore, /\{\{ if \.work \}\}\n\.cron\/tool-versions-bump\.sh\n\{\{ end \}\}/)
})

// --- tool-versions-bump.sh -------------------------------------------------------

// A stub gh that serves a small fake repository from files under $GH:
//   main.txt, branch.txt   dot_tool-versions at each ref (branch.txt absent = no branch)
//   pr                     the open pull request number (absent = none)
// It logs every call. A PUT decodes the content into branch.txt.
const GH = `#!/bin/bash
echo "gh $*" >> "$CALLS"
args="$*"
fail() { echo "gh: $1" >&2; exit 1; }
[ -n "\${STUB_GH_FAIL:-}" ] && [[ "$args" == *"$STUB_GH_FAIL"* ]] && fail "stubbed failure"
case "$args" in
  *"-X PUT"*)
    for a in "$@"; do case "$a" in content=*) printf '%s' "\${a#content=}" | base64 -d > "$GH/branch.txt" ;; esac; done ;;
  *"-X DELETE"*) [ -e "$GH/branch.txt" ] || fail "no ref"; rm -f "$GH/branch.txt" ;;
  *"git/refs -f"*) [ -e "$GH/branch.txt" ] && fail "ref exists"; cp "$GH/main.txt" "$GH/branch.txt" ;;
  *"git/ref/heads/main"*) echo mainsha ;;
  *"application/vnd.github.raw"*"ref=main"*) cat "$GH/main.txt" ;;
  *"application/vnd.github.raw"*"ref=bump-tool-versions"*) cat "$GH/branch.txt" 2>/dev/null || fail "404" ;;
  *"contents/dot_tool-versions?ref="*"--jq .sha"*) echo blobsha ;;
  "pr list"*) cat "$GH/pr" 2>/dev/null; true ;;
  "pr create"*) echo 7 > "$GH/pr"; echo "https://github.com/x/y/pull/7" ;;
  "pr edit"*) : ;;
  *) fail "unexpected call: $args" ;;
esac
`
// asdf list all <tool>: the releases in $ASDF/<tool>, oldest first, with noise.
const ASDF = `#!/bin/sh
[ "$1 $2" = "list all" ] || exit 2
cat "$ASDF/$3" 2>/dev/null || exit 1
`
const RELEASES = {
  python: ['3.14.6', '3.14.6t', '3.15.0a1', '3.15.2', '3.15.2t', '3.16-dev', 'pypy3.11-7.3.20', '3.9.25'],
  nodejs: ['26.9.0', '26.13.0', '26.13.1', 'lts'],
  golang: ['1.26.4', '1.27rc1', '1.27.4', '1.9.7'],
}

function bumpSandbox({ main, branch, pr, releases = RELEASES } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'bump-'))
  const bin = join(base, 'bin')
  const gh = join(base, 'gh')
  const asdf = join(base, 'asdf')
  for (const d of [bin, gh, asdf]) mkdirSync(d)
  exe(join(bin, 'gh'), GH)
  exe(join(bin, 'asdf'), ASDF)
  for (const [t, v] of Object.entries(releases)) writeFileSync(join(asdf, t), v.join('\n') + '\n')
  writeFileSync(join(gh, 'main.txt'), main)
  if (branch !== undefined) writeFileSync(join(gh, 'branch.txt'), branch)
  if (pr !== undefined) writeFileSync(join(gh, 'pr'), `${pr}\n`)
  const calls = join(base, 'calls')
  writeFileSync(calls, '')
  return {
    calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    branch: () => (existsSync(join(gh, 'branch.txt')) ? readFileSync(join(gh, 'branch.txt'), 'utf8') : undefined),
    run(env = {}, shell = ['sh']) {
      return spawnSync(shell[0], [...shell.slice(1), BUMP], {
        encoding: 'utf8',
        env: { HOME: base, PATH: `${bin}:${SYS_PATH}`, CALLS: calls, GH: gh, ASDF: asdf, ...env },
      })
    },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}
const withBump = (opts, fn) => {
  const sb = bumpSandbox(opts)
  try {
    return fn(sb)
  } finally {
    sb.cleanup()
  }
}
const writes = (sb) => sb.calls().filter((c) => /-X (PUT|DELETE)|git\/refs -f|^gh pr (create|edit)/.test(c))

const STALE = 'python 3.14.6t\nnodejs 26.13.0\ngolang 1.26.4\n'
const FRESH = 'python 3.15.2t\nnodejs 26.13.1\ngolang 1.27.4\n'

for (const [name, shell] of SHELLS) {
  test(`[${name}] bump: stale pins open one pull request with the newest release of each pin's shape`, () =>
    withBump({ main: STALE }, (sb) => {
      const r = sb.run({}, shell)
      assert.equal(r.status, 0, r.stdout + r.stderr)
      // 3.15.2t, not 3.15.2 or 3.16-dev; 1.27.4, not 1.9.7 (version order) or 1.27rc1.
      assert.equal(sb.branch(), FRESH)
      assert.match(r.stdout, /^- python 3\.14\.6t -> 3\.15\.2t$/m)
      assert.match(r.stdout, /^tool-versions-bump: ok: opened https:\/\/github\.com\/x\/y\/pull\/7$/m)
      const w = writes(sb)
      assert.equal(w.filter((c) => c.startsWith('gh pr create')).length, 1)
      assert.ok(w.some((c) => /^gh pr create -R rdegges\/dotfiles --head bump-tool-versions --base main /.test(c)), w.join('\n'))
      assert.ok(w.some((c) => c.includes('-X PUT repos/rdegges/dotfiles/contents/dot_tool-versions') && c.includes('branch=bump-tool-versions')), w.join('\n'))
      assert.ok(!w.some((c) => c.includes('branch=main')), 'wrote to main')
    }))
}

test('bump: every pin is the newest: no write, exit 0', () =>
  withBump({ main: FRESH }, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(writes(sb), [])
    assert.match(r.stdout, /every pin is the newest release/)
  }))

test('bump: a pin newer than every listed release is never lowered', () =>
  withBump({ main: 'nodejs 27.0.0\ngolang 1.26.4\n' }, (sb) => {
    assert.equal(sb.run().status, 0)
    assert.equal(sb.branch(), 'nodejs 27.0.0\ngolang 1.27.4\n')
  }))

test('bump: an open pull request that already has these pins is left alone', () =>
  withBump({ main: STALE, branch: FRESH, pr: 7 }, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(writes(sb), [])
    assert.match(r.stdout, /pull request #7 already has these pins/)
  }))

test('bump: an open pull request with older pins is refreshed in place, not opened twice', () =>
  withBump({ main: STALE, branch: 'python 3.15.0t\nnodejs 26.13.0\ngolang 1.26.4\n', pr: 7 }, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.equal(sb.branch(), FRESH)
    const w = writes(sb)
    assert.ok(!w.some((c) => c.startsWith('gh pr create') || c.includes('DELETE')), w.join('\n'))
    assert.ok(w.some((c) => c.startsWith('gh pr edit 7 ')), w.join('\n'))
  }))

test('bump: a branch left from a merged pull request starts again from main', () =>
  withBump({ main: STALE, branch: 'python 3.13.0t\n' }, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.equal(sb.branch(), FRESH)
    assert.ok(writes(sb)[0].includes('-X DELETE repos/rdegges/dotfiles/git/refs/heads/bump-tool-versions'))
  }))

test('bump: a tool whose releases cannot be read fails the run before any write', () =>
  withBump({ main: STALE + 'bun 1.3.14\n' }, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 1)
    assert.match(r.stdout, /FAILED: cannot read the newest release of bun \(pin 1\.3\.14\)/)
    assert.deepEqual(writes(sb), [])
  }))

for (const [what, pattern] of [['main cannot be read', 'ref=main'], ['pull requests cannot be listed', 'pr list'], ['the file cannot be written', '-X PUT'], ['the pull request cannot be opened', 'pr create']]) {
  test(`bump: ${what}: exit 1 with a FAILED line`, () =>
    withBump({ main: STALE }, (sb) => {
      const r = sb.run({ STUB_GH_FAIL: pattern })
      assert.equal(r.status, 1, r.stdout + r.stderr)
      assert.match(r.stdout, /^tool-versions-bump: FAILED: /m)
    }))
}

test('bump: gh or asdf missing from PATH fails closed', () =>
  withBump({ main: STALE }, (sb) => {
    const r = sb.run({ PATH: SYS_PATH })
    assert.equal(r.status, 1)
    assert.match(r.stdout, /FAILED: gh not found on PATH/)
  }))
