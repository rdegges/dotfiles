// Structural and safety invariants for the ai-eng-membership skill, plus a
// frontmatter check across every sibling skill.
//
// Run from the repo root:
//   docker run --rm -v "$PWD":/w -w /w node:latest node --test tests/skills/
//
// What a pass proves: the SKILL.md text keeps its add AND remove paths for all
// three systems, only ever mutates the one GitHub team (never the org), asks
// for approval before any mutation, and reads every change back. It says
// nothing about whether the live Google, Slack, or GitHub UIs/APIs still match
// the text; those were checked by hand in the gate run.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'

const SKILLS = new URL('../../dot_claude/skills/', import.meta.url)
const skill = readFileSync(new URL('ai-eng-membership/SKILL.md', SKILLS), 'utf8')

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/)
  if (!m) return null
  // Minimal YAML: top-level scalars, plus `|`/`>` block scalars whose value is
  // the indented lines that follow (simple-english uses `description: |`).
  const out = {}
  let block = null
  for (const line of m[1].split('\n')) {
    if (block && /^\s+\S/.test(line)) {
      out[block] += (out[block] ? ' ' : '') + line.trim()
      continue
    }
    block = null
    const kv = line.match(/^([a-z-]+):\s*(.*)$/)
    if (!kv) continue
    if (/^[|>][-+]?$/.test(kv[2])) {
      block = kv[1]
      out[block] = ''
    } else {
      out[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1')
    }
  }
  return out
}

