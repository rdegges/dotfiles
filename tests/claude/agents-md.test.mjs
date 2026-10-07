// dot_claude/CLAUDE.md.tmpl renders two targets: ~/.claude/CLAUDE.md, and
// ~/.codex/AGENTS.md through dot_codex/AGENTS.md.tmpl with reader=codex.
//
// Run from the repo root (chezmoi is needed; without it every test FAILS, it
// does not skip):
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin && node --test tests/claude/'
//
// What a pass proves: for work=false and work=true, chezmoi renders both real
// targets from this source tree with a throwaway HOME; neither render is empty;
// the Codex render ends in one newline and has no run of blank lines; every
// Claude sentence that names no Claude-only tool reaches Codex word for word
// (so a shared rule cannot drift between the two); the Codex render names no
// Claude product or Claude-only tool; Delegation is Claude-only; Work tracking
// follows the work flag in both; and Codex carries the Navia standing
// exception that the navia-fsa-claims skill cites. It also proves the old
// ~/AGENTS.md stays retired: rendered .chezmoiremove lists it, no source entry
// renders a file there, and a real apply (twice) deletes a stale file or
// symlink there while every nested project AGENTS.md survives. It says nothing about how either agent reads the
// text; that needs a live session. The gate checks below prove Codex gets the
// open-a-PR-and-stop rule in place of Claude's gate machinery, Claude keeps
// that machinery, and an apply deletes only the top-level
// ~/.codex/agents/*.toml copies.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SOURCE = new URL('../../', import.meta.url).pathname
const CLAUDE_ONLY = ['switch_browser', 'WebFetch', 'WebSearch', 'codex-computer-use', 'Bash tool', 'mcp__', 'acceptance-gate', 'tester', 'red-team-reviewer', 'bdfl', 'planner']
const DELEGATION = '## Delegation (work machine)'
const WORK_TRACKING = '## Work tracking (work machine)'

