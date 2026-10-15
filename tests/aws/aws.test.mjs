// private_dot_aws/modify_private_config (the managed snyk-sandbox block in
// ~/.aws/config) and the work-only `aws` zsh function in
// dot_oh-my-zsh/custom/aliases.zsh.tmpl.
//
// Run from the repo root (zsh is needed for the function tests, chezmoi for
// the render and deploy tests; without them those tests skip):
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'apt-get update -qq && apt-get install -y -qq zsh gawk original-awk busybox >/dev/null &&
//      sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin &&
//      node --test tests/aws/'
//
// What a pass proves: the modify script, fed any existing ~/.aws/config,
// prints every foreign line unchanged plus exactly one current managed block,
// is idempotent, replaces a stale block in place, and fails closed (non-zero,
// no output) on a managed section name outside the markers or on unbalanced or
// repeated markers. Through the real source tree, chezmoi manages ~/.aws/config
// (0600 in a 0700 ~/.aws) only on work machines, never ~/.aws/credentials or
// the caches, keeps foreign profiles, changes nothing on a second apply, and
// refuses to write on a collision. The rendered `aws` function, against a stub
// binary, injects the default profile only when no --profile, AWS_PROFILE,
// AWS_DEFAULT_PROFILE, or exported key is set; honors --profile and --profile=; checks the session only
// for snyk-sandbox; logs in on stderr only when the check fails, with
// --use-device-code over SSH; and runs nothing after a failed login. It says
// nothing about live Identity Center sign-in; that is checked by hand on the
// work laptop (valid session, then `aws sso logout` and one login) before merge. The collision-invariant tests read the
// script's output the way botocore's configloader does (RawConfigParser, then
// shlex.split on section names), via python3; gawk, original-awk (BWK, the
// macOS awk family) and busybox awk are optional and their tests skip without
// them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, statSync, existsSync, chmodSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('../../', import.meta.url)
const MODIFY = new URL('private_dot_aws/modify_private_config', ROOT).pathname
const ALIASES = new URL('dot_oh-my-zsh/custom/aliases.zsh.tmpl', ROOT).pathname

const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0
const cskip = has('chezmoi') ? false : 'chezmoi not installed (see the run command at the top)'
const zskip = has('zsh') ? false : 'zsh not installed (see the run command at the top)'

const modify = (input) => spawnSync('sh', [MODIFY], { input, encoding: 'utf8' })

// The managed block, taken from the script's own output for an empty file.
const BLOCK = modify('').stdout
const START = '# >>> chezmoi: snyk-sandbox >>>'
const END = '# <<< chezmoi: snyk-sandbox <<<'

// --- The modify script ------------------------------------------------------------

test('an empty or missing file becomes the managed block only', () => {
  const r = modify('')
  assert.equal(r.status, 0, r.stderr)
  assert.ok(r.stdout.startsWith(START + '\n'))
  assert.ok(r.stdout.endsWith(END + '\n'))
  assert.match(r.stdout, /^\[sso-session snyk\]$/m)
  assert.match(r.stdout, /^\[profile snyk-sandbox\]$/m)
  assert.match(r.stdout, /^sso_account_id = 597564118722$/m)
})

test('foreign lines survive byte for byte, and the block is appended after a blank line', () => {
  const foreign = '[default]\nregion = eu-west-1\n\n# a comment\n[profile other]\n  role_arn = arn:aws:iam::1:role/x\t \n'
  const r = modify(foreign)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, foreign + '\n' + BLOCK)
})

test('input without a trailing newline keeps its lines', () => {
  const r = modify('[profile other]\nregion = eu-west-1')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '[profile other]\nregion = eu-west-1\n\n' + BLOCK)
})

test('a second pass changes nothing', () => {
  const once = modify('[profile other]\nregion = x\n').stdout
  const twice = modify(once)
  assert.equal(twice.status, 0, twice.stderr)
  assert.equal(twice.stdout, once)
})

