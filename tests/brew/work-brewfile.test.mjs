// dot_brew/Brewfile.work holds work-only Homebrew packages (awscli). chezmoi
// writes ~/.brew/Brewfile.work only when work = true (.chezmoiignore), and
// run_onchange_install-packages.sh.tmpl bundles it after the shared Brewfile.
//
// Run from the repo root (chezmoi and bash are needed; without chezmoi every
// test FAILS, it does not skip):
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin && node --test tests/brew/'
//
// What a pass proves, for this source tree with a throwaway HOME:
// - work=true: apply writes ~/.brew/Brewfile.work byte-equal to the source, and
//   the darwin install script embeds both Brewfile hashes, so editing either file
//   re-runs it on the next hourly `chezmoi update`.
// - work=false: Brewfile.work is neither managed nor written, and the install
//   script names it nowhere, so personal machines never install awscli and never
//   re-run the script because of this file.
// - The rendered script, run against a stub `brew`, bundles the shared Brewfile
//   and then Brewfile.work; a failure in either bundle makes the script exit
//   non-zero (so chezmoi retries) without skipping the other bundle or the rest
//   of the script.
// A pass does not prove that real Homebrew installs awscli or that `aws` is on
// PATH; that needs a real work Mac.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const SOURCE = new URL('../../', import.meta.url).pathname
const SCRIPT = 'run_onchange_install-packages.sh.tmpl'
const sha = (f) => createHash('sha256').update(readFileSync(join(SOURCE, f))).digest('hex')

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'work-brewfile-'))
  try {
    return fn(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function chezmoi(home, data, args, input) {
  const r = spawnSync('chezmoi', ['--source', SOURCE, '--destination', home, '--override-data', JSON.stringify(data), ...args], {
    encoding: 'utf8',
    input,
    env: { PATH: process.env.PATH, HOME: home },
  })
  assert.ifError(r.error)
  assert.equal(r.status, 0, `chezmoi ${args.join(' ')} (${JSON.stringify(data)}) exited ${r.status}: ${r.stderr}`)
  return r.stdout
}

const renderScript = (data) => withHome((home) => chezmoi(home, data, ['execute-template'], readFileSync(join(SOURCE, SCRIPT), 'utf8')))

function entries(file) {
  return readFileSync(join(SOURCE, file), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const m = l.match(/^(brew|cask|tap|mas|vscode)\s+"([^"]+)"/)
      assert.ok(m, `${file}: unparsed line ${JSON.stringify(l)}`)
      return { kind: m[1], name: m[2] }
    })
}

test('Brewfile.work installs awscli from homebrew-core and nothing else', () => {
  assert.deepEqual(entries('dot_brew/Brewfile.work'), [{ kind: 'brew', name: 'awscli' }])
})

// A shared-Brewfile entry would install awscli on personal machines too, which
// is exactly what Brewfile.work exists to prevent. The `bd` alias can put it
// there (see the PROPOSED CONTRACT below).
test('shared Brewfile has no awscli entry and no entry that Brewfile.work also lists', () => {
  const shared = entries('dot_brew/Brewfile')
  assert.ok(shared.length > 20, `only ${shared.length} shared entries parsed`)
  assert.ok(!shared.some(({ name }) => /(^|\/)(awscli|aws-cli|awscli@\d+)$/.test(name)), 'awscli is in the shared Brewfile')
  for (const w of entries('dot_brew/Brewfile.work')) {
    assert.ok(!shared.some((s) => s.kind === w.kind && s.name === w.name), `${w.kind} "${w.name}" is in both Brewfiles`)
  }
})