// Split on "## " headings so a check can target one step of the procedure.
function sections(text) {
  const out = {}
  let key = '_preamble'
  for (const line of text.split('\n')) {
    const h = line.match(/^##\s+(.*)$/)
    if (h) key = h[1].trim()
    out[key] = (out[key] ?? '') + line + '\n'
  }
  return out
}

function subsection(body, title) {
  const re = new RegExp(`^###\\s+${title}\\s*$([\\s\\S]*?)(?=^###\\s|(?![\\s\\S]))`, 'm')
  const m = body.match(re)
  return m ? m[1] : null
}

const S = sections(skill)
const find = (prefix) => {
  const k = Object.keys(S).find((k) => k.startsWith(prefix))
  assert.ok(k, `no "## ${prefix}..." section`)
  return S[k]
}

const MUTATING = /gh api\b[^\n]*-X\s*(PUT|DELETE|POST|PATCH)\b[^\n]*/g

// --- Sibling fit: every skill's frontmatter is loadable ---------------------

for (const dir of readdirSync(SKILLS, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  test(`skill ${dir.name}: frontmatter name matches its directory and has a description`, () => {
    const path = new URL(`${dir.name}/SKILL.md`, SKILLS)
    assert.ok(existsSync(path), `${dir.name} has no SKILL.md`)
    const fm = frontmatter(readFileSync(path, 'utf8'))
    assert.ok(fm, `${dir.name}: no --- frontmatter block at top of file`)
    assert.equal(fm.name, dir.name)
    assert.ok(fm.description && fm.description.length > 20, `${dir.name}: empty or trivial description`)
  })
}

// --- Regression pin: the scope includes removal ----------------------------

test('description triggers on both onboarding and offboarding phrasing', () => {
  const d = frontmatter(skill).description.toLowerCase()
  for (const phrase of ['add', 'remove', 'onboard', 'offboard']) {
    assert.ok(d.includes(phrase), `description lacks "${phrase}"`)
  }
})

test('GitHub step has both an add (PUT) and a remove (DELETE) command on the team membership', () => {
  const gh = subsection(find('4.'), 'GitHub')
  assert.ok(gh, 'no ### GitHub under step 4')
  assert.match(gh, /-X PUT \/orgs\/snyk-internal\/teams\/ai-engineering\/memberships\/<github-user>/)
  assert.match(gh, /-X DELETE \/orgs\/snyk-internal\/teams\/ai-engineering\/memberships\/<github-user>/)
})

for (const title of ['Google Group', 'Slack user group']) {
  test(`${title} step has instructions for both add and remove`, () => {
    const body = subsection(find('4.'), title)
    assert.ok(body, `no ### ${title} under step 4`)
    assert.match(body, /For `add`/)
    assert.match(body, /For `remove`/)
  })
}

// --- Safety invariants ------------------------------------------------------

test('every mutating gh call targets only the ai-engineering team membership, never the org', () => {
  const calls = skill.match(MUTATING) ?? []
  assert.ok(calls.length >= 2, 'expected at least the PUT and DELETE calls')
  for (const c of calls) {
    assert.match(c, /\/orgs\/snyk-internal\/teams\/ai-engineering\/memberships\//, `unexpected mutation target: ${c}`)
    assert.doesNotMatch(c, /\/orgs\/snyk-internal\/(members|memberships|invitations|outside_collaborators)\//, `org-level mutation: ${c}`)
  }
})

test('team add uses role=member, never maintainer', () => {
  const puts = (skill.match(MUTATING) ?? []).filter((c) => /-X\s*PUT/.test(c))
  assert.ok(puts.length > 0)
  for (const c of puts) {
    assert.match(c, /-f role=member\b/)
    assert.doesNotMatch(c, /maintainer/)
  }
})

test('no mutation appears before the approval step', () => {
  const approval = skill.search(/^##\s+3\.\s+Get one approval/m)
  assert.ok(approval > 0, 'approval step missing')
  const before = skill.slice(0, approval)
  assert.equal((before.match(MUTATING) ?? []).length, 0, 'a mutating command sits before approval')
})

test('the read-only check step does not tell the agent to send an org invitation', () => {
  const checks = find('2.')
  assert.match(checks, /Do not send an org invitation/)
})

test('read-back step covers all three systems and the remove outcome', () => {
  const rb = find('5.')
  for (const sys of ['GitHub', 'Google Group', 'Slack']) assert.match(rb, new RegExp(`${sys}:`))
  assert.match(rb, /For `remove`, expect a 404/)
})

test('report names org removal and IT offboarding as outside the skill', () => {
  const rep = find('6.')
  assert.match(rep, /org removal/i)
  assert.match(rep, /IT offboarding/)
})

test('targets are consistent: one org, one team slug, one group address', () => {
  const paths = skill.match(/\/orgs\/[^\s/]+\/teams\/[^\s/]+/g) ?? []
  assert.ok(paths.length > 0)
  assert.deepEqual([...new Set(paths)], ['/orgs/snyk-internal/teams/ai-engineering'])
  assert.match(skill, /groups\.google\.com\/a\/snyk\.io\/g\/ai-engineering\/members/)
  assert.match(skill, /ai-engineering@snyk\.io/)
})

// --- PROPOSED CONTRACTS -----------------------------------------------------
// Gaps found in the gate run (read-only gh calls and a read-only Chrome walk,
// 2026-09-30). Marked todo so they document the gap without failing the suite.

test('PROPOSED CONTRACT: remove path confirms the GitHub user exists before treating a membership 404 as "already done"', { todo: true }, () => {
  // Observed: GET /orgs/snyk-internal/memberships/<nonexistent> and the team
  // membership GET both return the same 404 as a real non-member. A typo'd
  // username is therefore reported "already done" and the real person keeps access.
  assert.match(find('2.'), /\/users\/<github-user>/)
})

test('PROPOSED CONTRACT: the GitHub username is cross-checked against the Snyk email before approval', { todo: true }, () => {
  // Observed: organizationVerifiedDomainEmails(login:"snyk-internal") returns the
  // snyk.io address for all 12 current team members, and the org has 41 members,
  // so the "cannot get the username from the email" premise does not hold.
  assert.match(skill, /organizationVerifiedDomainEmails/)
})

test('PROPOSED CONTRACT: a missing Slack account on remove does not block the GitHub and Google removals', { todo: true }, () => {
  // Step 2.1 says "If no account exists, stop for this person" for both actions;
  // offboarded people are often already deactivated in Slack.
  assert.doesNotMatch(find('2.'), /If no account exists, stop for this person\./)
})

test('PROPOSED CONTRACT: Slack navigation matches the Snyk Org Grid UI (Directories > User Groups)', { todo: true }, () => {
  // Observed: the Snyk Org sidebar has "Directories" with a "User Groups" tab; no
  // "People > User groups" path. app.slack.com also opens a workspace picker first.
  assert.match(subsection(find('4.'), 'Slack user group'), /Directories/)
})