test('a stale block is replaced in place, with the lines around it kept', () => {
  const stale = `[profile a]\nx = 1\n${START}\n[sso-session snyk]\nsso_region = us-east-1\n${END}\n[profile b]\ny = 2\n`
  const r = modify(stale)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '[profile a]\nx = 1\n' + BLOCK + '[profile b]\ny = 2\n')
  assert.doesNotMatch(r.stdout, /us-east-1/)
})

for (const header of ['[sso-session snyk]', '[profile snyk-sandbox]', '  [ sso-session   snyk ]  ', '[profile  snyk-sandbox]\t']) {
  test(`a managed section outside the markers fails closed: ${JSON.stringify(header)}`, () => {
    const r = modify(`[profile other]\n${header}\nfoo = bar\n`)
    assert.notEqual(r.status, 0)
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /outside the chezmoi markers/)
  })
}

test('similar names that are not managed pass through', () => {
  const foreign = '[sso-session snyk-prod]\n[profile snyk-sandbox-2]\n[profile snyk]\n'
  const r = modify(foreign)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, foreign + '\n' + BLOCK)
})

for (const [name, input] of [
  ['start marker without an end marker', `${START}\n[profile x]\n`],
  ['end marker without a start marker', `[profile x]\n${END}\n`],
  ['two managed blocks', BLOCK + BLOCK],
  ['nested start marker', `${START}\n${START}\n${END}\n`],
]) {
  test(`unbalanced or repeated markers fail closed: ${name}`, () => {
    const r = modify(input)
    assert.notEqual(r.status, 0)
    assert.equal(r.stdout, '')
  })
}

// --- chezmoi deploys it -----------------------------------------------------------

// The real source tree, a scratch destination, and only the ~/.aws targets, so
// no script runs and the real HOME is never touched.
function withDeploy(work, fn) {
  const base = mkdtempSync(join(tmpdir(), 'aws-deploy-'))
  try {
    const home = join(base, 'home')
    mkdirSync(home)
    const cfg = join(base, 'chezmoi.toml')
    writeFileSync(cfg, `[data]\n  work = ${work}\n`)
    const cz = (...args) =>
      spawnSync(
        'chezmoi',
        ['--source', ROOT.pathname, '--destination', home, '--config', cfg, '--no-tty',
          ...(['managed', 'ignored'].includes(args[0]) ? [] : ['--exclude', 'scripts']), ...args],
        { encoding: 'utf8', env: { ...process.env, HOME: home } },
      )
    return fn({ home, cz })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

test('[work=true] chezmoi writes the block to ~/.aws/config, 0600 in a 0700 ~/.aws', { skip: cskip }, () =>
  withDeploy(true, ({ home, cz }) => {
    const r = cz('apply', '--force', join(home, '.aws'))
    assert.equal(r.status, 0, r.stderr)
    const dst = join(home, '.aws', 'config')
    assert.equal(readFileSync(dst, 'utf8'), BLOCK)
    assert.equal(statSync(dst).mode & 0o777, 0o600)
    assert.equal(statSync(join(home, '.aws')).mode & 0o777, 0o700)
  }))

test('[work=true] chezmoi manages only ~/.aws/config under ~/.aws', { skip: cskip }, () =>
  withDeploy(true, ({ home, cz }) => {
    const r = cz('managed', '--path-style', 'relative', '--include', 'files,dirs')
    assert.equal(r.status, 0, r.stderr)
    const aws = r.stdout.split('\n').filter((l) => l === '.aws' || l.startsWith('.aws/'))
    assert.deepEqual(aws.sort(), ['.aws', '.aws/config'])
  }))

test('[work=true] foreign profiles and other files survive, and a second apply changes nothing', { skip: cskip }, () =>
  withDeploy(true, ({ home, cz }) => {
    const dir = join(home, '.aws')
    mkdirSync(dir, { mode: 0o700 })
    const foreign = '[profile other]\nregion = eu-west-1\n'
    writeFileSync(join(dir, 'config'), foreign, { mode: 0o600 })
    writeFileSync(join(dir, 'credentials'), '[other]\naws_access_key_id = AKIAEXAMPLE\n', { mode: 0o600 })
    let r = cz('apply', '--force', dir)
    assert.equal(r.status, 0, r.stderr)
    const first = readFileSync(join(dir, 'config'), 'utf8')
    assert.equal(first, foreign + '\n' + BLOCK)
    assert.equal(readFileSync(join(dir, 'credentials'), 'utf8'), '[other]\naws_access_key_id = AKIAEXAMPLE\n')
    r = cz('diff', dir)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, '')
    r = cz('apply', '--force', dir)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readFileSync(join(dir, 'config'), 'utf8'), first)
  }))