for (const work of [false, true]) {
  test(`work=${work}: chezmoi ${work ? 'manages' : 'does not manage'} ~/.brew/Brewfile.work and always manages ~/.brew/Brewfile`, () => {
    const lines = withHome((home) => chezmoi(home, { work }, ['managed', '--include=files'])).split('\n')
    assert.ok(lines.includes('.brew/Brewfile'), 'shared Brewfile is not managed')
    assert.equal(lines.includes('.brew/Brewfile.work'), work)
  })

  test(`work=${work}: apply ${work ? 'writes' : 'does not write'} ~/.brew/Brewfile.work and is stable on a second pass`, () => {
    withHome((home) => {
      for (const pass of [1, 2]) {
        chezmoi(home, { work }, ['--no-tty', 'apply', '--force', '--exclude=scripts,externals'])
        const path = join(home, '.brew/Brewfile.work')
        assert.equal(existsSync(path), work, `pass ${pass}: Brewfile.work exists=${existsSync(path)}`)
        if (work) assert.equal(readFileSync(path, 'utf8'), readFileSync(join(SOURCE, 'dot_brew/Brewfile.work'), 'utf8'), `pass ${pass}`)
        assert.equal(readFileSync(join(home, '.brew/Brewfile'), 'utf8'), readFileSync(join(SOURCE, 'dot_brew/Brewfile'), 'utf8'), `pass ${pass}: shared Brewfile`)
      }
    })
  })

  test(`work=${work}: install script renders to nothing off darwin`, () => {
    assert.equal(renderScript({ work, chezmoi: { os: 'linux' } }), '')
  })
}

test('work=true: darwin install script embeds both Brewfile hashes in its header', () => {
  const out = renderScript({ work: true, chezmoi: { os: 'darwin' } })
  const header = out.split('\n').slice(0, 3)
  assert.deepEqual(header, ['#!/bin/bash', `# ~/.brew/Brewfile hash: ${sha('dot_brew/Brewfile')}`, `# ~/.brew/Brewfile.work hash: ${sha('dot_brew/Brewfile.work')}`])
})

// Personal machines must render the same script as before this change, or the
// hourly update would re-run every brew bundle there for nothing.
test('work=false: darwin install script never names Brewfile.work', () => {
  const out = renderScript({ work: false, chezmoi: { os: 'darwin' } })
  assert.ok(out.startsWith(`#!/bin/bash\n# ~/.brew/Brewfile hash: ${sha('dot_brew/Brewfile')}\n\n`), JSON.stringify(out.slice(0, 120)))
  assert.ok(!out.includes('Brewfile.work'), 'work=false script mentions Brewfile.work')
  assert.ok(!out.includes('{{') && !out.includes('}}'), 'unrendered template text left in the script')
})

// The rendered work and personal scripts differ only by the work hash line and
// the work bundle block, so nothing else in the script is accidentally gated.
test('work=true script is the work=false script plus the hash line and the work bundle block', () => {
  const personal = renderScript({ work: false, chezmoi: { os: 'darwin' } })
  const workOut = renderScript({ work: true, chezmoi: { os: 'darwin' } })
  const stripped = workOut
    .replace(/^# ~\/\.brew\/Brewfile\.work hash: [0-9a-f]{64}\n/m, '')
    .replace(/^ {4}# Work-only packages[\s\S]*?_bundle_failed=1\n {4}fi\n/m, '')
  assert.notEqual(stripped, workOut)
  assert.equal(stripped, personal)
})

// Runs the rendered darwin script with a stub `brew` that logs every call and
// fails `brew bundle` for any --file listed in BREW_FAIL. SHELL=/bin/sh skips the
// oh-my-zsh installer, so nothing touches the network.
function runScript(work, { fail = [], trust = false, seed } = {}) {
  const script = renderScript({ work, chezmoi: { os: 'darwin' } })
  return withHome((home) => {
    chezmoi(home, { work }, ['--no-tty', 'apply', '--force', '--exclude=scripts,externals', join(home, '.brew')])
    if (seed) seed(home)
    const bin = join(home, 'stub-bin')
    mkdirSync(bin)
    const log = join(home, 'brew.log')
    writeFileSync(
      join(bin, 'brew'),
      `#!/bin/sh
# bash leaves --file=~/... unexpanded and real brew expands it, so do the same.
file=$(printf '%s' "$2" | sed "s#^--file=~/#--file=$HOME/#")
printf '%s\n' "$*" | sed "s#--file=~/#--file=$HOME/#" >> "${log}"
if [ "$1" = trust ]; then [ "${trust ? 1 : 0}" = 1 ] && exit 0; exit 1; fi
if [ "$1" = bundle ]; then
  for f in $BREW_FAIL; do [ "$file" = "--file=$f" ] && { echo "stub bundle failed: $f" >&2; exit 1; }; done
fi
exit 0
`,
    )
    chmodSync(join(bin, 'brew'), 0o755)
    const path = join(home, 'install-packages.sh')
    writeFileSync(path, script)
    const r = spawnSync('bash', [path], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, SHELL: '/bin/sh', BREW_FAIL: fail.map((f) => join(home, f)).join(' ') },
    })
    assert.ifError(r.error)
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls, home }
  })
}

