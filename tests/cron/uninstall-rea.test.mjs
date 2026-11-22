// The script that uninstalls REA from every Mac
// (run_once_after_uninstall-rea.sh.tmpl), and the .chezmoiremove entries for
// the files REA left.
//
// Run from the repo root (chezmoi and bash are needed; without chezmoi the
// render and .chezmoiremove tests FAIL, they do not skip):
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin && node --test tests/cron/uninstall-rea.test.mjs'
//
// What a pass proves: the script renders only for darwin. Run by bash in a
// throwaway HOME with a fake ~/.asdf/installs/nodejs (stub node, rea, and npm
// in each version's bin/, stub asdf on PATH, and a rea on PATH that must never
// run; its rea stub removes only the entries that name its own install, as
// the real one does): with REA in two Node versions, it runs
// `rea uninstall --purge-data` from each of them, through that version's own
// node and with no stdin, then checks for leftovers, then runs
// `npm uninstall --global rea-agents` through each of those versions' own node
// and npm (never in a version without REA), then `asdf reshim nodejs`, and
// exits 0. It removes skill folders that REA leaves and puts
// ~/.codex/config.toml back byte for byte when REA edits or deletes it. When an
// MCP entry is left after the rea runs, it exits 1, names each item on its own
// indented line, and leaves every REA install in place for the retry. With no bin/rea anywhere it makes no call and exits 0 only
// when no rea MCP entry (Claude Code, opencode) and no reverse-engineer-anything
// skill folder (~/.claude/skills, ~/.agents/skills) is left; else it names each
// item and exits 1. A failed rea uninstall, npm uninstall, or reshim exits 1
// and runs no later step. A real chezmoi apply of .chezmoiremove deletes the
// deployed rea-update.sh, the rea logs, and the .rea.backup files (the
// .recovery copies and the Codex one too) and keeps the live client files and the cf logs.
// It says nothing about the real REA, npm, or asdf. A Docker probe of
// rea-agents 6.10.1 ran this script against a real install (see the PR).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const SOURCE = new URL('../../', import.meta.url).pathname
const TEMPLATE = 'run_once_after_uninstall-rea.sh.tmpl'
const SYS_PATH = '/usr/bin:/bin'
const read = (p) => readFileSync(join(SOURCE, p), 'utf8')
// The template body without its chezmoi {{ }} lines.
const BODY = read(TEMPLATE).split('\n').filter((l) => !l.includes('{{')).join('\n')

const exe = (p, body) => {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body)
  chmodSync(p, 0o755)
}

// node runs the script it is given, as the real one does, and logs which
// version's node it is. rea and npm are shell stubs that node runs.
const NODE = '#!/bin/sh\nv=$(basename "$(dirname "$(dirname "$0")")")\nprintf "node(%s) " "$v" >> "$CALLS"\ns=$1; shift\nexec /bin/sh "$s" "$@"\n'
// rea uninstall: logs its args and how much stdin it got. STUB_REA_RC fails it
// (after any Codex change, so a failed run can still have edited that file);
// STUB_REA_RC_IN=<version> limits the failure to that version's rea.
// It removes the client entries and skill folders unless STUB_REA_KEEP names
// what it leaves (skills, mcp). STUB_REA_CODEX=edit|delete changes Codex's file.
// Like the real rea-agents 6.10.1 (checked in Docker), it removes a client
// entry only when the entry names its own install: an entry that names another
// Node version's bin/rea is "not REA-owned", is retained, and the run still
// exits 0. It removes the skill folders whatever their origin, as the real one does.
const REA = `#!/bin/sh
echo "rea $* stdin=$(cat | wc -c | tr -d ' ')" >> "$CALLS"
case "\${STUB_REA_CODEX:-}" in
  edit) printf '%s\\n' '# rea was here' >> "$HOME/.codex/config.toml" ;;
  delete) rm -f "$HOME/.codex/config.toml" ;;
esac
self="$(cd "$(dirname "$0")/.." && pwd)/bin/rea"
if [ -n "\${STUB_REA_RC:-}" ]; then
  case "\${STUB_REA_RC_IN:-}" in ''|"$(basename "$(dirname "$(dirname "$self")")")") exit "$STUB_REA_RC" ;; esac
fi
case " \${STUB_REA_KEEP:-} " in *" mcp "*) ;; *)
  for f in "$HOME/.claude.json" "$HOME/.config/opencode/opencode.json"; do
    [ -f "$f" ] && grep -qF "$self" "$f" && printf '%s\\n' '{"mcpServers":{"parallel":{}}}' > "$f"
  done ;;
esac
case " \${STUB_REA_KEEP:-} " in *" skills "*) ;; *)
  rm -rf "$HOME/.claude/skills/reverse-engineer-anything" "$HOME/.agents/skills/reverse-engineer-anything" ;;
esac
exit 0
`
// npm uninstall: logs, then removes its own version's bin/rea. STUB_NPM_RC
// fails it; STUB_NPM_KEEP=1 exits 0 but leaves bin/rea.
const NPM = `#!/bin/sh
echo "npm $*" >> "$CALLS"
echo "\${PATH%%:*}" >> "$CALLS.path"
[ -n "\${STUB_NPM_RC:-}" ] && exit "$STUB_NPM_RC"
[ -n "\${STUB_NPM_KEEP:-}" ] || rm -f "$(dirname "$0")/rea"
exit 0
`
const ASDF = '#!/bin/sh\necho "asdf $*" >> "$CALLS"\nexit "${STUB_ASDF_RC:-0}"\n'

