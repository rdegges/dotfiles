// dot_config/opencode/AGENTS.md.tmpl renders ~/.config/opencode/AGENTS.md from
// dot_claude/CLAUDE.md.tmpl with no reader override.
//
// Run from the repo root (chezmoi is needed; without it every test FAILS, it
// does not skip):
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin && node --test tests/claude/'
//
// What a pass proves: for work=false and work=true, chezmoi renders both
// targets from this source tree with a throwaway HOME, neither is empty, and
// they are byte-identical, so opencode and Claude Code read the same rules.
// It also proves the Brewfile installs opencode from homebrew-core only. It says
// nothing about how opencode reads the file; that needs a live session.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SOURCE = new URL('../../', import.meta.url).pathname

function render(target, work) {
  const home = mkdtempSync(join(tmpdir(), 'opencode-rules-'))
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

for (const work of [false, true]) {
  test(`work=${work}: opencode AGENTS.md is byte-identical to CLAUDE.md`, () => {
    const claude = render('.claude/CLAUDE.md', work)
    assert.ok(claude.startsWith('# Global CLAUDE.md'), JSON.stringify(claude.slice(0, 40)))
    assert.equal(render('.config/opencode/AGENTS.md', work), claude)
  })
}

test('Brewfile installs opencode from homebrew-core, not the v1 tap', () => {
  const lines = readFileSync(join(SOURCE, 'dot_brew/Brewfile'), 'utf8').split('\n')
  assert.ok(lines.includes('brew "opencode"'))
  assert.ok(!lines.some((l) => !l.startsWith('#') && l.includes('anomalyco/tap')), 'anomalyco/tap ships OpenCode 1 and would install a second copy')
})