const bundles = (calls) => calls.filter((c) => c.startsWith('bundle '))

test('work=true: script bundles the shared Brewfile, then Brewfile.work, and exits 0', () => {
  const r = runScript(true)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(bundles(r.calls), [`bundle --file=${r.home}/.brew/Brewfile`, `bundle --file=${r.home}/.brew/Brewfile.work`])
  assert.ok(r.stdout.includes('zsh is not the current shell'), 'script stopped before the oh-my-zsh step')
})

test('work=false: script bundles only the shared Brewfile', () => {
  const r = runScript(false)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(bundles(r.calls), [`bundle --file=${r.home}/.brew/Brewfile`])
})

test('work=true: a failed Brewfile.work bundle fails the script without skipping the rest', () => {
  const r = runScript(true, { fail: ['.brew/Brewfile.work'] })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /brew bundle failed for Brewfile\.work/)
  assert.ok(r.stdout.includes('zsh is not the current shell'), 'script stopped before the oh-my-zsh step')
})

test('work=true: a failed shared bundle still runs the Brewfile.work bundle, and the script fails', () => {
  const r = runScript(true, { fail: ['.brew/Brewfile'] })
  assert.equal(r.status, 1)
  assert.deepEqual(bundles(r.calls), [`bundle --file=${r.home}/.brew/Brewfile`, `bundle --file=${r.home}/.brew/Brewfile.work`])
})

test('work=true: both bundles failing still exits 1, not 2 or 0', () => {
  const r = runScript(true, { fail: ['.brew/Brewfile', '.brew/Brewfile.work'] })
  assert.equal(r.status, 1)
  assert.equal(bundles(r.calls).length, 2)
})

// The trust loop reads only ~/.brew/Brewfile. A future third-party tap added to
// Brewfile.work is never trusted, so newer Homebrew aborts that bundle. Today's
// awscli is homebrew-core, so this is latent, not live.
test('PROPOSED CONTRACT: work=true: taps listed in Brewfile.work are trusted before it is bundled', { todo: true }, () => {
  const r = runScript(true, {
    trust: true,
    seed: (home) => writeFileSync(join(home, '.brew/Brewfile.work'), 'tap "example/worktap"\nbrew "example/worktap/tool"\n'),
  })
  assert.ok(r.calls.includes('trust --tap example/worktap'), JSON.stringify(r.calls.filter((c) => c.startsWith('trust'))))
})

// The `bd` alias dumps every installed package into the shared Brewfile and
// `chezmoi add`s it; with autoCommit/autoPush that ships awscli to every
// personal machine on their next hourly update. The README asks for a manual
// fix-up; this pins that the alias itself keeps work-only entries out.
test('PROPOSED CONTRACT: work=true: the bd alias keeps Brewfile.work entries out of the shared Brewfile', { todo: true }, () => {
  const aliases = withHome((home) => chezmoi(home, { work: true }, ['cat', join(home, '.oh-my-zsh/custom/aliases.zsh')]))
  const bd = aliases.split('\n').find((l) => l.startsWith('alias bd='))
  assert.ok(bd, 'no bd alias')
  assert.ok(bd.includes('Brewfile.work'), `bd alias ignores Brewfile.work: ${bd}`)
})