function render(target, work) {
  const home = mkdtempSync(join(tmpdir(), 'agents-md-'))
  try {
    const r = spawnSync(
      'chezmoi',
      ['--source', SOURCE, '--destination', home, '--override-data', JSON.stringify({ work }), 'cat', join(home, target)],
      { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } },
    )
    assert.ifError(r.error)
    assert.equal(r.status, 0, `chezmoi cat ${target} (work=${work}) exited ${r.status}: ${r.stderr}`)
    assert.ok(r.stdout.length > 0, `chezmoi cat ${target} (work=${work}) printed nothing`)
    return r.stdout
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function managed(work) {
  const home = mkdtempSync(join(tmpdir(), 'agents-md-'))
  try {
    const r = spawnSync(
      'chezmoi',
      ['--source', SOURCE, '--destination', home, '--override-data', JSON.stringify({ work }), 'managed'],
      { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } },
    )
    assert.ifError(r.error)
    assert.equal(r.status, 0, `chezmoi managed (work=${work}) exited ${r.status}: ${r.stderr}`)
    return r.stdout.split('\n')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function withoutDelegation(text) {
  return text.replace(/^## Delegation \(work machine\)\n[\s\S]*?(?=^## )/m, '')
}

// Codex swaps both gate bullets whole, so none of their sentences is shared,
// even the ones that name no Claude-only tool.
function withoutGates(text) {
  return text.replace(/^- (Non-trivial changes merge only when|Every plan goes through) .*\n/gm, '')
}

// The worktree cleanup bullet is Claude-only: Codex has no harness worktrees.
function withoutCleanup(text) {
  return text.replace(/^- After a PR merges or is abandoned, clean up the worktrees[^\n]*\n/m, '')
}

// Lines, less list markers, cut at sentence ends. A wrong cut only makes the
// pieces smaller, which keeps the word-for-word check sound.
function sentences(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/^(- |#+ )/, '').trim())
    .filter(Boolean)
    .flatMap((l) => l.split(/(?<=[.!?])\s+(?=[A-Z*`"~])/))
}

// chezmoi renders .chezmoiremove as a template, so the raw file can list a
// pattern that the render drops (an `if`, a comment that swallows it).
test('.chezmoiremove retires the top-level ~/AGENTS.md once rendered', () => {
  const home = mkdtempSync(join(tmpdir(), 'agents-md-'))
  try {
    const r = spawnSync(
      'chezmoi',
      ['--source', SOURCE, '--destination', home, 'execute-template'],
      { encoding: 'utf8', input: readFileSync(join(SOURCE, '.chezmoiremove'), 'utf8'), env: { PATH: process.env.PATH, HOME: home } },
    )
    assert.ifError(r.error)
    assert.equal(r.status, 0, `chezmoi execute-template exited ${r.status}: ${r.stderr}`)
    assert.ok(r.stdout.split('\n').includes('AGENTS.md'), JSON.stringify(r.stdout))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// Seeds a throwaway HOME the way a real one looks (a stale ~/AGENTS.md next
// to project AGENTS.md files the user owns), runs a real apply twice, and
// hands the HOME to check. Scripts and externals stay off: they install
// software and fetch from the network.
function applied(work, seed, check) {
  const home = mkdtempSync(join(tmpdir(), 'agents-md-'))
  try {
    seed(home)
    for (const pass of [1, 2]) {
      const r = spawnSync(
        'chezmoi',
        ['--source', SOURCE, '--destination', home, '--override-data', JSON.stringify({ work }), '--no-tty', 'apply', '--force', '--exclude=scripts,externals'],
        { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } },
      )
      assert.ifError(r.error)
      assert.equal(r.status, 0, `chezmoi apply pass ${pass} (work=${work}) exited ${r.status}: ${r.stderr}`)
      check(home, pass)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function project(home, dir) {
  mkdirSync(join(home, dir), { recursive: true })
  writeFileSync(join(home, dir, 'AGENTS.md'), `project rules in ${dir}\n`)
}

for (const work of [false, true]) {
  const claude = () => render('.claude/CLAUDE.md', work)
  const codex = () => render('.codex/AGENTS.md', work)

  test(`work=${work}: both targets render`, () => {
    claude()
    codex()
  })

  test(`work=${work}: Codex render ends in one newline and has no run of blank lines`, () => {
    const c = codex()
    assert.ok(c.endsWith('\n') && !c.endsWith('\n\n'), JSON.stringify(c.slice(-20)))
    assert.equal(c.indexOf('\n\n\n'), -1)
  })

  test(`work=${work}: Claude render has no run of blank lines it did not already have`, () => {
    // The blank line pair before Delegation predates the Codex render; the
    // Claude target stays byte-identical, so it is the one allowed run.
    const c = claude().replace(`\n\n\n${DELEGATION}`, `\n\n${DELEGATION}`)
    assert.equal(c.indexOf('\n\n\n'), -1)
  })

  test(`work=${work}: every shared Claude sentence appears word for word in Codex`, () => {
    const c = codex()
    const shared = sentences(withoutGates(withoutCleanup(withoutDelegation(claude())))).filter(
      (s) => !/claude/i.test(s) && !CLAUDE_ONLY.some((t) => s.includes(t)),
    )
    assert.ok(shared.length > 40, `only ${shared.length} shared sentences found`)
    const missing = shared.filter((s) => !c.includes(s))
    assert.deepEqual(missing, [])
  })

  test(`work=${work}: Codex render names no Claude product or Claude-only tool`, () => {
    const c = codex()
    assert.doesNotMatch(c, /claude/i)
    for (const t of CLAUDE_ONLY) assert.ok(!c.includes(t), `Codex render contains ${t}`)
  })

  test(`work=${work}: Delegation is Claude-only`, () => {
    assert.ok(!codex().includes(DELEGATION))
    assert.equal(claude().includes(DELEGATION), work)
  })

  test(`work=${work}: Work tracking renders in both targets only on a work machine`, () => {
    assert.equal(claude().includes(WORK_TRACKING), work)
    assert.equal(codex().includes(WORK_TRACKING), work)
  })

  test(`work=${work}: no source entry renders a top-level ~/AGENTS.md`, () => {
    const targets = managed(work)
    // A real target proves the list is not empty for some unrelated reason.
    assert.ok(targets.includes('.codex/AGENTS.md'), 'chezmoi managed does not list .codex/AGENTS.md')
    assert.ok(!targets.includes('AGENTS.md'))
  })

  test(`work=${work}: apply deletes a stale ~/AGENTS.md and keeps every nested AGENTS.md`, () => {
    applied(
      work,
      (home) => {
        writeFileSync(join(home, 'AGENTS.md'), 'stale copy\n')
        project(home, 'Code/rdegges/site')
        project(home, 'Code/work/snyk/cli')
        project(home, '.config/thing')
      },
      (home, pass) => {
        assert.ok(!existsSync(join(home, 'AGENTS.md')), `pass ${pass}: ~/AGENTS.md survived`)
        for (const dir of ['Code/rdegges/site', 'Code/work/snyk/cli', '.config/thing']) {
          assert.equal(readFileSync(join(home, dir, 'AGENTS.md'), 'utf8'), `project rules in ${dir}\n`, `pass ${pass}: ${dir}/AGENTS.md changed`)
        }
        assert.match(readFileSync(join(home, '.codex/AGENTS.md'), 'utf8'), /^# /, `pass ${pass}: ~/.codex/AGENTS.md not rendered`)
      },
    )
  })

  test(`work=${work}: apply removes a ~/AGENTS.md symlink but not the file it points at`, () => {
    applied(
      work,
      (home) => {
        project(home, 'Code/rdegges/site')
        symlinkSync(join(home, 'Code/rdegges/site/AGENTS.md'), join(home, 'AGENTS.md'))
      },
      (home, pass) => {
        assert.throws(() => lstatSync(join(home, 'AGENTS.md')), { code: 'ENOENT' }, `pass ${pass}: ~/AGENTS.md link survived`)
        assert.equal(readFileSync(join(home, 'Code/rdegges/site/AGENTS.md'), 'utf8'), 'project rules in Code/rdegges/site\n')
      },
    )
  })

  test(`work=${work}: apply on a HOME with no ~/AGENTS.md creates none`, () => {
    applied(work, () => {}, (home, pass) => {
      assert.throws(() => lstatSync(join(home, 'AGENTS.md')), { code: 'ENOENT' }, `pass ${pass}: apply created ~/AGENTS.md`)
    })
  })

  test(`work=${work}: Codex carries the Navia standing exception word for word`, () => {
    const m = claude().match(/Standing exception: while you follow the `navia-fsa-claims` skill[^\n]*?needs my confirmation\./)
    assert.ok(m, 'no Navia standing exception in the Claude render')
    assert.ok(codex().includes(m[0]))
  })
}

// Gates. Codex runs no review gates: it gets one open-a-PR-and-stop rule where
// Claude has the gate bullets, and chezmoi deletes its unmanaged agent copies.
const CODEX_PR_RULE = '- Never run review gates or merge a PR. Finish on a branch, open the PR with `gh`, state what you verified (each command and its result), and stop. The PR merges only after a separate review gate passes.\n'
const CLAUDE_GATES = [
  '`verification-gates` skill.\n- Non-trivial changes merge only when the `acceptance-gate` workflow (tester, then `red-team-reviewer`, then `bdfl`, in one call) returns APPROVE, or APPROVE WITH CONDITIONS once every condition has landed.',
  'Never run those gates one at a time.',
  '\n- Every plan goes through the `bdfl` agent too. On every path, honor its verdict: never merge over REVISE or REJECT, and relay its guidance verbatim. Multi-PR work goes through the `planner` agent first.\n\n## Vault and sessions\n',
  "instead. Only exception: the tester agent's Docker Playwright runs as defined in tester.md (the viewport/color-scheme matrix, and the whole web pass when Chrome is unreachable); the stop-and-wait rule below does not apply to it. Reading a public page",
]
const AGENT_COPIES = ['architect', 'bdfl', 'planner', 'red-team-reviewer', 'tester']

test('.chezmoiremove deletes the Codex agent copies once rendered', () => {
  const home = mkdtempSync(join(tmpdir(), 'agents-md-'))
  try {
    const r = spawnSync(
      'chezmoi',
      ['--source', SOURCE, '--destination', home, 'execute-template'],
      { encoding: 'utf8', input: readFileSync(join(SOURCE, '.chezmoiremove'), 'utf8'), env: { PATH: process.env.PATH, HOME: home } },
    )
    assert.ifError(r.error)
    assert.equal(r.status, 0, `chezmoi execute-template exited ${r.status}: ${r.stderr}`)
    assert.ok(r.stdout.split('\n').includes('.codex/agents/*.toml'), JSON.stringify(r.stdout))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

for (const work of [false, true]) {
  const claude = () => render('.claude/CLAUDE.md', work)
  const codex = () => render('.codex/AGENTS.md', work)

  test(`work=${work}: Codex gets the PR rule in place of the gate bullets`, () => {
    const cx = codex()
    assert.ok(cx.includes('`verification-gates` skill.\n' + CODEX_PR_RULE + '\n## Vault and sessions\n'), 'Codex render lacks the PR rule in place')
    assert.ok(cx.includes('or Computer Use instead. Reading a public page with web search is not a browser task.'))
    for (const t of ['acceptance-gate', 'tester.md', 'red-team-reviewer', 'bdfl', 'planner']) assert.ok(!cx.includes(t), `Codex render contains ${t}`)
  })

  test(`work=${work}: Claude keeps the gate bullets and the tester exception`, () => {
    const cl = claude()
    for (const t of CLAUDE_GATES) assert.ok(cl.includes(t), `Claude render lacks ${JSON.stringify(t.slice(0, 60))}`)
    assert.ok(!cl.includes(CODEX_PR_RULE), 'Claude render contains the Codex PR rule')
  })

  test(`work=${work}: apply deletes ~/.codex/agents/*.toml and keeps the rest of ~/.codex`, () => {
    applied(
      work,
      (home) => {
        mkdirSync(join(home, '.codex/agents/nested'), { recursive: true })
        for (const n of AGENT_COPIES) writeFileSync(join(home, '.codex/agents', `${n}.toml`), `name = "${n}"\n`)
        writeFileSync(join(home, '.codex/agents/notes.md'), 'mine\n')
        writeFileSync(join(home, '.codex/agents/nested/keep.toml'), 'mine\n')
        writeFileSync(join(home, '.codex/AGENTS.md'), 'stale\n')
        writeFileSync(join(home, '.codex/config.toml'), 'stale\n')
      },
      (home, pass) => {
        for (const n of AGENT_COPIES) {
          assert.throws(() => lstatSync(join(home, '.codex/agents', `${n}.toml`)), { code: 'ENOENT' }, `pass ${pass}: ${n}.toml survived`)
        }
        assert.ok(lstatSync(join(home, '.codex/agents')).isDirectory(), `pass ${pass}: ~/.codex/agents is gone`)
        assert.equal(readFileSync(join(home, '.codex/agents/notes.md'), 'utf8'), 'mine\n', `pass ${pass}: notes.md changed`)
        assert.equal(readFileSync(join(home, '.codex/agents/nested/keep.toml'), 'utf8'), 'mine\n', `pass ${pass}: nested .toml changed`)
        assert.ok(readFileSync(join(home, '.codex/AGENTS.md'), 'utf8').startsWith('# Global AGENTS.md'), `pass ${pass}: ~/.codex/AGENTS.md not rendered`)
        assert.equal(readFileSync(join(home, '.codex/config.toml'), 'utf8'), readFileSync(join(SOURCE, 'dot_codex/config.toml'), 'utf8'), `pass ${pass}: ~/.codex/config.toml not applied`)
      },
    )
  })
}

// Tester additions. The checks above prove the Codex side drops Claude-only
// text; these prove each side still says what it should, so a swapped or
// emptied {{ if $codex }} branch cannot pass silently.
const CODEX_ONLY = [
  'the Codex Chrome plugin (`chrome`, which drives my real Chrome through the ChatGPT Chrome Extension)',
  'or Computer Use instead',
  'Reading a public page with web search is not a browser task.',
  'none chosen: ask me which one to use.',
  'switch to the Codex Chrome plugin.',
  'the ChatGPT Chrome Extension installed and signed in to my ChatGPT account',
]

for (const work of [false, true]) {
  const claude = () => render('.claude/CLAUDE.md', work)
  const codex = () => render('.codex/AGENTS.md', work)

  test(`work=${work}: each target names its own rules file in the title and precedence line`, () => {
    const cl = claude()
    const cx = codex()
    assert.ok(cl.startsWith('# Global CLAUDE.md – Personal Defaults\n'), JSON.stringify(cl.slice(0, 60)))
    assert.ok(cx.startsWith('# Global AGENTS.md – Personal Defaults\n'), JSON.stringify(cx.slice(0, 60)))
    assert.match(cl, /Project `CLAUDE\.md` rules win on conflict\./)
    assert.match(cx, /Project `AGENTS\.md` rules win on conflict\./)
  })

  test(`work=${work}: Claude render keeps every Claude-only tool clause`, () => {
    const cl = claude()
    for (const t of CLAUDE_ONLY) assert.ok(cl.includes(t), `Claude render lost ${t}`)
    assert.ok(cl.includes('and the Bash tool runs every command inside one.'))
    assert.ok(cl.includes('`/chrome` in Claude Code to connect or reconnect'))
  })

  test(`work=${work}: Claude render carries no Codex-only replacement text`, () => {
    const cl = claude()
    for (const t of CODEX_ONLY) assert.ok(!cl.includes(t), `Claude render contains ${t}`)
  })

  test(`work=${work}: Codex render carries every Codex replacement clause`, () => {
    const cx = codex()
    for (const t of CODEX_ONLY) assert.ok(cx.includes(t), `Codex render lacks ${t}`)
    assert.ok(cx.includes('`set -e` is no guard: it is off inside `&&`/`||` lists and `if` tests.\n'))
  })

  test(`work=${work}: neither render leaks template syntax`, () => {
    for (const r of [claude(), codex()]) assert.doesNotMatch(r, /\{\{|\}\}|\$codex|<no value>/)
  })
}

// Agent worktrees: Claude's harness parks them under <repo>/.claude/worktrees,
// so the porcelain exception and the cleanup bullet are Claude-only. Codex
// gets neither porcelain rule: it runs no gates. Each SAFETY entry is one
// guard; deleting any of them from the template turns this test red.
const PORCELAIN = 'Launch the next gate only when `git status --porcelain` is empty, and name any leftover path to me.'
const PORCELAIN_CLAUDE = 'Launch the next gate only when `git status --porcelain` is empty, or when `git status --porcelain -uall` prints only `?? .claude/worktrees/agent-*/` lines and `git -C <wt> status --porcelain` exits 0 and prints nothing in each of those worktrees, and name any leftover path to me.'
const CLEANUP = '- After a PR merges or is abandoned, clean up the worktrees its implementer, tester, and gates reported.'
const SAFETY = [
  'Use the exact paths from their reports and never pick worktrees by pattern, because another agent may be working in one.',
  'First run `git -C <repo> fetch -q origin`.',
  'Run `git worktree remove` (never `--force`) on a worktree only when `git -C <wt> status --porcelain` exits 0 and prints nothing, and one of these holds:',
  '`git -C <wt> merge-base --is-ancestor HEAD origin/<base>` passes',
  'or `gh pr view <n> --json state,headRefOid` shows `MERGED` and `headRefOid` equals `git -C <wt> rev-parse HEAD`.',
  'Then run `git worktree prune` and delete the branches those agents created.',
  'Use `git branch -d`, or `git branch -D` only for a branch whose tip equals that merged `headRefOid`.',
  'Name to me any worktree that is dirty, unmerged, or orphaned (a dir under `.claude/worktrees` that `git worktree list` does not show), and any branch that `git branch -d` refuses and `git branch -D` is not allowed to delete, and leave them in place.',
]

for (const work of [false, true]) {
  test(`work=${work}: agent worktree rules render for Claude only`, () => {
    const cl = render('.claude/CLAUDE.md', work)
    const cx = render('.codex/AGENTS.md', work)
    assert.ok(cl.includes(PORCELAIN_CLAUDE), 'Claude render lacks the per-worktree porcelain exception')
    assert.ok(cl.includes(`\n${CLEANUP} `), 'Claude render lacks the worktree cleanup bullet')
    for (const s of SAFETY) assert.ok(cl.includes(s), `Claude render lost: ${s}`)
    assert.ok(!cx.includes(PORCELAIN), 'Codex render contains the gate porcelain rule')
    assert.ok(!cx.includes(CLEANUP), 'Codex render contains the worktree cleanup bullet')
    assert.ok(!cx.includes('.claude/worktrees'))
    assert.ok(!cx.includes('headRefOid'))
  })
}
