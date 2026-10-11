// Codex reads skills from ~/.agents/skills, not ~/.claude/skills. For each
// skill the Codex render of dot_claude/CLAUDE.md.tmpl names, chezmoi links
// ~/.agents/skills/<name> to ../../.claude/skills/<name> (dot_agents/skills/
// symlink_<name>), or the skill lives in dot_codex/skills.
//
// Run from the repo root (chezmoi is needed; without it every test FAILS, it
// does not skip):
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin && node --test tests/claude/'
//
// What a pass proves: for work=false and work=true, every `<name>` skill the
// Codex render names resolves to a Codex skill file chezmoi manages, apart
// from listed exclusions that still appear in the render; every managed
// ~/.agents/skills entry is a symlink to the same-named managed Claude skill;
// work-tracking is linked only on a work machine; and a real forced apply
// (scripts off) turns a stale real ~/.agents/skills/pr-writing directory into
// a link whose SKILL.md resolves to ~/.claude/skills/pr-writing/SKILL.md,
// while the skills tool's own entries stay as they were. It does not prove
// that Codex loads the linked skills (that needs a live Codex session), or
// that an interactive apply without --force replaces a stale directory.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SOURCE = new URL('../../', import.meta.url).pathname

// Skills the Codex render names that have no file location to link.
const EXCLUDED = {
  '/pkms:process-inbox': 'plugin skill from the pkms plugin, not a skill folder',
}

function chezmoi(home, work, args, input) {
  const r = spawnSync(
    'chezmoi',
    ['--source', SOURCE, '--destination', home, '--override-data', JSON.stringify({ work }), ...args],
    { encoding: 'utf8', input, env: { PATH: process.env.PATH, HOME: home } },
  )
  assert.ifError(r.error)
  assert.equal(r.status, 0, `chezmoi ${args.join(' ')} (work=${work}) exited ${r.status}: ${r.stderr}`)
  return r.stdout
}

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'agents-skills-'))
  try {
    return fn(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

const codexRender = (work) => withHome((home) => chezmoi(home, work, ['cat', join(home, '.codex/AGENTS.md')]))
const managed = (work, kind) => withHome((home) => chezmoi(home, work, ['managed', `--include=${kind}`]).split('\n').filter(Boolean))

function namedSkills(render) {
  return [...render.matchAll(/`([^`]+)` skill/g)].map((m) => m[1])
}

for (const work of [false, true]) {
  test(`work=${work}: every skill the Codex render names resolves to a managed Codex skill`, () => {
    const render = codexRender(work)
    const names = [...new Set(namedSkills(render))]
    assert.ok(names.length >= 5, `only ${names.length} skill names found: ${names}`)
    for (const ex of Object.keys(EXCLUDED)) assert.ok(names.includes(ex), `stale exclusion ${ex}: the Codex render no longer names it`)
    const files = managed(work, 'files')
    const links = managed(work, 'symlinks')
    for (const n of names.filter((n) => !(n in EXCLUDED))) {
      const codexSkill = files.includes(`.codex/skills/${n}/SKILL.md`)
      const linked = links.includes(`.agents/skills/${n}`)
      assert.ok(codexSkill || linked, `Codex render names \`${n}\` but neither ~/.codex/skills/${n} nor ~/.agents/skills/${n} is managed`)
    }
  })

  test(`work=${work}: every managed ~/.agents/skills entry links to its managed Claude skill`, () => {
    const files = managed(work, 'files')
    const links = managed(work, 'symlinks').filter((l) => l.startsWith('.agents/skills/'))
    assert.ok(links.length >= 4, `only ${links.length} links managed`)
    for (const l of links) {
      const n = l.slice('.agents/skills/'.length)
      const target = readFileSync(join(SOURCE, 'dot_agents/skills', `symlink_${n}`), 'utf8').trim()
      assert.equal(target, `../../.claude/skills/${n}`)
      assert.ok(files.includes(`.claude/skills/${n}/SKILL.md`), `~/.claude/skills/${n}/SKILL.md is not managed`)
    }
    assert.equal(links.includes('.agents/skills/work-tracking'), work, 'work-tracking link must follow the work flag')
  })

  test(`work=${work}: forced apply replaces a stale copy with a link and leaves the skills tool's entries alone`, () => {
    withHome((home) => {
      const agents = join(home, '.agents/skills')
      mkdirSync(join(agents, 'pr-writing'), { recursive: true })
      writeFileSync(join(agents, 'pr-writing/SKILL.md'), 'stale copy\n')
      for (const n of ['impeccable', 'use-railway']) {
        mkdirSync(join(agents, n), { recursive: true })
        writeFileSync(join(agents, n, 'SKILL.md'), `${n} from the skills tool\n`)
      }
      mkdirSync(join(home, '.claude/skills'), { recursive: true })
      symlinkSync('../../.agents/skills/impeccable', join(home, '.claude/skills/impeccable'))

      for (const pass of [1, 2]) {
        chezmoi(home, work, ['--no-tty', 'apply', '--force', '--exclude=scripts,externals'])
        for (const n of managed(work, 'symlinks').filter((l) => l.startsWith('.agents/skills/')).map((l) => l.slice('.agents/skills/'.length))) {
          const link = join(agents, n)
          assert.ok(lstatSync(link).isSymbolicLink(), `pass ${pass}: ~/.agents/skills/${n} is not a symlink`)
          assert.equal(realpathSync(join(link, 'SKILL.md')), realpathSync(join(home, '.claude/skills', n, 'SKILL.md')), `pass ${pass}: ${n} resolves elsewhere`)
        }
        assert.ok(lstatSync(join(agents, 'pr-writing')).isSymbolicLink(), `pass ${pass}: stale pr-writing directory survived`)
        assert.notEqual(readFileSync(join(agents, 'pr-writing/SKILL.md'), 'utf8'), 'stale copy\n')
        assert.equal(existsSync(join(agents, 'work-tracking')), work, `pass ${pass}: work-tracking link presence`)
        for (const n of ['impeccable', 'use-railway']) {
          assert.ok(lstatSync(join(agents, n)).isDirectory(), `pass ${pass}: ${n} changed type`)
          assert.equal(readFileSync(join(agents, n, 'SKILL.md'), 'utf8'), `${n} from the skills tool\n`, `pass ${pass}: ${n} changed`)
        }
        assert.equal(readlinkSync(join(home, '.claude/skills/impeccable')), '../../.agents/skills/impeccable', `pass ${pass}: impeccable link changed`)
      }
    })
  })
}
