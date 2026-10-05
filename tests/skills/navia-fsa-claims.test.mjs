// Structural and safety invariants for the navia-fsa-claims Codex skill, and
// its tie to the standing exception in the global CLAUDE.md Browser rules.
//
// Run from the repo root:
//   docker run --rm -v "$PWD":/w -w /w node:latest node --test tests/skills/
//
// What a pass proves: every skill under dot_codex/skills has loadable
// frontmatter; the Navia skill grants no authorization of its own and cites
// the global exception; that exception exists in CLAUDE.md.tmpl, names the
// skill, covers only the final Send, keeps terms acceptance behind a
// confirmation, and leaves the general irreversible-step rule intact; the
// skill's procedure orders duplicate check, upload, review, and terms
// confirmation before Send; and the skill keeps its no-credentials,
// no-resubmit, "submitted not approved", and health-data screenshot rules.
// It says nothing about whether the live Navia UI still matches the text,
// or whether an agent obeys it; that needs a supervised real claim.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'

const CODEX_SKILLS = new URL('../../dot_codex/skills/', import.meta.url)
const CLAUDE_SKILLS = new URL('../../dot_claude/skills/', import.meta.url)
const skill = readFileSync(new URL('navia-fsa-claims/SKILL.md', CODEX_SKILLS), 'utf8')
const claudeMd = readFileSync(new URL('../../dot_claude/CLAUDE.md.tmpl', import.meta.url), 'utf8')

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/)
  if (!m) return null
  const out = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z-]+):\s*(.*)$/)
    if (kv) out[kv[1]] = kv[2]
  }
  return out
}

function section(title) {
  const m = skill.match(new RegExp(`^## ${title}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'))
  assert.ok(m, `no "## ${title}" section`)
  return m[1]
}

// Numbered steps of a section, keyed by number, so checks can target one.
function steps(body) {
  const out = {}
  for (const m of body.matchAll(/^(\d+)\. (.*)$/gm)) out[Number(m[1])] = m[2]
  return out
}

// The one Browser bullet that carries the irreversible-step rule.
function browserBullet() {
  const lines = claudeMd.split('\n').filter((l) => l.includes('the step is irreversible'))
  assert.equal(lines.length, 1, 'expected exactly one irreversible-step bullet in CLAUDE.md.tmpl')
  return lines[0]
}

// --- Sibling fit: Codex skills load too -------------------------------------

const codexDirs = readdirSync(CODEX_SKILLS, { withFileTypes: true }).filter((d) => d.isDirectory())

test('dot_codex/skills is scanned (an empty scan would pass vacuously)', () => {
  assert.ok(codexDirs.some((d) => d.name === 'navia-fsa-claims'), codexDirs.map((d) => d.name).join(', '))
})

for (const dir of codexDirs) {
  test(`codex skill ${dir.name}: frontmatter name matches its directory and has a description`, () => {
    const path = new URL(`${dir.name}/SKILL.md`, CODEX_SKILLS)
    assert.ok(existsSync(path), `${dir.name} has no SKILL.md`)
    const fm = frontmatter(readFileSync(path, 'utf8'))
    assert.ok(fm, `${dir.name}: no --- frontmatter block at top of file`)
    assert.equal(fm.name, dir.name)
    assert.ok(fm.description && fm.description.length > 20, `${dir.name}: empty or trivial description`)
    // A plain YAML scalar may not contain ": "; it would fail to parse.
    assert.ok(/^["']/.test(fm.description) || !fm.description.includes(': '), 'unquoted ": " in description')
  })
}

test('description scopes the skill to Navia and excludes other FSA providers', () => {
  const d = frontmatter(skill).description
  assert.match(d, /Navia/)
  assert.match(d, /do not use for other FSA providers/i)
})

// --- Regression pin: the exception lives in the global rules, not the skill ---

test('CLAUDE.md keeps the general irreversible-step rule in the same bullet as the Navia exception', () => {
  const b = browserBullet()
  assert.match(b, /the step is irreversible \(submit, delete, pay, send\), ask me before doing it in Chrome\./)
  assert.ok(b.indexOf('ask me before doing it in Chrome.') < b.indexOf('Standing exception:'), 'exception must follow the rule it narrows')
})

test('the global Navia exception names the skill, covers only the final Send, and keeps terms behind a confirmation', () => {
  const b = browserBullet()
  const ex = b.slice(b.indexOf('Standing exception:'))
  assert.ok(b.includes('Standing exception:'), 'no Standing exception in the irreversible-step bullet')
  assert.match(ex, /`navia-fsa-claims` skill/)
  assert.match(ex, /\*\*Send claim to Navia\*\*/)
  assert.match(ex, /once its details match the source documents/)
  assert.match(ex, /accepting Navia's terms still needs my confirmation/)
  // Exactly one bolded action is authorized.
  assert.deepEqual(ex.match(/\*\*[^*]+\*\*/g), ['**Send claim to Navia**'])
  assert.equal((claudeMd.match(/Standing exception:/g) ?? []).length, 1, 'more than one standing exception')
})

test('the skill the global exception cites exists in the source tree', () => {
  const name = browserBullet().match(/`([a-z0-9-]+)` skill/)[1]
  assert.ok(
    existsSync(new URL(`${name}/SKILL.md`, CODEX_SKILLS)) || existsSync(new URL(`${name}/SKILL.md`, CLAUDE_SKILLS)),
    `CLAUDE.md cites \`${name}\` but no SKILL.md exists for it`,
  )
})

