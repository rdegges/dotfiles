// Structural and safety invariants for the ai-eng-membership skill, plus a
// frontmatter check across every sibling skill.
//
// Run from the repo root:
//   docker run --rm -v "$PWD":/w -w /w node:latest node --test tests/skills/
//
// What a pass proves: the SKILL.md text keeps its add AND remove paths for all
// three systems, invites new people to GitHub by Snyk email (never by a bare
// username), otherwise mutates only the one team membership or that team's
// invitation (never org membership), resolves the GitHub login from the
// verified Snyk email, asks for approval before any mutation, keeps failures
// local to one system, and reads every change back. It says
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

test('GitHub step has add (email invite, team PUT) and remove (team DELETE, invite cancel) commands', () => {
  const gh = subsection(find('4.'), 'GitHub')
  assert.ok(gh, 'no ### GitHub under step 4')
  assert.match(gh, /-X POST \/orgs\/snyk-internal\/invitations/)
  assert.match(gh, /-X PUT \/orgs\/snyk-internal\/teams\/ai-engineering\/memberships\/<github-user>/)
  assert.match(gh, /-X DELETE \/orgs\/snyk-internal\/teams\/ai-engineering\/memberships\/<github-user>/)
  assert.match(gh, /-X DELETE \/orgs\/snyk-internal\/invitations\/<invitation-id>/)
})

test('new people are invited by Snyk email as direct_member, with the ai-engineering team id in the same call', () => {
  const gh = subsection(find('4.'), 'GitHub')
  const invite = gh.match(/gh api -X POST \/orgs\/snyk-internal\/invitations[^`]*/)
  assert.ok(invite, 'no invitation POST')
  assert.match(invite[0], /-f email=<name>@snyk\.io/)
  assert.match(invite[0], /-f role=direct_member/)
  assert.match(invite[0], /team_ids\[\]=19821548/)
  assert.doesNotMatch(invite[0], /invitee_id/, 'invite must go by email so the person joins through SSO')
})

test('an invitation is cancelled only when its teams are only ai-engineering', () => {
  const gh = subsection(find('4.'), 'GitHub')
  assert.match(gh, /its teams are only\s+`ai-engineering`, cancel it/)
  assert.match(gh, /If the invitation has other teams, do not cancel it/)
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

test('every mutating gh call targets the team membership or an org invitation, never org membership', () => {
  const calls = skill.match(MUTATING) ?? []
  assert.ok(calls.length >= 4, 'expected POST invite, PUT, DELETE team, DELETE invite')
  const allowed = [
    /-X PUT \/orgs\/snyk-internal\/teams\/ai-engineering\/memberships\//,
    /-X DELETE \/orgs\/snyk-internal\/teams\/ai-engineering\/memberships\//,
    /-X POST \/orgs\/snyk-internal\/invitations\s/,
    /-X DELETE \/orgs\/snyk-internal\/invitations\/<invitation-id>/,
  ]
  for (const c of calls) {
    assert.ok(allowed.some((re) => re.test(c)), `unexpected mutation target: ${c}`)
    assert.doesNotMatch(c, /\/orgs\/snyk-internal\/(members|memberships|outside_collaborators)\//, `org-level mutation: ${c}`)
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

test('the check step only reads: no mutating gh call and no Edit Members click', () => {
  const checks = find('2.')
  assert.equal((checks.match(MUTATING) ?? []).length, 0)
  assert.match(checks, /Do not click \*\*Edit Members\*\* in this step/)
})

test('read-back step covers all three systems and the remove outcome', () => {
  const rb = find('5.')
  for (const sys of ['GitHub', 'Google Group', 'Slack']) assert.match(rb, new RegExp(`^\\| ${sys} \\|`, 'm'))
  assert.match(rb, /After `add`/)
  assert.match(rb, /After `remove`/)
  // A 404 counts only for the login that step 2 matched to the Snyk email.
  assert.match(rb, /returns 404 for the login from step 2/)
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

// --- Contracts from the first gate run (2026-09-30) -------------------------
// Each one closes a gap found with read-only gh calls and a read-only Chrome walk.

test('a GitHub username that matches no member is checked with /users/ and never counts as "already done"', () => {
  // A nonexistent username returns the same 404 as a real non-member.
  const checks = find('2.')
  assert.match(checks, /gh api \/users\/<github-user>/)
  assert.match(checks, /failed: unknown username/)
  assert.match(checks, /Never mark either case\s+`already done`/)
})

test('the GitHub login comes from the verified Snyk email, and a given username is only a cross-check', () => {
  const checks = find('2.')
  assert.match(checks, /organizationVerifiedDomainEmails\(login: "snyk-internal"\)/)
  assert.match(checks, /--paginate/)
  assert.match(checks, /failed: username does not match <email>/)
  assert.doesNotMatch(skill, /cannot get the username from the email/)
})

test('remove with no email match fails closed: members without a verified email go to Randall', () => {
  const checks = find('2.')
  assert.match(checks, /no verified Snyk email/)
  assert.match(checks, /Mark the row `already done` only after he says no/)
})

test('a missing Slack account skips only the Slack row; other systems still run', () => {
  assert.doesNotMatch(skill, /stop for this person/i)
  assert.match(find('2.'), /skipped: no active Slack\s+account/)
  assert.match(S._preamble + find('1.'), /does not\s+stop the other rows/)
})

test('Slack navigation matches the Snyk Org Grid UI (Directories > User Groups)', () => {
  const slack = subsection(find('2.'), 'Slack user group')
  assert.ok(slack, 'no ### Slack user group under step 2')
  assert.match(slack, /\*\*Directories\*\*, then the \*\*User Groups\*\* tab/)
  assert.match(slack, /\*\*Snyk Org\*\*/)
  assert.doesNotMatch(skill, /People\*\*, then \*\*User groups/)
})

test('Slack picker is searched by full name, never by email, and ambiguity stops the row', () => {
  // Observed 2026-09-30: the Edit members picker shows "No items" for an email.
  const slack = subsection(find('4.'), 'Slack user group')
  assert.match(slack, /type the full name from `slack_search_users`/)
  assert.match(slack, /does\s+not find people by email/)
  assert.match(slack, /If two suggestions\s+match, stop/)
  assert.match(slack, /If two chips have that display name, stop/)
})

test('Google add uses the Group members field, not managers or owners', () => {
  const g = subsection(find('4.'), 'Google Group')
  assert.match(g, /\*\*Group members\*\*\s+field/)
  assert.match(g, /Do not use the \*\*Group managers\*\* or \*\*Group owners\*\* fields/)
})

test('step 2 reads Google Group and Slack user group state before approval', () => {
  const checks = find('2.')
  assert.ok(subsection(checks, 'Google Group'), 'no ### Google Group under step 2')
  assert.ok(subsection(checks, 'Slack user group'), 'no ### Slack user group under step 2')
})

test('the skill deploys only on work machines', () => {
  const ignore = readFileSync(new URL('../../.chezmoiignore', import.meta.url), 'utf8')
  const block = ignore.match(/\{\{ if not \.work \}\}([\s\S]*?)\{\{ end \}\}/)
  assert.ok(block, 'no work-only block in .chezmoiignore')
  assert.match(block[1], /^\.claude\/skills\/ai-eng-membership$/m)
})
