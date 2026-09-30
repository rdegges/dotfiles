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

// --- Tester additions, rework gate (42aacb8) ---------------------------------
// MUTATING above only sees `gh api ... -X VERB`. `gh api` also sends a POST
// when it gets -f/-F/--field/--raw-field/--input with no -X, so a write can
// hide from that regex. These tests classify every gh command in every ```sh
// block by what gh would actually send.

function shCommands(text) {
  const out = []
  for (const [, body, offset] of [...text.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => [m[0], m[1], m.index])) {
    let cur = null
    for (const line of body.split('\n')) {
      if (/^\s*gh\s/.test(line)) {
        if (cur) out.push(cur)
        cur = { cmd: line.trim(), offset }
      } else if (cur) {
        cur.cmd += '\n' + line
      }
    }
    if (cur) out.push(cur)
  }
  return out
}

function isWrite(cmd) {
  const verb = cmd.match(/(?:-X|--method)\s*([A-Z]+)/)
  if (verb) return verb[1] !== 'GET'
  if (/^gh api graphql\b/.test(cmd)) return /\bmutation\b/.test(cmd)
  return /\s(-f|-F|--field|--raw-field|--input)\s/.test(cmd)
}

const CMDS = shCommands(skill)
const APPROVAL_AT = skill.search(/^##\s+3\.\s+Get one approval/m)
const STEP5_AT = skill.search(/^##\s+5\./m)

test('every gh command in the skill is either a read or one of the four allowed writes', () => {
  assert.ok(CMDS.length >= 9, `expected the step 2 reads and step 4 writes, got ${CMDS.length}`)
  for (const { cmd } of CMDS) {
    assert.match(cmd, /^gh api\b/, `only gh api is expected: ${cmd}`)
    if (!isWrite(cmd)) continue
    const allowed = [
      /^gh api -X PUT \/orgs\/snyk-internal\/teams\/ai-engineering\/memberships\/<github-user> -f role=member$/,
      /^gh api -X DELETE \/orgs\/snyk-internal\/teams\/ai-engineering\/memberships\/<github-user>$/,
      /^gh api -X POST \/orgs\/snyk-internal\/invitations\b/,
      /^gh api -X DELETE \/orgs\/snyk-internal\/invitations\/<invitation-id>$/,
    ]
    assert.ok(allowed.some((re) => re.test(cmd.trim())), `write outside the allowed set: ${cmd}`)
  }
})

test('writes appear only in step 4, never in the read, approval, or read-back steps', () => {
  assert.ok(APPROVAL_AT > 0 && STEP5_AT > APPROVAL_AT)
  const writes = CMDS.filter(({ cmd }) => isWrite(cmd))
  assert.equal(writes.length, 4)
  for (const { cmd, offset } of writes) {
    assert.ok(offset > APPROVAL_AT && offset < STEP5_AT, `write outside step 4: ${cmd}`)
  }
})

test('the step 2 GraphQL call is a query, not a mutation', () => {
  const gql = CMDS.filter(({ cmd }) => /^gh api graphql\b/.test(cmd))
  assert.equal(gql.length, 1)
  assert.match(gql[0].cmd, /-f query='query\(/)
  assert.doesNotMatch(gql[0].cmd, /\bmutation\b/)
})

test('the invitation POST carries the same team id the target table declares', () => {
  const tableId = S._preamble.match(/team `ai-engineering` \(id `(\d+)`\)/)
  assert.ok(tableId, 'target table lost the team id')
  const post = CMDS.find(({ cmd }) => /-X POST \/orgs\/snyk-internal\/invitations/.test(cmd))
  assert.ok(post)
  assert.deepEqual([...post.cmd.matchAll(/team_ids\[\]=(\d+)/g)].map((m) => m[1]), [tableId[1]])
})

test('step 2 reads the teams of a pending invitation, which the cancel guard in step 4 depends on', () => {
  const checks = find('2.')
  assert.match(checks, /gh api \/orgs\/snyk-internal\/invitations --paginate/)
  assert.match(checks, /gh api \/orgs\/snyk-internal\/invitations\/<invitation-id>\/teams/)
})

test('step 4 never edits or re-sends an existing invitation', () => {
  const gh = subsection(find('4.'), 'GitHub')
  assert.match(gh, /failed: pending invitation without the team/)
  assert.match(gh, /any non-2xx status, do not retry the\s+invitation\. Do not go back to step 2\./)
  assert.doesNotMatch(gh, /go back\s+to step 2 for this person/)
  assert.doesNotMatch(gh, /-X PATCH/)
})

test('read-back accepts a pending invitation only when it carries the ai-engineering team', () => {
  const row = find('5.').match(/^\| GitHub \|.*$/m)
  assert.ok(row)
  assert.match(row[0], /pending invitation for the email with team `ai-engineering`/)
  assert.match(find('5.'), /A pending invitation is not access/)
})

// Contracts from the rework gate run (42aacb8), now enforced.

test('on add, a given username that is not an org member does not fail the GitHub row', () => {
  // Step 2.6 fails the row ("cannot confirm that <github-user> is <email>") for
  // ANY add where Randall supplies the username of a new hire who is not yet an
  // org member. Step 4 invites by email and never uses the username, and step 1
  // says the username is "only a cross-check". So the normal onboarding request
  // "add jane@snyk.io, GitHub janedoe" can never reach the email invite.
  const checks = find('2.')
  assert.match(checks, /For `add`[^\n]*(not an org member|no org membership)[\s\S]*?invite/i)
})

test('Snyk email matching is case-insensitive', () => {
  // Step 2.2 says "equals". Randall may type Jane.Doe@snyk.io; a strict compare
  // misses the member and, on add, sends a second invitation.
  // Scoped to item 2: since 2081995, item 3's username sentence also says
  // "lowercase", so a section-wide match passed with item 2's rule deleted.
  assert.match(identityItems().items['2'], /case-insensitive|ignore case|lower-?case/i)
})

test('on add, org members without a verified Snyk email are checked before an email invite', () => {
  // Observed 2026-09-30: 1 of 41 snyk-internal members has no verified Snyk
  // email. The remove path asks Randall about such members; the add path goes
  // straight to an email invite for a person who may already be that member.
  const checks = find('2.')
  assert.match(checks, /On `add`[\s\S]*?no verified Snyk email/)
})

test('on add, the username check at /users/ is skipped and shown as not checked', () => {
  const checks = find('2.')
  assert.match(checks, /`not checked \(new hire joins\s+by email\)`/)
  assert.match(checks, /For `remove`, if no member matched and Randall gave a username/)
})

test('step 4 names the no-call outcomes: already done, invited', () => {
  const gh = subsection(find('4.'), 'GitHub')
  assert.match(gh, /state is `active`, or a pending invitation already\s+has team `ai-engineering`, mark the row `already done`/)
  assert.match(gh, /state is `pending`, mark the row `invited`/)
  assert.match(gh, /not on the team and has no pending invitation[\s\S]*?`already done`\. Make no call\./)
})

test('the username cross-check ignores case', () => {
  assert.match(find('2.'), /GitHub usernames\s+are not case-sensitive, so compare them in lowercase/)
})

// --- Tester additions, gate on 2081995 ---------------------------------------
// Item-scoped checks. The section-wide /lower-?case/ match above became
// satisfiable by item 3's new sentence alone, so it no longer proved item 2.
// These pin each numbered item of "### GitHub identity" on its own.

function identityItems() {
  const body = subsection(find('2.'), 'GitHub identity')
  assert.ok(body, 'no ### GitHub identity under step 2')
  const list = body.split(/^Some org members have no verified Snyk email\./m)
  const out = {}
  for (const m of list[0].matchAll(/^(\d+)\.\s([\s\S]*?)(?=^\d+\.\s|(?![\s\S]))/gm)) out[m[1]] = m[2]
  return { items: out, tail: list[1] ?? '' }
}

test('GitHub identity has items 1-6 and the no-verified-email tail', () => {
  const { items, tail } = identityItems()
  assert.deepEqual(Object.keys(items), ['1', '2', '3', '4', '5', '6'])
  assert.match(tail, /On `add`/)
  assert.match(tail, /On `remove`/)
})

test('item 2 lowercases both sides of the email compare', () => {
  assert.match(identityItems().items['2'], /Lowercase the Snyk email and each verified email before you compare/)
})

test('item 3 keeps the cross-check, compares usernames in lowercase, and still fails closed on a mismatch', () => {
  const i3 = identityItems().items['3']
  const eq = i3.search(/must equal that login/)
  const lc = i3.search(/compare them in lowercase/)
  const fail = i3.search(/failed: username does not match <email>/)
  assert.ok(eq >= 0 && lc > eq && fail > lc, 'order: equality rule, case rule, then the failure mark')
  assert.match(i3, /Do not\s+guess which one is correct/)
  // The case rule must not relax the compare into a fuzzy or partial match.
  assert.doesNotMatch(i3, /contains|starts with|similar|close/i)
})

test('item 4 lowercases invitation emails before it looks for the Snyk email', () => {
  assert.match(identityItems().items['4'], /Lowercase each invitation email, then\s+find the one for the Snyk email/)
})

test('on add, a member without a verified email that Randall names goes to the team PUT, and a no goes to the invite', () => {
  const { tail } = identityItems()
  const add = tail.split(/On `remove`/)[0]
  assert.match(add, /list the org\s+members from item 1 that have no verified Snyk email/)
  assert.match(add, /use that login and the team membership\s+PUT in step 4/)
  assert.match(add, /If he says no, plan the invitation/)
})

test('every row outcome that step 2 or 4 marks is a result the report in step 6 can show', () => {
  const results = [...find('6.').matchAll(/`([a-z ]+)`/g)].map((m) => m[1])
  for (const r of ['added', 'invited', 'removed', 'already done', 'skipped', 'failed']) assert.ok(results.includes(r), `step 6 lacks ${r}`)
  const marks = [...(find('2.') + find('4.')).matchAll(/mark (?:the|this|that)?\s*(?:GitHub |Slack )?row\s+`([^`]+)`/gi)].map((m) => m[1])
  assert.ok(marks.length >= 8, `expected many row marks, got ${marks.length}`)
  for (const m of marks) {
    const head = m.split(':')[0].trim()
    assert.ok(results.includes(head), `row mark "${m}" is not a step 6 result`)
  }
})

test('PROPOSED CONTRACT: the add branch of item 6 applies only when no member matched, so item 3 still runs for an existing member', { todo: true }, () => {
  // Item 6 says "For `add`, a new hire is not an org member yet. Do not check
  // the username." with no "if no member matched" guard, while the `remove`
  // branch has one. An existing Snyk employee who transfers into AI Engineering
  // IS an org member (step 4 has a PUT path for them); an agent can read
  // "Do not check the username" as overriding the item 3 cross-check.
  assert.match(identityItems().items['6'], /For `add`, if no member matched/)
})