// The entries name the Node version whose rea setup wrote them, as the real
// ones do (command = <version>/bin/node, args = [<version>/bin/rea, "mcp"]).
const CLAUDE_WITH_REA = (home, v = '26.13.0') => {
  const d = join(home, '.asdf/installs/nodejs', v, 'bin')
  return JSON.stringify({ numStartups: 3, mcpServers: { parallel: { type: 'http' }, rea: { command: join(d, 'node'), args: [join(d, 'rea'), 'mcp'] } } }) + '\n'
}
const OPENCODE_WITH_REA = (home, v = '26.13.0') =>
  `{"mcp":{"parallel":{"type":"remote"},\n  "rea" : {"type":"local","command":["${join(home, '.asdf/installs/nodejs', v, 'bin/node')}","${join(home, '.asdf/installs/nodejs', v, 'bin/rea')}","mcp"]}}}\n`
const CODEX = 'approval_policy = "never"\n\n[mcp_servers.parallel]\nurl = "https://search.parallel.ai/mcp"\n'

// versions: Node versions to create; withRea: those that get bin/rea.
// installed: whether REA's client entries and skill folders exist.
// registeredIn: the Node version whose rea setup wrote the client entries.
function sandbox({ versions = ['26.13.0', '26.4.0', '28.0.0'], withRea = ['26.13.0', '26.4.0'], installed = true, registeredIn = '26.13.0', baseName = 'uninstall-rea-' } = {}) {
  const base = mkdtempSync(join(tmpdir(), baseName))
  const home = join(base, 'home')
  const bin = join(base, 'bin')
  const calls = join(base, 'calls')
  writeFileSync(calls, '')
  for (const v of versions) {
    const vb = join(home, '.asdf', 'installs', 'nodejs', v, 'bin')
    exe(join(vb, 'node'), NODE)
    exe(join(vb, 'npm'), NPM)
    if (withRea.includes(v)) exe(join(vb, 'rea'), REA)
  }
  exe(join(bin, 'asdf'), ASDF)
  // A rea on PATH (the asdf shim): the script must never use it.
  exe(join(bin, 'rea'), '#!/bin/sh\necho "PATH rea $*" >> "$CALLS"\n')
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.codex', 'config.toml'), CODEX)
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
  for (const d of ['.claude/skills/other-skill', '.agents/skills/other-skill']) {
    mkdirSync(join(home, d), { recursive: true })
    writeFileSync(join(home, d, 'SKILL.md'), 'x\n')
  }
  if (installed) {
    writeFileSync(join(home, '.claude.json'), CLAUDE_WITH_REA(home, registeredIn))
    writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), OPENCODE_WITH_REA(home, registeredIn))
    for (const d of ['.claude/skills', '.agents/skills']) {
      mkdirSync(join(home, d, 'reverse-engineer-anything', 'references'), { recursive: true })
      writeFileSync(join(home, d, 'reverse-engineer-anything', 'SKILL.md'), 'rea\n')
    }
  } else {
    // "area" holds "rea" as a substring but is not a key named rea.
    writeFileSync(join(home, '.claude.json'), '{"mcpServers":{"parallel":{}},"area":{"x":1}}\n')
    writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), '{"mcp":{"parallel":{}}}\n')
  }
  return {
    home,
    bin,
    calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    // The first PATH entry each npm uninstall saw, in call order.
    npmPaths: () => (existsSync(calls + '.path') ? readFileSync(calls + '.path', 'utf8').split('\n').filter(Boolean) : []),
    run: (env = {}) =>
      spawnSync('bash', ['-c', BODY], {
        encoding: 'utf8',
        input: 'stdin must not reach rea\n',
        env: { HOME: home, PATH: `${bin}:${SYS_PATH}`, CALLS: calls, ...env },
      }),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}
