// The CLAUDE.md gate rule's agent-worktree clauses (porcelain exception and
// post-merge cleanup), checked against real git.
//
// Run from the repo root (chezmoi is needed; without it every test FAILS, it
// does not skip):
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin && node --test tests/claude/'
//
// What a pass proves: the Claude render (work=false and work=true) states the
// porcelain glob and the cleanup commands this file runs. In fixture repos
// with a bare origin: a harness worktree under .claude/worktrees/agent-<id>
// makes plain `git status --porcelain` non-empty (so the exception is needed),
// and `-uall` prints exactly one glob-matching line per worktree no matter
// what is inside it (so the exception must also run each worktree's own
// status, which tells clean from dirty or orphaned), while any other untracked
// path, an orphaned harness dir, or a look-alike file prints a line outside
// the glob (so the gate stays closed). After a merge-commit merge, the cleanup
// steps as written remove the worktree without --force and delete both
// branches with -d; the rule's fetch plus origin/<base> says merged while
// local main is stale. After a squash merge, the headRefOid path removes the
// worktree without --force and deletes the branch with -D, and does not apply
// once HEAD has moved past the PR head. It also pins the edges: the ancestor
// check after a squash merge says "unmerged", status on an orphaned dir exits
// non-zero with EMPTY stdout, `worktree remove` refuses a dirty tree, and
// `branch -d` refuses while the worktree still holds the branch.
// It says nothing about how Claude reads the text, or whether Claude Code
// still names its worktrees .claude/worktrees/agent-<id>.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SOURCE = new URL('../../', import.meta.url).pathname

