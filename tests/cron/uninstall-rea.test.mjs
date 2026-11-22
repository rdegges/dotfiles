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
// run): with REA in two Node versions, it runs `rea uninstall --purge-data`
// once, through the first version's own node and with no stdin, then
// `npm uninstall --global rea-agents` through each of those versions' own node
// and npm (never in a version without REA), then `asdf reshim nodejs`, and
// exits 0. It removes skill folders that REA leaves, puts ~/.codex/config.toml
// back byte for byte when REA edits or deletes it, and exits 1 when an MCP
// entry is left. With no bin/rea anywhere it makes no call and exits 0 only
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
// rea uninstall: logs its args and how much stdin it got. STUB_REA_RC fails it.
// It removes the client entries and skill folders unless STUB_REA_KEEP names
// what it leaves (skills, mcp). STUB_REA_CODEX=edit|delete changes Codex's file.
const REA = `#!/bin/sh
echo "rea $* stdin=$(cat | wc -c | tr -d ' ')" >> "$CALLS"
[ -n "\${STUB_REA_RC:-}" ] && exit "$STUB_REA_RC"
case "\${STUB_REA_CODEX:-}" in
  edit) printf '%s\\n' '# rea was here' >> "$HOME/.codex/config.toml" ;;
  delete) rm -f "$HOME/.codex/config.toml" ;;
esac
case " \${STUB_REA_KEEP:-} " in *" mcp "*) ;; *)
  for f in "$HOME/.claude.json" "$HOME/.config/opencode/opencode.json"; do
    [ -f "$f" ] && printf '%s\\n' '{"mcpServers":{"parallel":{}}}' > "$f"
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
[ -n "\${STUB_NPM_RC:-}" ] && exit "$STUB_NPM_RC"
[ -n "\${STUB_NPM_KEEP:-}" ] || rm -f "$(dirname "$0")/rea"
exit 0
`
const ASDF = '#!/bin/sh\necho "asdf $*" >> "$CALLS"\nexit "${STUB_ASDF_RC:-0}"\n'

const CLAUDE_WITH_REA = '{"numStartups":3,"mcpServers":{"parallel":{"type":"http"},"rea":{"command":"node"}}}\n'
const OPENCODE_WITH_REA = '{"mcp":{"parallel":{"type":"remote"},\n  "rea" : {"type":"local"}}}\n'
const CODEX = 'approval_policy = "never"\n\n[mcp_servers.parallel]\nurl = "https://search.parallel.ai/mcp"\n'

// versions: Node versions to create; withRea: those that get bin/rea.
// installed: whether REA's client entries and skill folders exist.
function sandbox({ versions = ['26.13.0', '26.4.0', '28.0.0'], withRea = ['26.13.0', '26.4.0'], installed = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'uninstall-rea-'))
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
    writeFileSync(join(home, '.claude.json'), CLAUDE_WITH_REA)
    writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), OPENCODE_WITH_REA)
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
    calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean),
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

const UNINSTALL = 'node(26.13.0) rea uninstall --purge-data stdin=0'
const NPM_UN = (v) => `node(${v}) npm uninstall --global rea-agents`
const FULL = [UNINSTALL, NPM_UN('26.13.0'), NPM_UN('26.4.0'), 'asdf reshim nodejs']
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

test('installed in two Node versions: one rea uninstall, npm uninstall in each, reshim; exit 0', () =>
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
  withSandbox({ withRea: ['26.4.0'] }, (sb) => {
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
    assert.ok(r.stderr.includes(`an MCP entry named rea in ${join(sb.home, '.claude.json')}`), r.stderr)
    assert.ok(r.stderr.includes(`an MCP entry named rea in ${join(sb.home, '.config/opencode/opencode.json')}`), r.stderr)
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
    assert.deepEqual(sb.calls(), [UNINSTALL, NPM_UN('26.13.0')])
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
  ['a rea entry in ~/.claude.json', (h) => writeFileSync(join(h, '.claude.json'), CLAUDE_WITH_REA), '.claude.json'],
  ['a rea entry in opencode.json', (h) => writeFileSync(join(h, '.config/opencode/opencode.json'), OPENCODE_WITH_REA), '.config/opencode/opencode.json'],
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