const withSandbox = (opts, fn) => {
  const sb = sandbox(opts)
  try {
    return fn(sb)
  } finally {
    sb.cleanup()
  }
}

const UN = (v) => `node(${v}) rea uninstall --purge-data stdin=0`
const UNINSTALL = UN('26.13.0')
const NPM_UN = (v) => `node(${v}) npm uninstall --global rea-agents`
const FULL = [UNINSTALL, UN('26.4.0'), NPM_UN('26.13.0'), NPM_UN('26.4.0'), 'asdf reshim nodejs']
const SKILLS = ['.claude/skills/reverse-engineer-anything', '.agents/skills/reverse-engineer-anything']

// --- template ----------------------------------------------------------------

function execTemplate(os) {
  const home = mkdtempSync(join(tmpdir(), 'uninstall-rea-tmpl-'))
  try {
    const r = spawnSync('chezmoi', ['--source', SOURCE, '--destination', home, '--override-data', JSON.stringify({ chezmoi: { os } }), 'execute-template'], {
      encoding: 'utf8',
      input: read(TEMPLATE),
      env: { PATH: process.env.PATH, HOME: home },
    })
    assert.ifError(r.error)
    assert.equal(r.status, 0, r.stderr)
    return r.stdout
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('renders a bash script for darwin, nothing for linux (chezmoi skips it)', () => {
  const mac = execTemplate('darwin')
  assert.ok(mac.startsWith('#!/bin/bash\n'), JSON.stringify(mac.slice(0, 40)))
  assert.equal(mac, BODY)
  assert.equal(execTemplate('linux').trim(), '')
})

test('the retirement note is in the header, and the script parses under bash -n', () => {
  assert.match(read(TEMPLATE), / Delete this script once every Mac shows no\n# ~\/\.asdf\/installs\/nodejs\/\*\/bin\/rea and no rea MCP entry\.\n/)
  const r = spawnSync('bash', ['-n', '-c', BODY], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
})

// --- REA installed -----------------------------------------------------------

test('installed in two Node versions: rea uninstall in each, then npm uninstall in each, then reshim; exit 0', () =>
  withSandbox({}, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), FULL)
    for (const v of ['26.13.0', '26.4.0']) assert.ok(!existsSync(join(sb.home, '.asdf/installs/nodejs', v, 'bin/rea')))
    for (const d of SKILLS) assert.ok(!existsSync(join(sb.home, d)), d)
    for (const d of ['.claude/skills/other-skill', '.agents/skills/other-skill']) assert.ok(existsSync(join(sb.home, d, 'SKILL.md')), d)
    assert.equal(readFileSync(join(sb.home, '.codex/config.toml'), 'utf8'), CODEX)
    assert.match(r.stdout, /^uninstall-rea: done\.$/m)
  }))

test('installed only in an older Node, not the pinned one the PATH shim uses: still found and removed', () =>
  withSandbox({ withRea: ['26.4.0'], registeredIn: '26.4.0' }, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), ['node(26.4.0) rea uninstall --purge-data stdin=0', NPM_UN('26.4.0'), 'asdf reshim nodejs'])
  }))

test('a second run after a clean uninstall: no call, exit 0', () =>
  withSandbox({}, (sb) => {
    assert.equal(sb.run().status, 0)
    const before = sb.calls().length
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.equal(sb.calls().length, before)
    assert.match(r.stdout, /REA is not installed; nothing to do/)
  }))