test('[work=true] a collision fails the apply and leaves the file as it was', { skip: cskip }, () =>
  withDeploy(true, ({ home, cz }) => {
    const dir = join(home, '.aws')
    mkdirSync(dir, { mode: 0o700 })
    const handwritten = '[sso-session snyk]\nsso_region = eu-west-1\n'
    writeFileSync(join(dir, 'config'), handwritten, { mode: 0o600 })
    const r = cz('apply', '--force', dir)
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /outside the chezmoi markers/)
    assert.equal(readFileSync(join(dir, 'config'), 'utf8'), handwritten)
  }))

test('[work=false] a full apply creates no ~/.aws', { skip: cskip }, () =>
  withDeploy(false, ({ home, cz }) => {
    const r = cz('apply', '--force')
    assert.equal(r.status, 0, r.stderr)
    assert.equal(existsSync(join(home, '.aws')), false)
  }))

test('[work=false] an existing ~/.aws is left alone', { skip: cskip }, () =>
  withDeploy(false, ({ home, cz }) => {
    const dir = join(home, '.aws')
    mkdirSync(dir, { mode: 0o755 })
    writeFileSync(join(dir, 'config'), '[sso-session snyk]\n', { mode: 0o644 })
    const r = cz('apply', '--force')
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readFileSync(join(dir, 'config'), 'utf8'), '[sso-session snyk]\n')
    assert.equal(statSync(join(dir, 'config')).mode & 0o777, 0o644)
  }))

// --- The aws function ---------------------------------------------------------------