function render(work) {
  const home = mkdtempSync(join(tmpdir(), 'wt-cleanup-'))
  try {
    const r = spawnSync(
      'chezmoi',
      ['--source', SOURCE, '--destination', home, '--override-data', JSON.stringify({ work }), 'cat', join(home, '.claude/CLAUDE.md')],
      { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } },
    )
    assert.ifError(r.error)
    assert.equal(r.status, 0, `chezmoi cat (work=${work}) exited ${r.status}: ${r.stderr}`)
    assert.ok(r.stdout.length > 0)
    return r.stdout
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

// The glob from the rendered exception, e.g. `?? .claude/worktrees/agent-*/`,
// as an anchored regex where * matches one path segment.
function porcelainGlob(text) {
  const m = text.match(/`git status --porcelain -uall` prints only `([^`]+)` lines/)
  assert.ok(m, 'Claude render no longer states the -uall porcelain exception')
  const esc = m[1].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
  return { glob: m[1], re: new RegExp(`^${esc}$`) }
}

function sh(cmd, cwd) {
  const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8' })
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }
}

function ok(cmd, cwd) {
  const r = sh(cmd, cwd)
  assert.equal(r.code, 0, `${cmd}\n${r.err}`)
  return r.out
}

const E = 'git -c user.name=t -c user.email=t@t -c init.defaultBranch=main'

// origin (bare) with main, a clone as <repo>, a seed clone that plays GitHub,
// and a harness worktree whose implementer switched to <branch>, committed,
// and pushed with an upstream, as implementer.md's harness path does.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wt-cleanup-'))
  ok(`${E} init -q --bare origin.git`, root)
  ok(`${E} clone -q origin.git gh 2>/dev/null && cd gh && ${E} commit -q --allow-empty -m one && ${E} push -q origin HEAD:main`, root)
  ok(`git clone -q origin.git repo`, root)
  const repo = join(root, 'repo')
  const id = 'a1b2c3'
  const wt = join(repo, '.claude', 'worktrees', `agent-${id}`)
  mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
  ok(`git -C ${repo} worktree add -q ${wt} -b worktree-agent-${id} origin/main`)
  ok(`git -C ${wt} switch -q -c feat origin/main && echo x > ${wt}/f && git -C ${wt} add f && ${E} -C ${wt} commit -q -m feat && git -C ${wt} push -q -u origin feat 2>/dev/null`)
  return { root, repo, wt, id, gh: join(root, 'gh') }
}

// GitHub's "Create a merge commit" (the style every recent rdegges/dotfiles PR used).
function mergeCommit(f) {
  ok(`cd gh && git fetch -q origin && ${E} merge -q --no-ff origin/feat -m 'Merge pull request #1' && git push -q origin HEAD:main`, f.root)
}

// GitHub's "Squash and merge" (rdegges-www and redline merge this way).
function squash(f) {
  ok(`cd gh && git fetch -q origin && ${E} merge -q --squash origin/feat && ${E} commit -q -m 'feat (#1)' && git push -q origin HEAD:main`, f.root)
}

const isAncestor = (wt, ref) => sh(`git -C ${wt} merge-base --is-ancestor HEAD ${ref}`).code

for (const work of [false, true]) {
  test(`work=${work}: Claude render names the cleanup steps this file runs`, () => {
    const t = render(work).replace(/\s*\n\s*/g, ' ')
    porcelainGlob(t)
    for (const s of ['`git -C <wt> status --porcelain` exits 0 and prints nothing', '`git -C <repo> fetch -q origin`', '`git -C <wt> merge-base --is-ancestor HEAD origin/<base>`', '`git worktree remove` (never `--force`)', '`gh pr view <n> --json state,headRefOid`', '`git -C <wt> rev-parse HEAD`', '`git worktree prune`', '`git branch -d`', '`git branch -D`']) {
      assert.ok(t.includes(s), `Claude render lost ${s}`)
    }
  })
}

// --- Porcelain exception ----------------------------------------------------

test('a harness worktree makes plain porcelain non-empty, and -uall prints one glob line per worktree', () => {
  const { re, glob } = porcelainGlob(render(false))
  const f = fixture()
  try {
    ok(`git -C ${f.repo} worktree add -q ${join(f.repo, '.claude/worktrees/agent-zz9')} -b worktree-agent-zz9 origin/main`)
    mkdirSync(join(f.wt, 'deep', 'er'), { recursive: true })
    writeFileSync(join(f.wt, 'deep', 'er', 'untracked.txt'), 'x')
    assert.equal(ok(`git -C ${f.repo} status --porcelain`), '?? .claude/', 'plain porcelain should collapse to .claude/, which is why the exception exists')
    const lines = ok(`git -C ${f.repo} status --porcelain -uall`).split('\n')
    assert.deepEqual(lines, [`?? .claude/worktrees/agent-${f.id}/`, '?? .claude/worktrees/agent-zz9/'])
    for (const l of lines) assert.match(l, re, `${l} does not match ${glob}`)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('any other untracked path next to a harness worktree prints a line outside the glob (gate stays closed)', () => {
  const { re } = porcelainGlob(render(false))
  const f = fixture()
  try {
    writeFileSync(join(f.repo, '.claude', 'notes.md'), 'x')
    writeFileSync(join(f.repo, '.claude', 'worktrees', `agent-${f.id}.log`), 'x')
    mkdirSync(join(f.repo, '.claude', 'worktrees', 'agent-fake'))
    writeFileSync(join(f.repo, '.claude', 'worktrees', 'agent-fake', 'x'), 'x')
    const outside = ok(`git -C ${f.repo} status --porcelain -uall`).split('\n').filter((l) => !re.test(l))
    assert.deepEqual(outside.sort(), ['?? .claude/notes.md', `?? .claude/worktrees/agent-${f.id}.log`, '?? .claude/worktrees/agent-fake/x'].sort())
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

// A harness crash or a `rm -rf .git/worktrees/...` leaves the dir with a .git
// file that points nowhere; git then lists its files, so the gate closes.
test('an orphaned harness dir prints file lines outside the glob, and its status exits non-zero with EMPTY stdout', () => {
  const { re } = porcelainGlob(render(false))
  const f = fixture()
  try {
    ok(`git -C ${f.repo} worktree remove --force ${f.wt} && mkdir -p ${f.wt} && echo 'gitdir: /nonexistent' > ${f.wt}/.git && echo x > ${f.wt}/f`)
    const outside = ok(`git -C ${f.repo} status --porcelain -uall`).split('\n').filter((l) => !re.test(l))
    assert.ok(outside.length > 0, 'orphaned dir slipped through the glob')
    // On an orphan the stdout IS empty; only the exit code says otherwise,
    // which is why the rule requires exit 0 as well as no output.
    const st = sh(`git -C ${f.wt} status --porcelain`)
    assert.notEqual(st.code, 0)
    assert.equal(st.out, '')
    assert.notEqual(sh(`git -C ${f.repo} worktree remove ${f.wt}`).code, 0, 'worktree remove should refuse an unregistered dir')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

// --- Cleanup after merge ----------------------------------------------------

test('merge-commit merge: the rule\'s steps, in order, remove the worktree without --force and both branches with -d', () => {
  const f = fixture()
  try {
    mergeCommit(f)
    ok(`git -C ${f.repo} fetch -q origin`)
    assert.equal(ok(`git -C ${f.wt} status --porcelain`), '')
    assert.equal(isAncestor(f.wt, 'origin/main'), 0)
    ok(`git -C ${f.repo} worktree remove ${f.wt}`)
    ok(`git -C ${f.repo} worktree prune`)
    ok(`git -C ${f.repo} branch -d feat worktree-agent-${f.id}`)
    assert.equal(existsSync(f.wt), false)
    assert.equal(ok(`git -C ${f.repo} worktree list --porcelain`).split('\n').filter((l) => l.startsWith('worktree ')).length, 1)
    assert.equal(ok(`git -C ${f.repo} branch --list feat worktree-agent-${f.id}`), '')
    assert.equal(ok(`git -C ${f.repo} status --porcelain -uall`), '', 'the empty .claude/worktrees/ left behind is invisible to git')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('branch -d before worktree remove fails: the rule\'s order (remove, prune, then -d) is load-bearing', () => {
  const f = fixture()
  try {
    mergeCommit(f)
    ok(`git -C ${f.repo} fetch -q origin`)
    assert.notEqual(sh(`git -C ${f.repo} branch -d feat`).code, 0)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

// "the base branch" is not pinned to a ref. Local main is behind until
// someone fetches and fast-forwards it, so the same merged worktree reads as
// unmerged against `main` and merged against a fetched `origin/main`.
test('merged on GitHub: is-ancestor against stale local main says unmerged; against fetched origin/main says merged', () => {
  const f = fixture()
  try {
    mergeCommit(f)
    assert.equal(isAncestor(f.wt, 'main'), 1)
    assert.equal(isAncestor(f.wt, 'origin/main'), 1, 'not fetched yet')
    ok(`git -C ${f.repo} fetch -q origin`)
    assert.equal(isAncestor(f.wt, 'main'), 1, 'fetch does not move local main')
    assert.equal(isAncestor(f.wt, 'origin/main'), 0)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

// The content landed, but the ancestor test can never pass, which is why the
// rule has a second path through the PR's headRefOid.
test('squash merge: HEAD is never an ancestor of origin/main, so the ancestor path alone cannot clean it up', () => {
  const f = fixture()
  try {
    squash(f)
    ok(`git -C ${f.repo} fetch -q origin`)
    assert.equal(ok(`git -C ${f.wt} diff HEAD origin/main --stat`), '', 'squash landed the same tree')
    assert.equal(isAncestor(f.wt, 'origin/main'), 1)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

// `branch -d` checks the branch's upstream when one exists, else HEAD. So a
// squash-merged branch deletes while its remote branch exists and refuses
// once GitHub (or anyone) deletes it.
test('squash merge: branch -d follows the upstream, not the base branch', () => {
  const f = fixture()
  try {
    squash(f)
    ok(`git -C ${f.repo} fetch -q origin`)
    ok(`git -C ${f.repo} worktree remove ${f.wt}`)
    ok(`git -C ${f.repo} branch -c feat feat-gone`)
    ok(`git -C ${f.repo} branch -d feat`)
    ok(`git -C ${f.repo} branch -q -u origin/feat feat-gone && git -C ${f.repo} push -q origin --delete feat && git -C ${f.repo} fetch -q --prune origin`)
    assert.notEqual(sh(`git -C ${f.repo} branch -d feat-gone`).code, 0)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('dirty worktree: status is non-empty and worktree remove without --force refuses (backstop holds)', () => {
  const f = fixture()
  try {
    mergeCommit(f)
    ok(`git -C ${f.repo} fetch -q origin`)
    writeFileSync(join(f.wt, 'scratch.txt'), 'x')
    assert.notEqual(ok(`git -C ${f.wt} status --porcelain`), '')
    assert.notEqual(sh(`git -C ${f.repo} worktree remove ${f.wt}`).code, 0)
    assert.ok(existsSync(join(f.wt, 'scratch.txt')))
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

// Implementer harness path, BLOCKED: `switch -c <branch> origin/<base>`
// sets <branch>'s upstream to origin/<base>, and `branch -d` checks the
// upstream before HEAD. So with no commits it deletes even while the main
// checkout's local main is stale, and with an unpushed commit it refuses.
test('harness BLOCKED: branch -d judges <branch> against its auto-set upstream origin/<base>', () => {
  const root = mkdtempSync(join(tmpdir(), 'wt-cleanup-'))
  try {
    ok(`${E} init -q --bare origin.git`, root)
    ok(`${E} clone -q origin.git gh 2>/dev/null && cd gh && ${E} commit -q --allow-empty -m one && ${E} push -q origin HEAD:main`, root)
    ok(`git clone -q origin.git repo`, root)
    const repo = join(root, 'repo')
    const wt = join(repo, '.claude/worktrees/agent-q')
    ok(`git -C ${repo} worktree add -q ${wt} -b worktree-agent-q origin/main`)
    ok(`cd gh && ${E} commit -q --allow-empty -m two && git push -q origin HEAD:main`, root)
    ok(`git -C ${wt} fetch -q origin && git -C ${wt} switch -q -c blocked origin/main && git -C ${wt} branch -q -c blocked blocked-commit`)
    assert.equal(ok(`git -C ${repo} rev-parse --abbrev-ref blocked@{upstream}`), 'origin/main')
    assert.equal(isAncestor(wt, 'main'), 1, 'local main is stale')
    assert.equal(isAncestor(wt, 'origin/main'), 0)
    ok(`git -C ${wt} switch -q blocked-commit && ${E} -C ${wt} commit -q --allow-empty -m wip`)
    assert.equal(isAncestor(wt, 'origin/main'), 1, 'unpushed work reads as unmerged')
    ok(`git -C ${repo} worktree remove ${wt} && git -C ${repo} worktree prune`)
    ok(`git -C ${repo} branch -d worktree-agent-q blocked`)
    assert.notEqual(sh(`git -C ${repo} branch -d blocked-commit`).code, 0, 'an unpushed commit must not delete with -d')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- Rule text run as written -----------------------------------------------

// Pulls a command out of the rendered rule and fills its placeholders, so
// these tests run what the rule says, not a copy that could drift from it.
function ruleCommand(text, re) {
  const m = text.match(re)
  assert.ok(m, `Claude render lost ${re}`)
  return m[1]
}
const fill = (cmd, f) => cmd.replaceAll('<repo>', f.repo).replaceAll('<wt>', f.wt).replaceAll('<base>', 'main')

test('gate exception: the parent repo prints the same line for a clean, dirty, or orphaned worktree; only the per-worktree status tells them apart', () => {
  const t = render(false)
  const { re } = porcelainGlob(t)
  const st = ruleCommand(t, /and `(git -C <wt> status --porcelain)` exits 0 and prints nothing in each of those worktrees/)
  const f = fixture()
  try {
    const line = `?? .claude/worktrees/agent-${f.id}/`
    assert.equal(ok(`git -C ${f.repo} status --porcelain -uall`), line)
    assert.match(line, re)
    assert.deepEqual([sh(fill(st, f)).code, sh(fill(st, f)).out], [0, ''], 'clean worktree opens the gate')
    writeFileSync(join(f.wt, 'dirt.txt'), 'x')
    assert.equal(ok(`git -C ${f.repo} status --porcelain -uall`), line, 'the parent repo cannot see dirt inside a worktree')
    const dirty = sh(fill(st, f))
    assert.equal(dirty.code, 0)
    assert.equal(dirty.out, '?? dirt.txt', 'dirty worktree keeps the gate closed')
    rmSync(join(f.wt, 'dirt.txt'))
    ok(`git -C ${f.repo} worktree remove ${f.wt} && mkdir -p ${f.wt} && echo 'gitdir: /nonexistent' > ${f.wt}/.git`)
    const orphan = sh(fill(st, f))
    assert.notEqual(orphan.code, 0, 'orphan: only the exit code keeps the gate closed')
    assert.equal(orphan.out, '')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('merged on GitHub: the rule\'s fetch and is-ancestor commands, run as written, say merged while local main is stale', () => {
  const t = render(false)
  const fetch = ruleCommand(t, /First run `(git -C <repo> fetch -q origin)`\./)
  const anc = ruleCommand(t, /`(git -C <wt> merge-base --is-ancestor HEAD origin\/<base>)` passes/)
  const f = fixture()
  try {
    mergeCommit(f)
    assert.notEqual(sh(fill(anc, f)).code, 0, 'not fetched yet')
    ok(fill(fetch, f))
    assert.equal(isAncestor(f.wt, 'main'), 1, 'local main is still stale')
    assert.equal(sh(fill(anc, f)).code, 0)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

// headRefOid is the PR head SHA GitHub records: here, the pushed origin/feat.
// GitHub's branch auto-delete then removes feat from origin.
test('squash merge, HEAD equals headRefOid: worktree remove works without --force, and branch -D deletes what -d refuses', () => {
  const rev = ruleCommand(render(false), /`headRefOid` equals `(git -C <wt> rev-parse HEAD)`/)
  const f = fixture()
  try {
    const headRefOid = ok(`git -C ${f.repo} rev-parse origin/feat`)
    squash(f)
    ok(`git -C ${f.repo} push -q origin --delete feat && git -C ${f.repo} fetch -q --prune origin`)
    assert.equal(isAncestor(f.wt, 'origin/main'), 1, 'the ancestor path does not apply')
    assert.equal(ok(fill(rev, f)), headRefOid)
    assert.equal(ok(`git -C ${f.wt} status --porcelain`), '')
    ok(`git -C ${f.repo} worktree remove ${f.wt}`)
    ok(`git -C ${f.repo} worktree prune`)
    assert.notEqual(sh(`git -C ${f.repo} branch -d feat`).code, 0, '-d refuses a squash-merged branch')
    assert.equal(ok(`git -C ${f.repo} rev-parse feat`), headRefOid, 'tip equals headRefOid, so -D is allowed')
    ok(`git -C ${f.repo} branch -D feat`)
    ok(`git -C ${f.repo} branch -d worktree-agent-${f.id}`)
    assert.equal(existsSync(f.wt), false)
    assert.equal(ok(`git -C ${f.repo} branch --list feat worktree-agent-${f.id}`), '')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('squash merge, HEAD moved past headRefOid: neither removal condition holds, so the worktree stays', () => {
  const t = render(false)
  const anc = ruleCommand(t, /`(git -C <wt> merge-base --is-ancestor HEAD origin\/<base>)` passes/)
  const rev = ruleCommand(t, /`headRefOid` equals `(git -C <wt> rev-parse HEAD)`/)
  const f = fixture()
  try {
    const headRefOid = ok(`git -C ${f.repo} rev-parse origin/feat`)
    squash(f)
    ok(`git -C ${f.repo} fetch -q origin`)
    ok(`${E} -C ${f.wt} commit -q --allow-empty -m later`)
    assert.equal(ok(`git -C ${f.wt} status --porcelain`), '', 'clean, so only the merge conditions protect it')
    assert.notEqual(sh(fill(anc, f)).code, 0)
    assert.notEqual(ok(fill(rev, f)), headRefOid)
    assert.notEqual(ok(`git -C ${f.repo} rev-parse feat`), headRefOid, 'the -D condition fails too')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})
