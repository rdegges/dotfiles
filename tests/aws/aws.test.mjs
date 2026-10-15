// private_dot_aws/private_snyk-sandbox.config (the chezmoi-owned
// ~/.aws/snyk-sandbox.config) and the work-only `aws` zsh function in
// dot_oh-my-zsh/custom/aliases.zsh.tmpl.
//
// Run from the repo root (zsh is needed for the function tests, chezmoi for
// the render and deploy tests; without them those tests skip):
//   docker run --rm -v "$PWD":/w -w /w node:latest sh -c \
//     'apt-get update -qq && apt-get install -y -qq zsh >/dev/null &&
//      sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin &&
//      node --test tests/aws/'
//
// What a pass proves: through the real source tree, chezmoi writes
// ~/.aws/snyk-sandbox.config byte for byte (0600 in a 0700 ~/.aws) only on work
// machines, manages nothing else under ~/.aws, never touches ~/.aws/config or
// ~/.aws/credentials whatever they hold, and changes nothing on a second apply.
// The rendered `aws` function, against a stub binary that records each call's
// argv and its AWS_CONFIG_FILE / AWS_SHARED_CREDENTIALS_FILE: every snyk-sandbox
// call (session check, login, command) reads only ~/.aws/snyk-sandbox.config
// with the credentials file cut off, and no other call sees either override;
// it injects the default profile only when no --profile and no exported
// AWS_PROFILE, AWS_DEFAULT_PROFILE, or AWS_ACCESS_KEY_ID is set; sso,
// configure, help, login, logout, --version, and --help skip the session check,
// and with no profile chosen they keep the CLI's own default; a trailing help
// skips the check but keeps the profile; it logs in on stderr only when the
// check fails, with --use-device-code over SSH, and runs nothing after a failed
// login. It says nothing about the real AWS CLI or Identity Center; live
// sign-in and the poisoned ~/.aws/config and credentials cases are checked by
// hand on the work laptop before merge.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, statSync, existsSync, chmodSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('../../', import.meta.url)
const SRC = 'private_dot_aws/private_snyk-sandbox.config'
const ALIASES = new URL('dot_oh-my-zsh/custom/aliases.zsh.tmpl', ROOT).pathname
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8')

const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0
const cskip = has('chezmoi') ? false : 'chezmoi not installed (see the run command at the top)'
const zskip = has('zsh') ? false : 'zsh not installed (see the run command at the top)'
const fskip = cskip || zskip

// --- The managed file ----------------------------------------------------------------

test('the managed file defines exactly sso-session snyk and profile snyk-sandbox', () => {
  const headers = read(SRC).split('\n').filter((l) => l.startsWith('['))
  assert.deepEqual(headers, ['[sso-session snyk]', '[profile snyk-sandbox]'])
  assert.match(read(SRC), /^sso_start_url = https:\/\/identitycenter\.amazonaws\.com\/ssoins-6804c38450c29714$/m)
  assert.match(read(SRC), /^sso_account_id = 597564118722$/m)
  assert.match(read(SRC), /^sso_role_name = AWSPowerUserAccess$/m)
  assert.match(read(SRC), /^region = us-west-2$/m)
})

// --- chezmoi deploys it ----------------------------------------------------------------

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

test('[work=true] chezmoi writes ~/.aws/snyk-sandbox.config byte for byte, 0600 in a 0700 ~/.aws', { skip: cskip }, () =>
  withDeploy(true, ({ home, cz }) => {
    const r = cz('apply', '--force', join(home, '.aws'))
    assert.equal(r.status, 0, r.stderr)
    const dst = join(home, '.aws', 'snyk-sandbox.config')
    assert.equal(readFileSync(dst, 'utf8'), read(SRC))
    assert.equal(statSync(dst).mode & 0o777, 0o600)
    assert.equal(statSync(join(home, '.aws')).mode & 0o777, 0o700)
    assert.equal(existsSync(join(home, '.aws', 'config')), false, 'chezmoi created ~/.aws/config')
  }))

test('[work=true] chezmoi manages only ~/.aws/snyk-sandbox.config under ~/.aws', { skip: cskip }, () =>
  withDeploy(true, ({ cz }) => {
    const r = cz('managed', '--path-style', 'relative', '--include', 'files,dirs')
    assert.equal(r.status, 0, r.stderr)
    const aws = r.stdout.split('\n').filter((l) => l === '.aws' || l.startsWith('.aws/'))
    assert.deepEqual(aws.sort(), ['.aws', '.aws/snyk-sandbox.config'])
  }))