function render(work) {
  const base = mkdtempSync(join(tmpdir(), 'aws-render-'))
  try {
    const cfg = join(base, 'chezmoi.toml')
    writeFileSync(cfg, `[data]\n  work = ${work}\n`)
    const r = spawnSync('chezmoi', ['--source', ROOT.pathname, '--config', cfg, 'execute-template', '--file', ALIASES], {
      encoding: 'utf8',
    })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

test('[work=false] no aws function is rendered', { skip: cskip }, () => {
  assert.doesNotMatch(render(false), /^aws\(\)/m)
})

// Runs `cmd` in zsh with the rendered aliases sourced and a stub `aws` first on
// PATH. The stub logs each call's argv to a file and its env view to stdout.
// STUB_EXPORT=fail makes `configure export-credentials` fail (expired session);
// STUB_LOGIN=fail makes `sso login` fail. STUB_EXPORT_OUT=1 makes the check print
// a fake secret on stdout and stderr, as the real export-credentials prints keys.
// STUB_RC sets the exit code of the final command.
function withFn(cmd, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aws-fn-'))
  try {
    const aliases = join(dir, 'aliases.zsh')
    writeFileSync(aliases, render(true))
    const log = join(dir, 'calls')
    const stub = join(dir, 'aws')
    writeFileSync(stub, `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$*" in
  *"configure export-credentials"*)
    [ -n "\${STUB_EXPORT_OUT-}" ] && { echo '{"SecretAccessKey": "STUB-SECRET"}'; echo 'STUB-SECRET-ERR' >&2; }
    [ "\${STUB_EXPORT-}" = fail ] && exit 255; exit 0 ;;
  "sso login"*) echo "login-output"; [ "\${STUB_LOGIN-}" = fail ] && exit 1; exit 0 ;;
esac
printf 'ran:'; for a; do printf ' [%s]' "$a"; done; echo
exit "\${STUB_RC:-0}"
`)
    chmodSync(stub, 0o755)
    const r = spawnSync('zsh', ['-f', '-c', `source ${aliases}; PATH=${dir}:$PATH; ${cmd}`], {
      encoding: 'utf8',
      env: { HOME: dir, PATH: '/usr/bin:/bin', ...env },
    })
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
    return { ...r, calls }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const CHECK = 'configure export-credentials --profile snyk-sandbox'

test('[work=true] the aliases file parses (zsh -n)', { skip: cskip || zskip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'aws-parse-'))
  try {
    const f = join(dir, 'a.zsh')
    writeFileSync(f, render(true))
    const r = spawnSync('zsh', ['-n', f], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no profile set: checks the session, then injects --profile snyk-sandbox', { skip: cskip || zskip }, () => {
  const r = withFn('aws s3 ls')
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.calls, [CHECK, '--profile snyk-sandbox s3 ls'])
})

test('a valid session never runs sso login', { skip: cskip || zskip }, () => {
  const r = withFn('aws sts get-caller-identity')
  assert.ok(!r.calls.some((c) => c.startsWith('sso login')), r.calls.join('\n'))
})

test('an expired session logs in on stderr, then runs the command with clean stdout', { skip: cskip || zskip }, () => {
  const r = withFn('aws sts get-caller-identity', { STUB_EXPORT: 'fail' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.calls, [CHECK, 'sso login --profile snyk-sandbox', '--profile snyk-sandbox sts get-caller-identity'])
  assert.equal(r.stdout, 'ran: [--profile] [snyk-sandbox] [sts] [get-caller-identity]\n')
  assert.match(r.stderr, /login-output/)
})

test('over SSH the login uses the device-code flow', { skip: cskip || zskip }, () => {
  const r = withFn('aws s3 ls', { STUB_EXPORT: 'fail', SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' })
  assert.ok(r.calls.includes('sso login --profile snyk-sandbox --use-device-code'), r.calls.join('\n'))
})

test('a failed login returns non-zero and runs no command', { skip: cskip || zskip }, () => {
  const r = withFn('aws s3 ls', { STUB_EXPORT: 'fail', STUB_LOGIN: 'fail' })
  assert.notEqual(r.status, 0)
  assert.deepEqual(r.calls, [CHECK, 'sso login --profile snyk-sandbox'])
})

for (const [name, cmd] of [['--profile X', 'aws --profile other s3 ls'], ['--profile=X', 'aws s3 ls --profile=other']]) {
  test(`${name} passes straight through, with no check and no injection`, { skip: cskip || zskip }, () => {
    const r = withFn(cmd)
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(r.calls, [cmd.slice(4)])
  })
}

test('--profile snyk-sandbox is checked but not injected twice', { skip: cskip || zskip }, () => {
  const r = withFn('aws --profile snyk-sandbox s3 ls')
  assert.deepEqual(r.calls, [CHECK, '--profile snyk-sandbox s3 ls'])
})

test('AWS_PROFILE is honored with no injection; snyk-sandbox there is still checked', { skip: cskip || zskip }, () => {
  assert.deepEqual(withFn('aws s3 ls', { AWS_PROFILE: 'other' }).calls, ['s3 ls'])
  assert.deepEqual(withFn('aws s3 ls', { AWS_PROFILE: 'snyk-sandbox' }).calls, [CHECK, 's3 ls'])
})

test('exported AWS_ACCESS_KEY_ID skips the injection and the check', { skip: cskip || zskip }, () => {
  const r = withFn('aws s3 ls', { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 'x' })
  assert.deepEqual(r.calls, ['s3 ls'])
})

for (const first of ['', 'sso login', 'configure list', 'help', '--version', '--help']) {
  test(`\`aws ${first}\` skips the check and the injection`, { skip: cskip || zskip }, () => {
    const r = withFn(`aws ${first}`)
    assert.deepEqual(r.calls, [first])
  })
}

test('arguments with spaces reach the binary intact', { skip: cskip || zskip }, () => {
  const r = withFn(`aws s3 cp "a b.txt" s3://bucket/`)
  assert.equal(r.stdout.trim(), 'ran: [--profile] [snyk-sandbox] [s3] [cp] [a b.txt] [s3://bucket/]')
})

// --- Tester additions: collisions as the AWS CLI reads them ---------------------------

// botocore (configloader.raw_config_parse / build_profile_map) reads the file
// with a strict RawConfigParser, so an exact duplicate section header is a
// parse error for every profile, and it maps a section to a profile by
// shlex.split(name), so quoted names alias the managed ones and the later
// section wins. This helper reads the script's output that way.
const pyskip = has('python3') ? false : 'python3 not installed (node:latest ships it)'
const CLI_VIEW = String.raw`
import configparser, json, shlex, sys
cp = configparser.RawConfigParser()
try:
    cp.read(sys.argv[1])
except configparser.Error as e:
    print(json.dumps({"error": type(e).__name__})); sys.exit(0)
out = {"profile": {}, "sso-session": {}}
for name in cp.sections():
    for kind in out:
        if name.startswith(kind):
            try: parts = shlex.split(name)
            except ValueError: continue
            if len(parts) == 2: out[kind][parts[1]] = dict(cp.items(name))
print(json.dumps(out))
`
function cliView(text) {
  const dir = mkdtempSync(join(tmpdir(), 'aws-cli-view-'))
  try {
    const f = join(dir, 'config')
    writeFileSync(f, text)
    const r = spawnSync('python3', ['-c', CLI_VIEW, f], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(r.stdout)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('control: the managed block alone parses, and the CLI resolves the managed values', { skip: pyskip }, () => {
  const v = cliView(BLOCK)
  assert.equal(v.error, undefined)
  assert.equal(v.profile['snyk-sandbox'].sso_account_id, '597564118722')
  assert.equal(v.profile['snyk-sandbox'].sso_session, 'snyk')
  assert.equal(v['sso-session'].snyk.sso_start_url, 'https://identitycenter.amazonaws.com/ssoins-6804c38450c29714')
})

// Invariant behind the README's fail-closed promise: whatever the existing file
// holds, the script either fails closed (non-zero, no output) or prints a file
// the CLI can parse in which snyk-sandbox and sso-session snyk carry the managed
// values. Each case below was also run through the real aws-cli 2.38.1 on the
// work laptop (AWS_CONFIG_FILE on a scratch file): the comment and CRLF outputs
// made every command fail with "Unable to parse config file", and the quoted
// profile made `aws configure get sso_account_id --profile snyk-sandbox` print
// 111111111111.
for (const [name, input] of [
  ['control: a tab inside the header (caught today)', BLOCK + '[profile\tsnyk-sandbox]\nsso_account_id = 111111111111\n'],
  ['a trailing comment on a foreign header', '[profile snyk-sandbox] ; mine\nsso_account_id = 111111111111\n'],
  ['a CRLF foreign file', '[profile snyk-sandbox]\r\nsso_account_id = 111111111111\r\n'],
  ['a quoted profile name after the block', BLOCK + '[profile "snyk-sandbox"]\nsso_account_id = 111111111111\n'],
  ["a single-quoted profile name after the block", BLOCK + "[profile 'snyk-sandbox']\nsso_account_id = 111111111111\n"],
  ['a quoted sso-session name after the block', BLOCK + '[sso-session "snyk"]\nsso_start_url = https://attacker.example/start\n'],
]) {
  test(`a collision the CLI sees never reaches the output: ${name}`, { skip: pyskip }, () => {
    const r = modify(input)
    if (r.status !== 0) {
      assert.equal(r.stdout, '', 'failed, but still printed output')
      return
    }
    const v = cliView(r.stdout)
    assert.equal(v.error, undefined, `script exited 0 but the CLI cannot parse its output (${v.error}):\n${r.stdout}`)
    assert.equal(v.profile['snyk-sandbox']?.sso_account_id, '597564118722', `snyk-sandbox resolves to a foreign section:\n${r.stdout}`)
    assert.equal(v['sso-session'].snyk?.sso_start_url, 'https://identitycenter.amazonaws.com/ssoins-6804c38450c29714', `sso-session snyk resolves to a foreign section:\n${r.stdout}`)
  })
}

// --- Tester additions: every awk family gives the same result -------------------------

// The script says "POSIX sh and awk only"; macOS runs it with BWK awk, the image
// with mawk. Each awk must give mawk's stdout and exit status on every fixture.
const AWK_FIXTURES = [
  '',
  '[default]\nregion = eu-west-1\n\n# c\n[profile other]\n  role_arn = x\t \n',
  '[profile other]\nregion = eu-west-1',
  `[profile a]\nx = 1\n${START}\n[sso-session snyk]\nsso_region = us-east-1\n${END}\n[profile b]\n`,
  '[profile other]\n  [ sso-session   snyk ]  \n',
  `${START}\n[profile x]\n`,
  `[profile x]\n${END}\n`,
  `${START}\n${START}\n${END}\n`,
  'café = ümläut ☃\n',
]
for (const [name, argv] of [['gawk', ['gawk']], ['original-awk', ['original-awk']], ['busybox awk', ['busybox', 'awk']]]) {
  const skip = has(argv[0]) ? false : `${argv[0]} not installed (see the run command at the top)`
  test(`the modify script under ${name} matches mawk on every fixture`, { skip }, () => {
    const shim = mkdtempSync(join(tmpdir(), 'aws-awk-'))
    try {
      const bin = spawnSync('sh', ['-c', `command -v ${argv[0]}`], { encoding: 'utf8' }).stdout.trim()
      if (argv.length === 1) symlinkSync(bin, join(shim, 'awk'))
      else writeFileSync(join(shim, 'awk'), `#!/bin/sh\nexec ${bin} ${argv.slice(1).join(' ')} "$@"\n`, { mode: 0o755 })
      const env = { ...process.env, PATH: `${shim}:${process.env.PATH}` }
      const used = spawnSync('sh', ['-c', 'command -v awk'], { env, encoding: 'utf8' }).stdout.trim()
      assert.equal(used, join(shim, 'awk'))
      for (const input of AWK_FIXTURES) {
        const want = modify(input)
        const got = spawnSync('sh', [MODIFY], { input, encoding: 'utf8', env })
        assert.equal(got.status === 0, want.status === 0, `status differs for ${JSON.stringify(input)}: ${got.stderr}`)
        assert.equal(got.stdout, want.stdout, `stdout differs for ${JSON.stringify(input)}`)
      }
    } finally {
      rmSync(shim, { recursive: true, force: true })
    }
  })
}

// --- Tester additions: the aws function -------------------------------------------------

test('the session check never leaks export-credentials output (it prints keys)', { skip: cskip || zskip }, () => {
  const r = withFn('aws s3 ls', { STUB_EXPORT_OUT: '1' })
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(r.stdout + r.stderr, /STUB-SECRET/)
  assert.equal(r.stdout, 'ran: [--profile] [snyk-sandbox] [s3] [ls]\n')
})

test("the command's exit status is the function's exit status", { skip: cskip || zskip }, () => {
  assert.equal(withFn('aws s3 ls', { STUB_RC: '254' }).status, 254)
  assert.equal(withFn('aws s3 ls', { STUB_RC: '254', STUB_EXPORT: 'fail' }).status, 254)
  assert.equal(withFn('aws --profile other s3 ls', { STUB_RC: '3' }).status, 3)
})

test('empty, glob, and unicode arguments reach the binary intact', { skip: cskip || zskip }, () => {
  const r = withFn(`aws s3 cp "" 's3://b/*' 'café ☃.txt'`)
  assert.equal(r.stdout, `ran: [--profile] [snyk-sandbox] [s3] [cp] [] [s3://b/*] [café ☃.txt]\n`)
})

test('an empty or dangling --profile injects nothing and runs no check; the CLI reports it', { skip: cskip || zskip }, () => {
  assert.deepEqual(withFn('aws s3 ls --profile').calls, ['s3 ls --profile'])
  assert.deepEqual(withFn('aws s3 ls --profile=').calls, ['s3 ls --profile='])
})

// A global option before the subcommand hides `sso` from the first-word
// exemption. Logging out must never open a browser login first, and one
// `sso login` must not run two.
test('`aws --debug sso logout` with an expired session runs no sso login', { skip: cskip || zskip }, () => {
  const r = withFn('aws --debug sso logout', { STUB_EXPORT: 'fail' })
  assert.ok(!r.calls.some((c) => c.startsWith('sso login')), `a logout started a browser login:\n${r.calls.join('\n')}`)
})

test('`aws --region us-west-2 sso login` with an expired session runs one login, not two', { skip: cskip || zskip }, () => {
  const r = withFn('aws --region us-west-2 sso login', { STUB_EXPORT: 'fail' })
  const logins = r.calls.filter((c) => /(^| )sso login( |$)/.test(c))
  assert.equal(logins.length, 1, r.calls.join('\n'))
})

// The real CLI also selects a profile from AWS_DEFAULT_PROFILE (checked with
// aws-cli 2.38.1: AWS_DEFAULT_PROFILE=other `aws configure get region` printed
// other's region). The README lists only AWS_PROFILE, so this is a proposal.
test('AWS_DEFAULT_PROFILE is honored like AWS_PROFILE, and AWS_PROFILE wins over it', { skip: cskip || zskip }, () => {
  assert.deepEqual(withFn('aws s3 ls', { AWS_DEFAULT_PROFILE: 'other' }).calls, ['s3 ls'])
  assert.deepEqual(withFn('aws s3 ls', { AWS_DEFAULT_PROFILE: 'snyk-sandbox' }).calls, [CHECK, 's3 ls'])
  assert.deepEqual(withFn('aws s3 ls', { AWS_PROFILE: 'other', AWS_DEFAULT_PROFILE: 'snyk-sandbox' }).calls, ['s3 ls'])
})

test('exported keys win even with AWS_PROFILE=snyk-sandbox: no check, no login', { skip: cskip || zskip }, () => {
  const r = withFn('aws s3 ls', { AWS_PROFILE: 'snyk-sandbox', AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', STUB_EXPORT: 'fail' })
  assert.deepEqual(r.calls, ['s3 ls'])
})

test('a key that is set but not exported does not stop the injection', { skip: cskip || zskip }, () => {
  const r = withFn('AWS_ACCESS_KEY_ID=AKIAEXAMPLE; aws s3 ls')
  assert.deepEqual(r.calls, [CHECK, '--profile snyk-sandbox s3 ls'])
})

for (const cmd of ['aws --region us-west-2 configure list', 'aws --output=json help', 'aws --debug --version', 'aws --region x --help']) {
  test(`\`${cmd}\` runs no check and no injection`, { skip: cskip || zskip }, () => {
    assert.deepEqual(withFn(cmd, { STUB_EXPORT: 'fail' }).calls, [cmd.slice(4)])
  })
}

test('an option value that looks like a command does not hide the real command', { skip: cskip || zskip }, () => {
  assert.deepEqual(withFn('aws --query sso s3 ls').calls, [CHECK, '--profile snyk-sandbox --query sso s3 ls'])
})
