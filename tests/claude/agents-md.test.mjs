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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SOURCE = new URL('../../', import.meta.url).pathname
const CLAUDE_ONLY = ['switch_browser', 'WebFetch', 'WebSearch', 'codex-computer-use', 'Bash tool', 'mcp__', 'acceptance-gate', 'tester', 'red-team-reviewer', 'bdfl', 'planner', 'Gate REVISE rounds', 'SendMessage', 'gate-protocol', 'pkms:']
const DELEGATION = '## Delegation (work machine)'
const WORK_TRACKING = '## Work tracking (work machine)'

// extra merges more template data, e.g. { chezmoi: { os: 'darwin' } } for the
// real personal Mac, which renders more than the default Linux container does.
function render(target, work, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agents-md-'))
  try {
    const r = spawnSync(
      'chezmoi',
      ['--source', SOURCE, '--destination', home, '--override-data', JSON.stringify({ work, ...extra }), 'cat', join(home, target)],
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
  return text.replace(/^- (Non-trivial changes merge only when|Before you launch a gate|Every plan goes through) .*\n/gm, '')
}

// The subagent resume bullet is Claude-only: it names SendMessage. (The
// worktree cleanup bullet this also stripped lives in the gate-protocol skill now.)
function withoutCleanup(text) {
  return text.replace(/^- A subagent that stops on a network or API error[^\n]*\n/m, '')
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

  // Only Codex has the navia-fsa-claims skill (dot_codex/skills), so only its
  // rules carry the exception that the skill relies on.
  test(`work=${work}: the Navia standing exception renders for Codex only, in the irreversible-step bullet`, () => {
    const NAVIA = "ask me before doing it in Chrome. Standing exception: while you follow the `navia-fsa-claims` skill, my request to submit a Navia FSA claim authorizes that claim's final **Send claim to Navia** once its details match the source documents; accepting Navia's terms still needs my confirmation.\n"
    assert.ok(codex().includes(NAVIA), 'Codex render lacks the Navia standing exception')
    for (const t of [claude(), render('.config/opencode/AGENTS.md', work)]) assert.ok(!/Navia|Standing exception/.test(t), 'a render without the skill carries the Navia exception')
    assert.ok(claude().includes('ask me before doing it in Chrome.\n'))
  })

  // Outside the $claude block, so every reader gets it. opencode is checked
  // directly too: the byte-identity test in opencode-rules.test.mjs would still
  // pass if Codex and opencode both lost the bullet.
  test(`work=${work}: the inline-script rule renders whole, once, in the Environment section of Claude, Codex, and opencode`, () => {
    const INLINE = "- Never inline a multi-line script in a quoted `ssh`, `docker`, or `bash -c` string: write it to a local file and feed it on stdin (`ssh -T host python3 - < f`, `docker exec -i c sh < f`), or upload it first (`ssh host 'cat > f' < f`).\n"
    for (const [name, t] of [['Claude', claude()], ['Codex', codex()], ['opencode', render('.config/opencode/AGENTS.md', work)]]) {
      assert.equal(t.split(INLINE).length - 1, 1, `${name}: inline-script bullet is missing, reworded, or repeated`)
      const env = t.match(/^## Environment\n([\s\S]*?)(?=^## )/m)
      assert.ok(env, `${name}: no ## Environment section`)
      assert.ok(env[1].includes(INLINE), `${name}: inline-script bullet is outside ## Environment`)
    }
  })
}

// Gates. Codex runs no review gates: it gets one open-a-PR-and-stop rule where
// Claude has the gate bullets, and chezmoi deletes its unmanaged agent copies.
const CODEX_PR_RULE = '- Never run review gates or merge a PR. Finish on a non-default branch, open the PR with `gh`, watch its checks, state what you verified (each command and its result), and stop. The PR merges only after a separate review gate passes. When the prompt asks you only to review, or to leave your changes uncommitted, do exactly that and skip the branch and PR.\n'
const CLAUDE_GATES = [
  '`verification-gates` skill.\n- Non-trivial changes merge only when the `acceptance-gate` workflow (tester, then `red-team-reviewer`, then `bdfl`, in one call) returns APPROVE, or APPROVE WITH CONDITIONS once every condition has landed.',
  'Never run those gates one at a time.',
  '\n- Every plan goes through the `bdfl` agent too, with or without a repo (host and account changes count), before the first write it covers; read-only probes may run first. On every path, honor its verdict: never merge over REVISE or REJECT, and relay its guidance verbatim. Multi-PR work goes through the `planner` agent first.\n- A subagent that stops on a network or API error',
  'Resume that same agent with `SendMessage` and ask it to continue. Never start a new agent for the same task: a new agent loses the context the old one built. If `SendMessage` cannot reach it (the agent ran inside a workflow, or you lack the tool), rerun it once and tell me the first run dropped. If the rerun also fails, stop and tell me.\n\n## Vault and sessions\n',
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

  test(`work=${work}: the bdfl plan rule covers repo-less plans, before the first write, after read-only probes`, () => {
    const line = claude().split('\n').find((l) => l.startsWith('- Every plan goes through the `bdfl` agent too'))
    assert.ok(line, 'Claude render lacks the bdfl plan rule')
    assert.match(line, /before the first write it covers/)
    assert.match(line, /with or without a repo \(host and account changes count\)/)
    assert.match(line, /read-only probes may run first/)
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
        const config = spawnSync('chezmoi', ['--source', SOURCE, '--destination', home, '--override-data', JSON.stringify({ work }), 'execute-template'], {
          encoding: 'utf8',
          input: readFileSync(join(SOURCE, 'dot_codex/config.toml.tmpl'), 'utf8'),
          env: { PATH: process.env.PATH, HOME: home },
        })
        assert.equal(config.status, 0, config.stderr)
        assert.equal(readFileSync(join(home, '.codex/config.toml'), 'utf8'), config.stdout, `pass ${pass}: ~/.codex/config.toml not applied`)
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
  "- Use only your own browser tool. When a skill or rule names another agent's browser tool, use yours in its place.\n",
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
    // The steps live in the gate-protocol skill, word for word; the rules
    // that load in every session carry one pointer to it.
    const skill = readFileSync(join(SOURCE, 'dot_claude/skills/gate-protocol/SKILL.md'), 'utf8')
    assert.ok(skill.includes(`\n- ${PORCELAIN_CLAUDE}\n`), 'gate-protocol lacks the per-worktree porcelain exception')
    assert.ok(skill.includes(`\n${CLEANUP} `), 'gate-protocol lacks the worktree cleanup bullet')
    for (const s of SAFETY) assert.ok(skill.includes(s), `gate-protocol lost: ${s}`)
    assert.ok(skill.includes("- When it returns, commit the files the tester's report lists under Tests added/modified, as they are (red included), in their own commit on the branch under review, and push it if the branch has a remote; delete tests meant to be ephemeral (scratch probes, throwaway harnesses) instead.\n"))
    assert.match(skill, /^---\nname: gate-protocol\ndescription: "Load before you launch the acceptance-gate workflow, when a gate returns, and after a PR merges or is abandoned\./)
    assert.ok(cl.includes('\n- Before you launch a gate, when a gate returns, and after a PR merges or is abandoned, load the `gate-protocol` skill and follow it: '), 'Claude render lacks the pointer to gate-protocol')
    for (const t of [PORCELAIN, CLEANUP, 'headRefOid', '.claude/worktrees', 'Tests added/modified']) assert.ok(!cl.includes(t), `Claude render still carries the moved text: ${t}`)
    assert.ok(!cx.includes(PORCELAIN), 'Codex render contains the gate porcelain rule')
    assert.ok(!cx.includes(CLEANUP), 'Codex render contains the worktree cleanup bullet')
    assert.ok(!cx.includes('.claude/worktrees'))
    assert.ok(!cx.includes('headRefOid'))
  })
}

// Tester additions for the Codex PR rule (PR #38). The rule replaces only the
// gate bullets: the rules Codex still needs to produce a trustworthy PR must
// survive the swap, and the agent-copy removal must cover every agent this
// source tree manages, not only the five the seed above names.
const CODEX_KEEPS = [
  '- Never say "done", "should work", or "tests pass" without fresh evidence from a command you ran in this session.\n',
  '- A gate must state what a pass proves and fail closed on "cannot evaluate" (tool missing, empty input, API cap). Details: `verification-gates` skill.\n',
  '- Three-strike rule: after 3 failed fixes, stop and question the design with me before fix #4.',
  '- GitHub for hosting, `gh` for everything GitHub, GitHub Actions for CI. After a push, watch the checks with `gh` and fix what breaks.',
]

const SOURCE_AGENTS = readdirSync(join(SOURCE, 'dot_claude/agents'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.slice(0, -3))

for (const work of [false, true]) {
  const codex = () => render('.codex/AGENTS.md', work)

  test(`work=${work}: Codex keeps the evidence, fail-closed, three-strike, and CI-watch rules`, () => {
    const cx = codex()
    for (const t of CODEX_KEEPS) assert.ok(cx.includes(t), `Codex render lost: ${t.trim()}`)
  })

  test(`work=${work}: Codex "Verification and gates" is exactly evidence, fail-closed, PR rule`, () => {
    const m = codex().match(/^## Verification and gates\n\n([\s\S]*?)\n## /m)
    assert.ok(m, 'no Verification and gates section in the Codex render')
    assert.equal(m[1], CODEX_KEEPS[0] + CODEX_KEEPS[1] + CODEX_PR_RULE)
  })

  test(`work=${work}: apply deletes a Codex .toml copy of every agent the source manages`, () => {
    assert.ok(SOURCE_AGENTS.length >= 8, `only ${SOURCE_AGENTS.length} agents under dot_claude/agents`)
    applied(
      work,
      (home) => {
        mkdirSync(join(home, '.codex/agents'), { recursive: true })
        for (const n of SOURCE_AGENTS) writeFileSync(join(home, '.codex/agents', `${n}.toml`), `name = "${n}"\n`)
      },
      (home, pass) => {
        assert.deepEqual(readdirSync(join(home, '.codex/agents')), [], `pass ${pass}: agent copies survived`)
        for (const n of SOURCE_AGENTS) assert.ok(existsSync(join(home, '.claude/agents', `${n}.md`)), `pass ${pass}: ~/.claude/agents/${n}.md not applied`)
      },
    )
  })

  // Observed chezmoi behavior, pinned so a change to it is noticed: the
  // pattern follows a symlinked ~/.codex/agents into its target and deletes
  // .toml files there, and it deletes a directory named *.toml with its
  // contents. Neither shape exists on the real machine today (eight regular
  // files); this records the blast radius the .chezmoiremove comment omits.
  test(`work=${work}: .codex/agents/*.toml blast radius (symlinked dir, *.toml dir)`, () => {
    applied(
      work,
      (home) => {
        mkdirSync(join(home, 'elsewhere'), { recursive: true })
        writeFileSync(join(home, 'elsewhere/mine.toml'), 'mine\n')
        writeFileSync(join(home, 'elsewhere/keep.md'), 'mine\n')
        mkdirSync(join(home, '.codex'), { recursive: true })
        symlinkSync(join(home, 'elsewhere'), join(home, '.codex/agents'))
      },
      (home, pass) => {
        assert.ok(lstatSync(join(home, '.codex/agents')).isSymbolicLink(), `pass ${pass}: symlink replaced`)
        assert.ok(!existsSync(join(home, 'elsewhere/mine.toml')), `pass ${pass}: chezmoi no longer follows the symlink`)
        assert.equal(readFileSync(join(home, 'elsewhere/keep.md'), 'utf8'), 'mine\n')
      },
    )
    applied(
      work,
      (home) => {
        mkdirSync(join(home, '.codex/agents/dir.toml'), { recursive: true })
        writeFileSync(join(home, '.codex/agents/dir.toml/inner'), 'mine\n')
      },
      (home, pass) => {
        assert.ok(!existsSync(join(home, '.codex/agents/dir.toml')), `pass ${pass}: chezmoi no longer removes a *.toml directory`)
      },
    )
  })

  test(`work=${work}: Codex three-strike rule counts red CI runs, not gate REVISE rounds Codex never sees`, () => {
    const cx = codex()
    assert.ok(!cx.includes('Gate REVISE rounds'))
    assert.ok(cx.includes('before fix #4. Red CI runs count as failed fixes when they hit the same defect class;'))
  })

  test(`work=${work}: Codex PR rule says the branch is not the default branch and honors review-only prompts`, () => {
    const cx = codex()
    assert.match(cx, /Never run review gates or merge a PR\. Finish on a non-default branch/)
    assert.ok(cx.includes('When the prompt asks you only to review, or to leave your changes uncommitted'))
  })

  // Follow-up the PR left open. It is a proposal, not an agreed contract: it
  // stays todo so it does not fail the suite.
  test(`work=${work}: Codex render names no Claude-plugin-only pkms agents or slash skills, and keeps the vault rules`, () => {
    const cx = codex()
    for (const t of ['pkms:librarian', 'pkms:archivist', '/pkms:process-inbox', 'pkms']) assert.ok(!cx.includes(t), `Codex render contains ${t}`)
    assert.ok(cx.includes('Read `Now.md` when the task touches my work, people, or projects. Follow `Preferences.md` §Vault Hygiene on every vault read and write. Never create new top-level folders.\n'))
    assert.ok(cx.includes('and a `Now.md` update when my priorities shift. Vault linting is report-first.\n'))
  })
}

// Tester additions for the subagent resume rule. CLAUDE_GATES pins only the
// bullet's two ends, so the middle clause (a short or cut-off return counts as
// unfinished) could be cut without a red test; this pins the whole bullet, its
// place in the Claude gate block, and its absence from Codex, which has no
// SendMessage to resume with.
const RESUME = '- A subagent that stops on a network or API error, or returns a cut-off result or one without the output format it was asked for, has not finished. Do not act on that result. Resume that same agent with `SendMessage` and ask it to continue. Never start a new agent for the same task: a new agent loses the context the old one built. If `SendMessage` cannot reach it (the agent ran inside a workflow, or you lack the tool), rerun it once and tell me the first run dropped. If the rerun also fails, stop and tell me.\n'

for (const work of [false, true]) {
  const claude = () => render('.claude/CLAUDE.md', work)
  const codex = () => render('.codex/AGENTS.md', work)

  test(`work=${work}: Claude closes "Verification and gates" with the whole resume bullet, once`, () => {
    const cl = claude()
    assert.equal(cl.split(RESUME).length - 1, 1, 'resume bullet is missing, reworded, or repeated')
    const m = cl.match(/^## Verification and gates\n\n([\s\S]*?)\n## /m)
    assert.ok(m, 'no Verification and gates section in the Claude render')
    assert.ok(m[1].endsWith(RESUME), 'resume bullet is not the last bullet of Verification and gates')
  })

  test(`work=${work}: Codex carries no part of the resume bullet`, () => {
    const cx = codex()
    for (const t of ['SendMessage', 'network or API error', 'cut-off result', 'has not finished', 'Resume that same agent', 'Never start a new agent', 'loses the context']) {
      assert.ok(!cx.includes(t), `Codex render contains ${t}`)
    }
  })

  // The shared-sentence check skips what withoutCleanup strips; an over-broad
  // strip would hide drift in neighbouring shared lines.
  test(`work=${work}: withoutCleanup strips exactly the resume bullet`, () => {
    const cl = claude()
    const kept = withoutCleanup(cl).split('\n')
    const gone = cl.split('\n').filter((l) => !kept.includes(l))
    assert.equal(gone.length, 1, JSON.stringify(gone.map((l) => l.slice(0, 60))))
    assert.equal(gone[0] + '\n', RESUME)
  })

  test(`work=${work}: the rules that load in every session stay small`, () => {
    // Measured after the gate and worktree procedures moved to gate-protocol:
    // about 8.9 KB for Claude on a personal Mac. The cap fails a change that
    // puts a procedure back in place of a pointer to a skill.
    // The darwin render is the one a personal Mac loads, and it is the
    // largest, so the cap must hold for it too, not only for the Linux default.
    const cap = work ? 12500 : 9500
    for (const t of ['.claude/CLAUDE.md', '.codex/AGENTS.md', '.config/opencode/AGENTS.md']) {
      for (const extra of [{}, { chezmoi: { os: 'darwin' } }]) {
        const n = Buffer.byteLength(render(t, work, extra))
        assert.ok(n <= cap, `${t} ${JSON.stringify(extra)} is ${n} bytes (cap ${cap})`)
      }
    }
  })
}