test('rea uninstall leaves the skill folders: the script removes them, exit 0', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({ STUB_REA_KEEP: 'skills' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    for (const d of SKILLS) assert.ok(!existsSync(join(sb.home, d)), d)
    assert.ok(existsSync(join(sb.home, '.claude/skills/other-skill/SKILL.md')))
    assert.deepEqual(sb.calls(), FULL)
  }))

test('rea uninstall leaves an MCP entry: exit 1, and the message names both files', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({ STUB_REA_KEEP: 'mcp' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    // Every leftover on its own indented line.
    assert.ok(r.stderr.includes(`\n  an MCP entry named rea in ${join(sb.home, '.claude.json')}\n`), r.stderr)
    assert.ok(r.stderr.includes(`\n  an MCP entry named rea in ${join(sb.home, '.config/opencode/opencode.json')}\n`), r.stderr)
    // The check runs before npm: REA stays for the retry.
    assert.deepEqual(sb.calls(), [UNINSTALL, UN('26.4.0')])
    for (const v of ['26.13.0', '26.4.0']) assert.ok(existsSync(join(sb.home, '.asdf/installs/nodejs', v, 'bin/rea')), v)
  }))

for (const change of ['edit', 'delete']) {
  test(`rea uninstall that does a ${change} of ~/.codex/config.toml: chezmoi's bytes are put back`, () =>
    withSandbox({}, (sb) => {
      const r = sb.run({ STUB_REA_CODEX: change })
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.equal(readFileSync(join(sb.home, '.codex/config.toml'), 'utf8'), CODEX)
      assert.match(r.stdout, /changed .*\.codex\/config\.toml; put chezmoi's copy back/)
    }))
}

test('rea uninstall fails: exit 1, no npm uninstall, no reshim, bin/rea stays for the retry', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({ STUB_REA_RC: '3' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), [UNINSTALL])
    assert.match(r.stderr, /rea uninstall --purge-data exited 3/)
    assert.ok(existsSync(join(sb.home, '.asdf/installs/nodejs/26.13.0/bin/rea')))
  }))

test('npm uninstall fails: exit 1, no later version, no reshim', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({ STUB_NPM_RC: '1' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), [UNINSTALL, UN('26.4.0'), NPM_UN('26.13.0')])
    assert.match(r.stderr, /npm uninstall --global rea-agents failed in Node 26\.13\.0/)
  }))

test('npm uninstall exits 0 but bin/rea is still there: exit 1, no reshim', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({ STUB_NPM_KEEP: '1' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stderr, /26\.13\.0\/bin\/rea is still there after npm uninstall/)
    assert.ok(!sb.calls().includes('asdf reshim nodejs'))
  }))

test('asdf reshim fails: exit 1', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({ STUB_ASDF_RC: '1' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), FULL)
    assert.match(r.stderr, /asdf reshim nodejs failed/)
  }))

// --- REA absent ----------------------------------------------------------------

test('absent and nothing left: no call (the PATH rea included), exit 0', () =>
  withSandbox({ withRea: [], installed: false }, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), [])
  }))

test('absent, no asdf installs and no client files at all: exit 0', () =>
  withSandbox({ versions: [], withRea: [], installed: false }, (sb) => {
    rmSync(join(sb.home, '.claude.json'))
    rmSync(join(sb.home, '.config'), { recursive: true })
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), [])
  }))

for (const [what, setup, says] of [
  ['a rea entry in ~/.claude.json', (h) => writeFileSync(join(h, '.claude.json'), CLAUDE_WITH_REA(h)), '.claude.json'],
  ['a rea entry in opencode.json', (h) => writeFileSync(join(h, '.config/opencode/opencode.json'), OPENCODE_WITH_REA(h)), '.config/opencode/opencode.json'],
  ['the skill folder in ~/.claude/skills', (h) => mkdirSync(join(h, SKILLS[0])), SKILLS[0]],
  ['the skill folder in ~/.agents/skills', (h) => mkdirSync(join(h, SKILLS[1])), SKILLS[1]],
]) {
  test(`absent but ${what} is left: no call, exit 1, and the message names it`, () =>
    withSandbox({ withRea: [], installed: false }, (sb) => {
      setup(sb.home)
      const r = sb.run()
      assert.equal(r.status, 1, r.stdout + r.stderr)
      assert.deepEqual(sb.calls(), [])
      assert.ok(r.stderr.includes(join(sb.home, says)), r.stderr)
      assert.match(r.stderr, /remove them by hand, then run chezmoi apply/)
    }))
}