test('the skill grants no exception of its own and cites the global one', () => {
  const pre = skill.slice(skill.indexOf('# Navia FSA claims'), skill.indexOf('## Prepare the evidence'))
  assert.match(pre, /This skill grants no exception of its own/)
  assert.match(pre, /standing exception for the final \*\*Send claim to Navia\*\*/)
  assert.match(pre, /every other confirmation rule still applies/)
  // The authority the request itself confers stops before Send.
  const own = pre.match(/A request to submit a receipt to Navia authorizes ([^.]*)\./)
  assert.ok(own, 'no statement of what the request authorizes')
  assert.doesNotMatch(own[1], /Send|submit|terms|agree/i, `request-level authority grew: ${own[1]}`)
  const s6 = steps(section('Submit in Navia'))[6]
  assert.match(s6, /under the Navia exception in the global Browser rules/)
})

// --- Procedure ordering -------------------------------------------------------

test('Send comes only after the duplicate check, upload, review, and terms confirmation', () => {
  const s = steps(section('Submit in Navia'))
  assert.deepEqual(Object.keys(s).map(Number), [1, 2, 3, 4, 5, 6, 7], 'submit steps renumbered or missing')
  assert.match(s[2], /likely duplicate/)
  assert.match(s[3], /wait until Navia lists the file as uploaded/)
  assert.match(s[5], /\*\*I'm finished\*\* and check the resulting claim item against the source document/)
  assert.ok(s[6].indexOf('action-time confirmation') < s[6].indexOf('Send claim to Navia'), 'Send precedes terms confirmation in step 6')
  for (const n of [1, 2, 3, 4, 5]) assert.doesNotMatch(s[n], /Send claim to Navia/, `Send appears early, in step ${n}`)
})

test('a material discrepancy stops the claim before submission', () => {
  assert.match(skill, /Stop before submission if Navia shows an unexpected amount, patient, plan year, duplicate, or other material discrepancy/)
})

test('evidence rules: payment dates are not service dates, payment confirmations alone do not substantiate', () => {
  const ev = section('Prepare the evidence')
  assert.match(ev, /Treat a payment date as a payment date, never as the service date/)
  assert.match(ev, /A payment confirmation alone does not substantiate/)
  assert.match(ev, /ask the user for that specific item before completing the claim/)
})

// --- Safety invariants --------------------------------------------------------

test('never types credentials or MFA codes; a login wall means asking the user', () => {
  const s1 = steps(section('Submit in Navia'))[1]
  assert.match(s1, /Never type credentials or MFA codes/)
  assert.match(s1, /ask the user to sign in in that tab/)
  assert.match(s1, /Do not switch to a different browser/)
})

test('an unconfirmed Send is never retried blind', () => {
  const s7 = steps(section('Submit in Navia'))[7]
  assert.match(s7, /do not resubmit/)
  assert.match(s7, /Check the claims list or account statement for the claim first/)
  assert.match(s7, /ask the user before any second attempt/)
})

test('reports "submitted", never "approved", until Navia approves', () => {
  assert.match(steps(section('Submit in Navia'))[7], /Say “submitted,” not “approved,”/)
})

test('receipt screenshots carry health data and stay in the session scratch directory', () => {
  const s7 = steps(section('Submit in Navia'))[7]
  assert.match(s7, /Keep any screenshot in the session scratch directory only/)
  assert.match(s7, /Never commit it, put it in the vault, or attach it anywhere else/)
})

// Codex reads ~/AGENTS.md / ~/.codex/AGENTS.md, which chezmoi does not manage;
// on the test machine both lacked the Navia exception this Codex skill cites.
test.todo('PROPOSED CONTRACT: the global rules Codex loads carry the Navia exception the codex skill cites')
