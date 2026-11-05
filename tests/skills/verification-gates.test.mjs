// Structural invariants for the verification-gates skill.
//
// Run from the repo root:
//   docker run --rm -v "$PWD":/w -w /w node:latest node --test tests/skills/
//
// What a pass proves: the skill has loadable frontmatter (name matches its
// folder, a description within the 1024-character limit); its "Gates Fail
// Closed" section keeps the fail-closed classifier rule, the positive-control
// rule for negative results (98080f4), and the seeded-violation rule; and the
// positive-control rule treats an empty probe as "cannot evaluate", which is
// the same posture the classifier bullet gives empty input. Codex reaches the
// skill through a symlink (dot_agents/skills/symlink_verification-gates), so
// this file covers both. It does not prove that an agent follows the text.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const skill = readFileSync(new URL('../../dot_claude/skills/verification-gates/SKILL.md', import.meta.url), 'utf8')

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/)
  assert.ok(m, 'no --- frontmatter block at top of file')
  const out = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z-]+):\s*(.*)$/)
    if (kv) out[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1')
  }
  return out
}

function section(title) {
  const m = skill.match(new RegExp(`^### ${title}\\s*\\n([\\s\\S]*?)(?=^### |(?![\\s\\S]))`, 'm'))
  assert.ok(m, `no "### ${title}" section`)
  return m[1]
}

// Top-level "- " bullets with wrapped lines joined.
function bullets(body) {
  return body.split(/^- /m).slice(1).map((b) => b.replace(/\s+/g, ' ').trim())
}

const gates = () => bullets(section('Gates Fail Closed'))

test('frontmatter: name matches the folder, description fits the 1024-character limit', () => {
  const fm = frontmatter(skill)
  assert.equal(fm.name, 'verification-gates')
  assert.ok(fm.description && fm.description.length > 20 && fm.description.length <= 1024)
})

test('the Codex link points at this skill folder', () => {
  const link = new URL('../../dot_agents/skills/symlink_verification-gates', import.meta.url)
  assert.equal(readFileSync(link, 'utf8').trim(), '../../.claude/skills/verification-gates')
})

test('negative results need a positive control in the same run', () => {
  const b = gates().find((x) => x.startsWith('A negative result'))
  assert.ok(b, 'no "A negative result" bullet in Gates Fail Closed')
  assert.match(b, /counts only with a positive control in the same run/)
  assert.match(b, /show the probe seeing something it must see/)
})

test('an empty probe is "cannot evaluate", and a probe that counts outside traffic is rejected', () => {
  const b = gates().find((x) => x.startsWith('A negative result'))
  assert.match(b, /A probe that returns nothing is "cannot evaluate"/)
  assert.match(b, /counts traffic from outside the system under test is measuring the wrong thing/)
})

test('positive-control rule sits between the classifier and seeded-violation rules, which it depends on', () => {
  const g = gates()
  const i = (prefix) => g.findIndex((x) => x.startsWith(prefix))
  const classifier = i('Enumerate every "cannot evaluate" posture')
  const control = i('A negative result')
  const seeded = i('A new gate counts as installed')
  assert.ok(classifier >= 0 && seeded >= 0, 'classifier or seeded-violation bullet is gone')
  assert.ok(classifier < control && control < seeded, `bullet order: ${classifier}, ${control}, ${seeded}`)
  // The classifier bullet must still route "cannot evaluate" away from success,
  // or the positive-control rule's "cannot evaluate" verdict means nothing.
  assert.match(g[classifier], /never report success/)
})