// --- .chezmoiremove --------------------------------------------------------------

test('chezmoi apply removes the deployed REA files and keeps the live ones', () => {
  const base = mkdtempSync(join(tmpdir(), 'uninstall-rea-remove-'))
  try {
    const src = join(base, 'src')
    const home = join(base, 'home')
    mkdirSync(src)
    copyFileSync(join(SOURCE, '.chezmoiremove'), join(src, '.chezmoiremove'))
    const gone = [
      '.cron/rea-update.sh',
      '.cron/logs/rea.log',
      '.cron/logs/rea.ok',
      '.cron/logs/rea.FAILED',
      '.claude.json.rea.backup',
      '.claude.json.rea.backup.2be791c64d85.recovery',
      '.config/opencode/opencode.json.rea.backup',
      '.config/opencode/opencode.json.rea.backup.1',
      '.config/opencode/opencode.json.rea.backup.000f210ae3b5.recovery',
      '.codex/config.toml.rea.backup',
    ]
    const kept = ['.claude.json', '.config/opencode/opencode.json', '.cron/cf-update.sh', '.cron/logs/cf.log', '.cron/logs/cf.FAILED', '.codex/config.toml']
    for (const f of [...gone, ...kept]) {
      mkdirSync(dirname(join(home, f)), { recursive: true })
      writeFileSync(join(home, f), 'x\n')
    }
    const r = spawnSync('chezmoi', ['--source', src, '--destination', home, '--force', 'apply'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: home },
    })
    assert.ifError(r.error)
    assert.equal(r.status, 0, r.stderr)
    for (const f of gone) assert.ok(!existsSync(join(home, f)), `${f} survived`)
    for (const f of kept) assert.ok(existsSync(join(home, f)), `${f} was removed`)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// --- Added by the tester -----------------------------------------------------
//
// What a pass proves (on top of the header): a Mac shaped like the one this
// PR targets -- REA in several Node versions, the client entries written by
// the pinned Node, which is not the first version in glob order, opencode's
// entry under mcp.servers -- ends with no rea entry, no bin/rea, and exit 0.
// The asdf-missing, no-Codex-file, dangling-symlink, and odd-HOME paths behave
// as the script says. Rendered ~/.codex/config.toml has no rea table, and no
// tracked file outside the uninstaller, .chezmoiremove, and tests still runs
// or documents the REA updater.

const reaKeyLeft = (home) =>
  ['.claude.json', '.config/opencode/opencode.json'].filter((f) => existsSync(join(home, f)) && /"rea"\s*:/.test(readFileSync(join(home, f), 'utf8')))

// Real-data shape of the target Mac (read-only look on 2026-11-21): Node
// 25.8.0 (no REA), 26.13.0 and 26.13.1 (rea-agents 6.10.1), 26.4.0 (6.8.0);
// pin 26.13.1; ~/.claude.json mcpServers.rea and opencode mcp.servers.rea both
// name 26.13.1. Glob order puts 26.13.0 first. A Docker replay with the real
// rea-agents 6.10.1 (same layout) retained both entries ("The rea-named
// registration is not REA-owned"), npm-uninstalled REA everywhere, and exited 1
// on the leftover check, on the first run and on every later apply. The script
// now runs rea uninstall from every install, so the 26.13.1 run removes them.
test('client entries written by the pinned Node, which is not first in glob order: still removed, exit 0', () =>
  withSandbox({ versions: ['25.8.0', '26.13.0', '26.13.1', '26.4.0'], withRea: ['26.13.0', '26.13.1', '26.4.0'], registeredIn: '26.13.1' }, (sb) => {
    const v = join(sb.home, '.asdf/installs/nodejs/26.13.1/bin')
    writeFileSync(join(sb.home, '.config/opencode/opencode.json'),
      JSON.stringify({ mcp: { parallel: { type: 'remote' }, servers: { rea: { type: 'local', command: [join(v, 'node'), join(v, 'rea'), 'mcp'], disabled: false } } } }, null, 2) + '\n')
    const r = sb.run()
    assert.deepEqual(reaKeyLeft(sb.home), [], r.stdout + r.stderr)
    for (const ver of ['26.13.0', '26.13.1', '26.4.0']) assert.ok(!existsSync(join(sb.home, '.asdf/installs/nodejs', ver, 'bin/rea')), ver)
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.ok(!sb.calls().some((c) => c.startsWith('PATH rea')), sb.calls().join('\n'))
  }))

test('asdf is not on PATH: exit 1 after the npm uninstalls, and the message says to reshim', () =>
  withSandbox({}, (sb) => {
    rmSync(join(sb.bin, 'asdf'))
    const r = sb.run()
    assert.equal(r.status, 1, r.stdout + r.stderr)
    // The uninstalls ran before the reshim step failed.
    for (const v of ['26.13.0', '26.4.0']) assert.ok(sb.calls().includes(NPM_UN(v)), sb.calls().join('\n'))
    assert.match(r.stderr, /asdf not found on PATH; run asdf reshim nodejs/)
    assert.doesNotMatch(r.stdout, /uninstall-rea: done\./)
  }))

test('no ~/.codex/config.toml: nothing saved or restored, no file created, exit 0', () =>
  withSandbox({}, (sb) => {
    rmSync(join(sb.home, '.codex/config.toml'))
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.ok(sb.calls().includes(UNINSTALL), sb.calls().join('\n'))
    assert.ok(!existsSync(join(sb.home, '.codex/config.toml')))
    assert.doesNotMatch(r.stdout, /put chezmoi's copy back/)
  }))

test('rea uninstall leaves a dangling skill symlink: the script removes the link, exit 0', () =>
  withSandbox({}, (sb) => {
    const link = join(sb.home, SKILLS[0])
    // REA_KEEP=skills keeps both folders; replace the Claude one with a link to nowhere.
    rmSync(link, { recursive: true })
    spawnSync('ln', ['-s', join(sb.home, 'gone'), link])
    const r = sb.run({ STUB_REA_KEEP: 'skills' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.equal(spawnSync('test', ['-L', link]).status, 1, 'the dangling link survived')
    assert.ok(r.stdout.includes('removed ' + link), r.stdout)
  }))

test('absent, but a dangling reverse-engineer-anything symlink is left: exit 1 and it is named', () =>
  withSandbox({ withRea: [], installed: false }, (sb) => {
    spawnSync('ln', ['-s', join(sb.home, 'gone'), join(sb.home, SKILLS[1])])
    const r = sb.run()
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), [])
    assert.ok(r.stderr.includes(join(sb.home, SKILLS[1])), r.stderr)
  }))

test('a HOME path with a space and non-ASCII letters: full uninstall, exit 0', () =>
  withSandbox({ baseName: 'uninstall rea é-' }, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    for (const v of ['26.13.0', '26.4.0']) assert.ok(!existsSync(join(sb.home, '.asdf/installs/nodejs', v, 'bin/rea')), v)
    assert.deepEqual(reaKeyLeft(sb.home), [])
    assert.equal(readFileSync(join(sb.home, '.codex/config.toml'), 'utf8'), CODEX)
  }))

for (const work of [false, true]) {
  test('rendered ~/.codex/config.toml has no rea table and no REA path (work=' + work + ')', () => {
    const home = mkdtempSync(join(tmpdir(), 'uninstall-rea-codex-'))
    try {
      const r = spawnSync('chezmoi', ['--source', SOURCE, '--destination', home, '--override-data', JSON.stringify({ work }), 'cat', join(home, '.codex/config.toml')], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: home },
      })
      assert.ifError(r.error)
      assert.equal(r.status, 0, r.stderr)
      assert.ok(r.stdout.length > 0)
      assert.doesNotMatch(r.stdout, /mcp_servers\.rea|\/bin\/rea|rea-update/)
      assert.ok(r.stdout.endsWith('\n') && !r.stdout.endsWith('\n\n\n'), JSON.stringify(r.stdout.slice(-40)))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
}

test('no tracked file outside the uninstaller, .chezmoiremove, and tests runs or documents the REA updater', () => {
  const r = spawnSync('git', ['-C', SOURCE, 'ls-files'], { encoding: 'utf8' })
  // An exported tree (no .git) falls back to a walk of the source.
  const files = r.status === 0 && r.stdout.trim()
    ? r.stdout.trim().split('\n')
    : spawnSync('find', ['.', '-type', 'f', '-not', '-path', './.git', '-not', '-path', './.git/*'], { cwd: SOURCE, encoding: 'utf8' }).stdout.trim().split('\n').map((f) => f.replace(/^\.\//, ''))
  assert.ok(files.length > 20, 'the scan found almost no files')
  const allowed = (f) => f === '.chezmoiremove' || f === TEMPLATE || f.startsWith('tests/')
  const hits = files.filter((f) => !allowed(f) && existsSync(join(SOURCE, f)))
    .filter((f) => /rea-update|rea-agents|rea setup|rea doctor|install-rea|mcp_servers\.rea/.test(readFileSync(join(SOURCE, f), 'utf8')))
  assert.deepEqual(hits, [])
})

// An entry written by a Node install that no longer has REA (a later pin
// bump): no rea uninstall can remove it. The script must fail before any npm
// uninstall, so every REA install stays for a later retry or a hand fix.
test('an entry that no installed REA can remove: exit 1, and no npm uninstall ran', () =>
  withSandbox({ versions: ['25.8.0', '26.13.0', '26.4.0'], registeredIn: '25.8.0' }, (sb) => {
    for (const v of ['26.13.0', '26.4.0']) mkdirSync(join(sb.home, '.asdf/installs/nodejs', v, 'lib/node_modules/rea-agents'), { recursive: true })
    const r = sb.run()
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), [UNINSTALL, UN('26.4.0')])
    for (const v of ['26.13.0', '26.4.0']) {
      assert.ok(existsSync(join(sb.home, '.asdf/installs/nodejs', v, 'bin/rea')), v + ' bin/rea')
      assert.ok(existsSync(join(sb.home, '.asdf/installs/nodejs', v, 'lib/node_modules/rea-agents')), v + ' lib/node_modules/rea-agents')
    }
    assert.ok(r.stderr.includes('  an MCP entry named rea in ' + join(sb.home, '.claude.json')), r.stderr)
  }))

// --- Added by the tester (gate round 2) ------------------------------------
//
// What a pass proves (on top of the above): each npm uninstall runs with its
// own version's bin/ first on PATH. A rea uninstall that fails in a later
// install, after an earlier one already removed things, still stops before
// any npm uninstall, and a rerun after the cause is gone finishes the job. A
// failed rea uninstall that changed ~/.codex/config.toml gets chezmoi's bytes
// back before the script exits. Entries written by two different installs
// (one per client file) are both removed. The documented recovery for an
// entry no installed REA owns ("remove them by hand, then run chezmoi apply")
// works: reruns fail the same way without side effects until the entry is
// gone, then the next run uninstalls everything.

test('npm uninstall runs with that version\'s bin first on PATH (npm lifecycle scripts resolve node there)', () =>
  withSandbox({}, (sb) => {
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.npmPaths(), ['26.13.0', '26.4.0'].map((v) => join(sb.home, '.asdf/installs/nodejs', v, 'bin')))
  }))

test('rea uninstall fails only in the second install: exit 1 after both ran, no npm uninstall, every bin/rea stays; a clean rerun finishes', () =>
  withSandbox({}, (sb) => {
    const r = sb.run({ STUB_REA_RC: '4', STUB_REA_RC_IN: '26.4.0' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.deepEqual(sb.calls(), [UNINSTALL, UN('26.4.0')])
    assert.match(r.stderr, /rea uninstall --purge-data exited 4/)
    for (const v of ['26.13.0', '26.4.0']) assert.ok(existsSync(join(sb.home, '.asdf/installs/nodejs', v, 'bin/rea')), v)
    // The first install already removed the entries; the retry must not trip on that.
    const again = sb.run()
    assert.equal(again.status, 0, again.stdout + again.stderr)
    assert.deepEqual(sb.calls().slice(2), FULL)
    assert.deepEqual(reaKeyLeft(sb.home), [])
  }))

for (const change of ['edit', 'delete']) {
  test(`rea uninstall fails after a ${change} of ~/.codex/config.toml: chezmoi's bytes are back before the exit 1`, () =>
    withSandbox({}, (sb) => {
      const r = sb.run({ STUB_REA_RC: '2', STUB_REA_CODEX: change })
      assert.equal(r.status, 1, r.stdout + r.stderr)
      assert.equal(readFileSync(join(sb.home, '.codex/config.toml'), 'utf8'), CODEX)
      assert.match(r.stderr, /rea uninstall --purge-data exited 2/)
      assert.deepEqual(sb.calls(), [UNINSTALL])
    }))
}

test('the Claude Code entry from one install and the opencode entry from another: both removed, exit 0', () =>
  withSandbox({ registeredIn: '26.4.0' }, (sb) => {
    writeFileSync(join(sb.home, '.claude.json'), CLAUDE_WITH_REA(sb.home, '26.13.0'))
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(reaKeyLeft(sb.home), [])
    assert.deepEqual(sb.calls(), FULL)
  }))

test('an entry no installed REA owns: reruns fail the same way and change nothing; after a hand removal the next run uninstalls everything', () =>
  withSandbox({ versions: ['25.8.0', '26.13.0', '26.4.0'], registeredIn: '25.8.0' }, (sb) => {
    const first = sb.run()
    assert.equal(first.status, 1, first.stdout + first.stderr)
    const second = sb.run()
    assert.equal(second.status, 1, second.stdout + second.stderr)
    assert.equal(second.stderr, first.stderr)
    // Only the rea uninstall runs again; no npm uninstall, no reshim.
    assert.deepEqual(sb.calls(), [UNINSTALL, UN('26.4.0'), UNINSTALL, UN('26.4.0')])
    for (const v of ['26.13.0', '26.4.0']) assert.ok(existsSync(join(sb.home, '.asdf/installs/nodejs', v, 'bin/rea')), v)
    // The hand fix the message asks for: drop the rea entries.
    writeFileSync(join(sb.home, '.claude.json'), '{"mcpServers":{"parallel":{}}}\n')
    writeFileSync(join(sb.home, '.config/opencode/opencode.json'), '{"mcp":{"parallel":{}}}\n')
    const third = sb.run()
    assert.equal(third.status, 0, third.stdout + third.stderr)
    assert.deepEqual(sb.calls().slice(4), FULL)
  }))

// PROPOSED CONTRACT (not agreed by the maker; todo so it does not fail the
// suite): a run that fails after the npm uninstalls (asdf missing or reshim
// failing) leaves ~/.asdf/shims/rea. The retry then takes the "REA is not
// installed" path, exits 0 without a reshim, and chezmoi never runs the script
// again, so the dead shim stays first on PATH. Real asdf 0.20.2 removes that
// shim on reshim (checked in Docker).
test('PROPOSED CONTRACT: a retry after a failed reshim still reshims while ~/.asdf/shims/rea is left', { todo: true }, () =>
  withSandbox({}, (sb) => {
    exe(join(sb.home, '.asdf/shims/rea'), '#!/bin/sh\n')
    assert.equal(sb.run({ STUB_ASDF_RC: '1' }).status, 1)
    const before = sb.calls().length
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(sb.calls().slice(before), ['asdf reshim nodejs'], sb.calls().join('\n'))
  }))

// PROPOSED CONTRACT: npm's bin/rea is a symlink into lib/node_modules. If that
// package dir is gone but the link stays, the glob still finds it, node fails
// to load it, and every hourly apply fails with "rea uninstall --purge-data
// exited 1" and no hint of the cause. A dangling bin/rea is arguably not an
// install to run.
test('PROPOSED CONTRACT: a dangling bin/rea symlink is not treated as an install that must run', { todo: true }, () =>
  withSandbox({ withRea: ['26.13.0'], installed: false }, (sb) => {
    const bin = join(sb.home, '.asdf/installs/nodejs/26.4.0/bin/rea')
    spawnSync('ln', ['-s', '../lib/node_modules/rea-agents/dist/cli.js', bin])
    const r = sb.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
  }))
