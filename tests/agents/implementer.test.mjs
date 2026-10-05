// Agent definitions must load, and the implementer's harness-worktree path
// must work when its commands run exactly as the text writes them.
//
// Run from the repo root (node:latest ships git and sh):
//   docker run --rm -v "$PWD":/w -w /w node:latest node --test tests/agents/
//
// What a pass proves: every dot_claude/agents/*.md opens with a frontmatter
// block whose name matches its filename and that carries a description,
// tools, and model; the implementer still asks callers for already-reported
// stale pins and still tells it the one-line PR-body form. In a fixture repo
// with an origin, the three qualification probes the Isolate step names tell
// a fresh harness worktree from a dirty one, and the step's own fetch and
// switch commands, lifted from the file and run as written, put <branch> on
// the CURRENT origin/<base> (not the stale commit the harness worktree was
// cut from); a branch name that already exists makes switch fail, so the
// prune-or-BLOCKED bullet is reachable. It also pins the shell facts the
// CLAUDE.md cd rule rests on: set -e does not stop a failed command inside
// an && list or an if test, and `cd <bad> || exit 1` does.
// It does not prove Claude Code still names its worktrees
// .claude/worktrees/agent-<id> on branch worktree-agent-<id>; that naming is
// the harness's, and this file only mirrors it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const AGENTS = new URL('../../dot_claude/agents/', import.meta.url)
const implementer = readFileSync(new URL('implementer.md', AGENTS), 'utf8')

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/)
  if (!m) return null
  const out = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z-]+):\s*(.*)$/)
    if (!kv) continue
    let v = kv[2]
    if (/^'.*'$/.test(v)) v = v.slice(1, -1).replace(/''/g, "'")
    else if (/^".*"$/.test(v)) v = v.slice(1, -1)
    out[kv[1]] = v
  }
  return out
}

// --- Sibling fit: every agent's frontmatter is loadable ---------------------

const agentFiles = readdirSync(AGENTS).filter((f) => f.endsWith('.md'))

test('agents dir is scanned (guards a vacuous pass after a rename)', () => {
  assert.ok(agentFiles.includes('implementer.md'), `scanned only: ${agentFiles.join(', ')}`)
})

for (const file of agentFiles) {
  test(`agent ${file}: frontmatter name matches its filename and has description, tools, model`, () => {
    const fm = frontmatter(readFileSync(new URL(file, AGENTS), 'utf8'))
    assert.ok(fm, `${file}: no --- frontmatter block at top of file`)
    assert.equal(fm.name, file.replace(/\.md$/, ''))
    assert.ok(fm.description && fm.description.length > 20, `${file}: empty or trivial description`)
    assert.ok(fm.tools, `${file}: no tools`)
    assert.ok(fm.model, `${file}: no model`)
  })
}

// --- Regression pin: already-reported stale pins (fe14d49) -----------------

test('implementer description asks callers for stale pins already reported', () => {
  assert.match(frontmatter(implementer).description, /stale pins already reported/)
})

test('implementer report keeps the one-line PR-body form for tracked pins', () => {
  assert.ok(implementer.includes('`Stale pins: already tracked (<ref>)`'))
})

// --- Harness worktree (12ba2b6): the Isolate step's commands, run as written

// The Isolate section with line wraps folded, so a code span split across
// lines still matches.
function isolateSection() {
  const start = implementer.indexOf('### 1. Isolate')
  const end = implementer.indexOf('### 2.', start)
  assert.ok(start >= 0 && end > start, 'Isolate section not found in implementer.md')
  return implementer.slice(start, end).replace(/\s*\n\s*/g, ' ')
}

function harnessCommands() {
  const spans = [...isolateSection().matchAll(/`(git -C <that path> [^`]+)`/g)].map((m) => m[1])
  const want = {
    branch: spans.find((s) => s.endsWith('branch --show-current')),
    status: spans.find((s) => s.endsWith('status --porcelain')),
    fetch: spans.find((s) => / fetch /.test(s)),
    switch: spans.find((s) => / switch -c /.test(s)),
  }
  for (const [k, v] of Object.entries(want)) assert.ok(v, `Isolate step no longer names a \`git -C <that path>\` ${k} command; spans: ${spans.join(' | ')}`)
  return want
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