// The contents that broke the old shared-file design: a duplicate managed
// section, a [DEFAULT] that hands role_arn to every profile, an indented header,
// CRLF, and a credentials-file section for snyk-sandbox. None of them may stop
// the apply, and none may be changed.
test('[work=true] ~/.aws/config and ~/.aws/credentials are never touched, whatever they hold, and a second apply changes nothing', { skip: cskip }, () =>
  withDeploy(true, ({ home, cz }) => {
    const dir = join(home, '.aws')
    mkdirSync(dir, { mode: 0o755 })
    const config =
      '[DEFAULT]\r\nrole_arn = arn:aws:iam::111111111111:role/x\r\n' +
      '[sso-session snyk]\nsso_region = us-east-1\n  [profile snyk-sandbox]\nsso_account_id = 111111111111\n'
    const creds = '[snyk-sandbox]\nrole_arn = arn:aws:iam::111111111111:role/x\n'
    writeFileSync(join(dir, 'config'), config, { mode: 0o644 })
    writeFileSync(join(dir, 'credentials'), creds, { mode: 0o600 })
    let r = cz('apply', '--force', dir)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readFileSync(join(dir, 'config'), 'utf8'), config)
    assert.equal(statSync(join(dir, 'config')).mode & 0o777, 0o644)
    assert.equal(readFileSync(join(dir, 'credentials'), 'utf8'), creds)
    assert.equal(readFileSync(join(dir, 'snyk-sandbox.config'), 'utf8'), read(SRC))
    r = cz('diff', dir)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, '')
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
    assert.equal(existsSync(join(dir, 'snyk-sandbox.config')), false)
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

test('[work=true] the aliases file parses (zsh -n)', { skip: fskip }, () => {
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

// Runs `cmd` in zsh with the rendered aliases sourced and a stub `aws` first on
// PATH. The stub logs each call's argv to `calls`, and the AWS_CONFIG_FILE and
// AWS_SHARED_CREDENTIALS_FILE it saw to `envs` ("-" when unset, with $HOME
// written as ~). STUB_EXPORT=fail makes `configure export-credentials` fail
// (expired session); STUB_LOGIN=fail makes `sso login` fail. STUB_EXPORT_OUT=1
// makes the check print a fake secret, as the real export-credentials prints
// keys. STUB_RC sets the exit code of the final command.
function withFn(cmd, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aws-fn-'))
  try {
    const aliases = join(dir, 'aliases.zsh')
    writeFileSync(aliases, render(true))
    const log = join(dir, 'calls')
    const envlog = join(dir, 'envs')
    const stub = join(dir, 'aws')
    writeFileSync(stub, `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
printf '%s|%s\\n' "\${AWS_CONFIG_FILE--}" "\${AWS_SHARED_CREDENTIALS_FILE--}" | sed "s|^$HOME/|~/|" >> "${envlog}"
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
    const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n') : [])
    return { ...r, calls: lines(log), envs: lines(envlog) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const CHECK = 'configure export-credentials --profile snyk-sandbox'
const SANDBOX = '~/.aws/snyk-sandbox.config|/dev/null'
const PLAIN = '-|-'

// --- Default profile and the session --------------------------------------------------

test('no profile set: checks the session, then injects --profile snyk-sandbox', { skip: fskip }, () => {
  const r = withFn('aws s3 ls')
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.calls, [CHECK, '--profile snyk-sandbox s3 ls'])
})

test('every snyk-sandbox call reads only the managed file, with the credentials file cut off', { skip: fskip }, () => {
  const r = withFn('aws s3 ls', { STUB_EXPORT: 'fail' })
  assert.deepEqual(r.calls, [CHECK, 'sso login --profile snyk-sandbox', '--profile snyk-sandbox s3 ls'])
  assert.deepEqual(r.envs, [SANDBOX, SANDBOX, SANDBOX])
})

test('the managed file wins over an AWS_CONFIG_FILE the user exported, for snyk-sandbox calls only', { skip: fskip }, () => {
  const env = { AWS_CONFIG_FILE: '/elsewhere/config', AWS_SHARED_CREDENTIALS_FILE: '/elsewhere/creds' }
  assert.deepEqual(withFn('aws s3 ls', env).envs, [SANDBOX, SANDBOX])
  assert.deepEqual(withFn('aws --profile other s3 ls', env).envs, ['/elsewhere/config|/elsewhere/creds'])
})

test('the overrides do not leak into the shell after the call', { skip: fskip }, () => {
  const r = withFn('aws s3 ls >/dev/null; print -r -- "after:${AWS_CONFIG_FILE-unset}:${AWS_SHARED_CREDENTIALS_FILE-unset}"')
  assert.match(r.stdout, /^after:unset:unset$/m)
})

test('a valid session never runs sso login', { skip: fskip }, () => {
  const r = withFn('aws sts get-caller-identity')
  assert.ok(!r.calls.some((c) => c.startsWith('sso login')), r.calls.join('\n'))
})

test('an expired session logs in on stderr, then runs the command with clean stdout', { skip: fskip }, () => {
  const r = withFn('aws sts get-caller-identity', { STUB_EXPORT: 'fail' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, 'ran: [--profile] [snyk-sandbox] [sts] [get-caller-identity]\n')
  assert.match(r.stderr, /login-output/)
})

test('over SSH the login uses the device-code flow', { skip: fskip }, () => {
  const r = withFn('aws s3 ls', { STUB_EXPORT: 'fail', SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' })
  assert.ok(r.calls.includes('sso login --profile snyk-sandbox --use-device-code'), r.calls.join('\n'))
})

test('a failed login returns non-zero and runs no command', { skip: fskip }, () => {
  const r = withFn('aws s3 ls', { STUB_EXPORT: 'fail', STUB_LOGIN: 'fail' })
  assert.notEqual(r.status, 0)
  assert.deepEqual(r.calls, [CHECK, 'sso login --profile snyk-sandbox'])
})

test('the session check never leaks export-credentials output (it prints keys)', { skip: fskip }, () => {
  const r = withFn('aws s3 ls', { STUB_EXPORT_OUT: '1' })
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(r.stdout + r.stderr, /STUB-SECRET/)
  assert.equal(r.stdout, 'ran: [--profile] [snyk-sandbox] [s3] [ls]\n')
})

test("the command's exit status is the function's exit status", { skip: fskip }, () => {
  assert.equal(withFn('aws s3 ls', { STUB_RC: '254' }).status, 254)
  assert.equal(withFn('aws s3 ls', { STUB_RC: '254', STUB_EXPORT: 'fail' }).status, 254)
  assert.equal(withFn('aws --profile other s3 ls', { STUB_RC: '3' }).status, 3)
})

test('empty, glob, spaced, and unicode arguments reach the binary intact', { skip: fskip }, () => {
  const r = withFn(`aws s3 cp "" 's3://b/*' "a b.txt" 'café ☃.txt'`)
  assert.equal(r.stdout, `ran: [--profile] [snyk-sandbox] [s3] [cp] [] [s3://b/*] [a b.txt] [café ☃.txt]\n`)
})

test('under zsh -o nounset with no AWS variables set, the command runs', { skip: fskip }, () => {
  const r = withFn('setopt nounset; aws s3 ls')
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.calls, [CHECK, '--profile snyk-sandbox s3 ls'])
})

// --- Choosing another profile ------------------------------------------------------------

for (const [name, cmd] of [['--profile X', 'aws --profile other s3 ls'], ['--profile=X', 'aws s3 ls --profile=other']]) {
  test(`${name} passes straight through: no check, no injection, no override`, { skip: fskip }, () => {
    const r = withFn(cmd)
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(r.calls, [cmd.slice(4)])
    assert.deepEqual(r.envs, [PLAIN])
  })
}

test('--profile snyk-sandbox is checked, overridden, and not injected twice', { skip: fskip }, () => {
  const r = withFn('aws --profile snyk-sandbox s3 ls')
  assert.deepEqual(r.calls, [CHECK, '--profile snyk-sandbox s3 ls'])
  assert.deepEqual(r.envs, [SANDBOX, SANDBOX])
})

test('an empty or dangling --profile injects nothing and runs no check; the CLI reports it', { skip: fskip }, () => {
  assert.deepEqual(withFn('aws s3 ls --profile').calls, ['s3 ls --profile'])
  assert.deepEqual(withFn('aws s3 ls --profile=').calls, ['s3 ls --profile='])
})

test('a profile named like a command is a profile, not a command', { skip: fskip }, () => {
  assert.deepEqual(withFn('aws --profile sso s3 ls', { STUB_EXPORT: 'fail' }).calls, ['--profile sso s3 ls'])
})

test('an exported AWS_PROFILE is honored with no injection; snyk-sandbox there is checked and overridden', { skip: fskip }, () => {
  assert.deepEqual(withFn('aws s3 ls', { AWS_PROFILE: 'other' }).calls, ['s3 ls'])
  const r = withFn('aws s3 ls', { AWS_PROFILE: 'snyk-sandbox' })
  assert.deepEqual(r.calls, [CHECK, 's3 ls'])
  assert.deepEqual(r.envs, [SANDBOX, SANDBOX])
})

test('AWS_DEFAULT_PROFILE is honored like AWS_PROFILE, and AWS_PROFILE wins over it', { skip: fskip }, () => {
  assert.deepEqual(withFn('aws s3 ls', { AWS_DEFAULT_PROFILE: 'other' }).calls, ['s3 ls'])
  assert.deepEqual(withFn('aws s3 ls', { AWS_DEFAULT_PROFILE: 'snyk-sandbox' }).calls, [CHECK, 's3 ls'])
  assert.deepEqual(withFn('aws s3 ls', { AWS_PROFILE: 'other', AWS_DEFAULT_PROFILE: 'snyk-sandbox' }).calls, ['s3 ls'])
})

test('an unexported AWS_PROFILE or AWS_DEFAULT_PROFILE does not count: the default is injected', { skip: fskip }, () => {
  for (const pre of ['AWS_PROFILE=other', 'AWS_PROFILE=snyk-sandbox', 'AWS_DEFAULT_PROFILE=other']) {
    assert.deepEqual(withFn(`${pre}; aws s3 ls`).calls, [CHECK, '--profile snyk-sandbox s3 ls'], pre)
  }
})

test('exported keys pass straight through, even with AWS_PROFILE=snyk-sandbox', { skip: fskip }, () => {
  const r = withFn('aws s3 ls', { AWS_PROFILE: 'snyk-sandbox', AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', STUB_EXPORT: 'fail' })
  assert.deepEqual(r.calls, ['s3 ls'])
  assert.deepEqual(r.envs, [PLAIN])
})

test('a key that is set but not exported does not stop the injection', { skip: fskip }, () => {
  assert.deepEqual(withFn('AWS_ACCESS_KEY_ID=AKIAEXAMPLE; aws s3 ls').calls, [CHECK, '--profile snyk-sandbox s3 ls'])
})

// --- Commands that need no session -----------------------------------------------------

// With no profile chosen they keep the CLI's own default (~/.aws/config).
for (const cmd of [
  'aws', 'aws sso login', 'aws sso logout', 'aws configure list', 'aws help', 'aws --version', 'aws --help',
  'aws login', 'aws logout', 'aws --debug sso logout', 'aws --region us-west-2 configure list',
  'aws --output=json help', 'aws --debug --version', 'aws --region x --help', 'aws --cli-error-format json sso logout',
  'aws --cli-error-format=json sso logout', 'aws --region=us-west-2 sso login',
  'aws --endpoint-url http://localhost:4566 configure list',
]) {
  test(`\`${cmd}\` with no profile chosen runs no check, no login, no injection, no override`, { skip: fskip }, () => {
    const r = withFn(cmd, { STUB_EXPORT: 'fail' })
    assert.deepEqual(r.calls, [cmd.slice(4)])
    assert.deepEqual(r.envs, [PLAIN])
  })
}

test('`aws sso login --profile snyk-sandbox` logs in once, against the managed file', { skip: fskip }, () => {
  const r = withFn('aws sso login --profile snyk-sandbox', { STUB_EXPORT: 'fail' })
  assert.deepEqual(r.calls, ['sso login --profile snyk-sandbox'])
  assert.deepEqual(r.envs, [SANDBOX])
})

test('`aws --region us-west-2 sso login` with an expired session runs one login, not two', { skip: fskip }, () => {
  const r = withFn('aws --region us-west-2 sso login', { STUB_EXPORT: 'fail' })
  assert.equal(r.calls.filter((c) => /(^| )sso login( |$)/.test(c)).length, 1, r.calls.join('\n'))
})

test('an option value that looks like a command does not hide the real command', { skip: fskip }, () => {
  assert.deepEqual(withFn('aws --query sso s3 ls').calls, [CHECK, '--profile snyk-sandbox --query sso s3 ls'])
})

// A trailing `help` shows a man page (aws s3 help), but some API calls end in a
// `help` value too (aws s3 cp s3://b/k help, aws ssm get-parameter --name help).
// So it skips only the session check: the profile and the override stay.
for (const cmd of ['aws s3 help', 'aws s3 ls help', 'aws s3 cp s3://bucket/key help', 'aws ssm get-parameter --name help']) {
  test(`\`${cmd}\` skips the session check but still runs on snyk-sandbox`, { skip: fskip }, () => {
    const r = withFn(cmd, { STUB_EXPORT: 'fail' })
    assert.deepEqual(r.calls, [`--profile snyk-sandbox ${cmd.slice(4)}`])
    assert.deepEqual(r.envs, [SANDBOX])
  })
}

// --no-sign-request sends unsigned requests (public buckets), so it needs no
// session; today an expired session opens a browser login first. Out of scope.
test('PROPOSED CONTRACT: `aws --no-sign-request s3 ls s3://public` with an expired session runs no sso login', { skip: fskip, todo: true }, () => {
  const r = withFn('aws --no-sign-request s3 ls s3://public', { STUB_EXPORT: 'fail' })
  assert.ok(!r.calls.some((c) => c.startsWith('sso login')), r.calls.join('\n'))
})