function fill(cmd, vars) {
  return cmd.replace(/<that path>|<branch>|<base>/g, (k) => vars[k])
}

// origin (bare) with main, a clone as <repo>, and a harness-style worktree
// cut from main; then origin/main moves on, as it does while a brief waits.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'impl-harness-'))
  const env = 'git -c user.name=t -c user.email=t@t -c init.defaultBranch=main'
  ok(`${env} init -q --bare origin.git`, root)
  ok(`${env} clone -q origin.git seed 2>/dev/null && cd seed && ${env} commit -q --allow-empty -m one && ${env} push -q origin HEAD:main`, root)
  ok(`git clone -q origin.git repo`, root)
  const repo = join(root, 'repo')
  const id = 'a1b2c3'
  const wt = join(repo, '.claude', 'worktrees', `agent-${id}`)
  mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
  ok(`git -C ${repo} worktree add -q ${wt} -b worktree-agent-${id} origin/main`, root)
  ok(`cd seed && ${env} commit -q --allow-empty -m two && ${env} push -q origin HEAD:main`, root)
  const fresh = ok('git -C origin.git rev-parse main', root)
  return { root, repo, wt, id, fresh, env }
}

test('qualification probes accept a fresh harness worktree', () => {
  const c = harnessCommands()
  const f = fixture()
  const v = { '<that path>': f.wt, '<branch>': 'feat', '<base>': 'main' }
  assert.equal(ok(fill(c.branch, v)), `worktree-agent-${f.id}`)
  assert.equal(ok(fill(c.status, v)), '')
})

test('qualification probes reject a harness worktree with an untracked file', () => {
  const c = harnessCommands()
  const f = fixture()
  const v = { '<that path>': f.wt, '<branch>': 'feat', '<base>': 'main' }
  writeFileSync(join(f.wt, 'stray.txt'), 'x')
  assert.notEqual(ok(fill(c.status, v)), '', 'an untracked file must make status --porcelain non-empty')
})

test("the step's fetch and switch put <branch> on the current origin/<base>, not the harness's stale commit", () => {
  const c = harnessCommands()
  const f = fixture()
  const v = { '<that path>': f.wt, '<branch>': 'feat-x', '<base>': 'main' }
  const stale = ok(`git -C ${f.wt} rev-parse HEAD`)
  assert.notEqual(stale, f.fresh, 'fixture: origin/main must have moved past the harness commit')
  ok(fill(c.fetch, v))
  ok(fill(c.switch, v))
  assert.equal(ok(`git -C ${f.wt} branch --show-current`), 'feat-x')
  assert.equal(ok(`git -C ${f.wt} rev-parse HEAD`), f.fresh)
  // The step reports the harness branch for the orchestrator; it must survive.
  assert.equal(ok(`git -C ${f.repo} rev-parse --verify -q refs/heads/worktree-agent-${f.id}`), stale)
})

test('switch -c fails on a branch name that already exists, so the prune-or-BLOCKED bullet is reachable', () => {
  const c = harnessCommands()
  const f = fixture()
  ok(`git -C ${f.repo} branch taken origin/main`)
  const r = sh(fill(c.switch, { '<that path>': f.wt, '<branch>': 'taken', '<base>': 'main' }))
  assert.notEqual(r.code, 0, 'switch -c onto an existing branch must fail')
  assert.equal(ok(`git -C ${f.wt} branch --show-current`), `worktree-agent-${f.id}`, 'a failed switch must leave the worktree where it was')
})

// --- CLAUDE.md cd rule (4fd8590): the shell facts it rests on --------------

test('set -e does not stop a failed command inside an && list or an if test', () => {
  assert.equal(sh('set -e; { false; echo ran; } && :').out, 'ran')
  assert.equal(sh('set -e; if { false; echo ran; }; then :; fi').out, 'ran')
})

test('a failed cd without a guard lets the write land in the old directory; `|| exit 1` stops it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cd-rule-'))
  sh('cd ./no-such-dir 2>/dev/null; touch written', dir)
  assert.ok(readdirSync(dir).includes('written'), 'unguarded write should land in the starting directory')
  const r = sh('cd ./no-such-dir 2>/dev/null || exit 1; touch guarded', dir)
  assert.equal(r.code, 1)
  assert.ok(!readdirSync(dir).includes('guarded'))
})
