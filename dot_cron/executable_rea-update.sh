#!/bin/sh
# Install or update REA (https://rea.tools, npm package rea-agents) as an npm
# global on the asdf Node, then refresh its agent registrations and skill.
#
# REA ships only through npm. npm globals live inside one asdf Node version: a
# Node pin bump drops rea, which is why chezmoi also runs this when
# ~/.tool-versions changes (run_onchange_after_install-rea.sh.tmpl). Cron runs
# it daily.
#
# `rea setup` run from a global install registers the global bin path, unpinned,
# so the update alone moves every agent to the new server. Setup is still run
# each time: it installs the skill that matches the new version, and it adds the
# registrations on a fresh machine. It touches only files chezmoi does not own
# (~/.claude.json, ~/.config/opencode/opencode.json, the skill dirs) and writes
# nothing when they already match. Codex is not passed: chezmoi owns
# ~/.codex/config.toml, so its registration lives in dot_codex/config.toml.tmpl,
# and `rea doctor` (exit 0 only when the entry matches what this release would
# write) catches a release that changes the entry's shape. Codex gets the
# reverse-engineer-anything skill from ~/.agents/skills, which the --client
# opencode step writes; dropping opencode from setup drops the skill for Codex too.
#
# A failure writes ~/.cron/logs/rea.FAILED, and every new shell prints it
# (dot_zshrc) until a later run succeeds.
#
# REA_UPDATE_PACKAGE overrides the npm spec, which lets a test force a failure.

set -u

pkg="${REA_UPDATE_PACKAGE:-rea-agents@latest}"
marker="$HOME/.cron/logs/rea.FAILED"
stamp="$HOME/.cron/logs/rea.ok"

# oneline (lib/text.sh) turns CLI output into one marker line. A missing,
# broken, or incomplete lib writes the marker and exits 1.
lib="$(dirname "$0")/lib/text.sh"
if [ -r "$lib" ] && sh -n "$lib" 2>/dev/null && command . "$lib" && command -v oneline >/dev/null 2>&1; then :; else
    printf '%s\n' "rea-update: cannot load $lib"
    mkdir -p "${marker%/*}"
    printf '%s\n' "$(date '+%F %R') rea-update: cannot load ~/.cron/lib/text.sh; run chezmoi apply" > "$marker"
    exit 1
fi

fail() {
    printf '%s\n' "rea-update: FAILED: $1"
    mkdir -p "${marker%/*}"
    printf '%s\n' "$(date '+%F %R') rea update failed: $(oneline "$1") (see ~/.cron/logs/rea.log)" > "$marker"
    exit 1
}

# launchd runs a job the Mac slept through as soon as the Mac wakes, often
# before the network is back. Skip that run quietly (see wait-for-network.sh),
# but write the marker when no run has succeeded in 72 hours. Any status but
# 1 (helper missing, or it cannot check) runs the job as before.
"${WAIT_FOR_NETWORK:-$HOME/.cron/wait-for-network.sh}"
if [ $? -eq 1 ]; then
    printf '%s\n' "rea-update: network not up; skipped"
    if [ ! -e "$marker" ] && [ -z "$(find "$stamp" -mmin -4320 2>/dev/null)" ]; then
        mkdir -p "${marker%/*}"
        printf '%s\n' "$(date '+%F %R') rea: network check failed and no successful run in 72 hours (see ~/.cron/logs/rea.log)" > "$marker"
    fi
    exit 0
fi

command -v npm >/dev/null 2>&1 || fail "npm not found on PATH"

npm install --global "$pkg" || fail "npm install --global $pkg"
command -v asdf >/dev/null 2>&1 && asdf reshim nodejs
version=$(rea --version 2>&1) || fail "rea --version: $version"
# A Node pin bump moves the npm globals to a new asdf install directory. The
# registrations still name the old directory, and `rea setup` leaves an entry
# alone when it does not point at the running install ("foreign"), then exits 1.
# So remove a rea entry first, but only one that points into another asdf Node
# install; setup writes it again below. Any other entry is not ours to judge and
# still fails setup. ~/.claude.json goes through `claude mcp remove`, because a
# running Claude Code session rewrites that file. REA_NODE_PREFIX lets a test
# name the current install.
if command -v node >/dev/null 2>&1; then
    REA_NODE_PREFIX="${REA_NODE_PREFIX:-}" node - <<'JS' || printf '%s\n' "rea-update: could not check for registrations left by an older Node"
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process')
const home = process.env.HOME
const prefix = (process.env.REA_NODE_PREFIX || path.resolve(process.execPath, '../..')) + '/'
const root = home + '/.asdf/installs/nodejs/'
const stale = (words) => {
  const ours = (Array.isArray(words) ? words : []).filter((w) => typeof w === 'string' && w.startsWith(root))
  return ours.length > 0 && ours.every((w) => !w.startsWith(prefix))
}
const load = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

const claude = load(home + '/.claude.json')?.mcpServers?.rea
if (claude && stale([claude.command, ...(claude.args || [])])) {
  execFileSync('claude', ['mcp', 'remove', 'rea', '-s', 'user'], { stdio: 'inherit' })
  console.log('rea-update: removed the Claude Code registration left by an older Node')
}

const file = home + '/.config/opencode/opencode.json'
const open = load(file)
let changed = false
for (const holder of [open?.mcp, open?.mcp?.servers]) {
  if (holder?.rea && stale(holder.rea.command)) { delete holder.rea; changed = true }
}
if (changed) {
  fs.writeFileSync(file + '.rea-tmp', JSON.stringify(open, null, 2) + '\n')
  fs.renameSync(file + '.rea-tmp', file)
  console.log('rea-update: removed the OpenCode registration left by an older Node')
}
JS
fi
rea setup --client claude_code --client opencode --yes --json < /dev/null \
    || fail "rea setup --client claude_code --client opencode"
rea doctor --client codex --json \
    || fail "rea doctor --client codex (see its JSON in this log; a registration:codex failure means dot_codex/config.toml.tmpl needs the entry this release writes)"
rm -f "$marker"
mkdir -p "${marker%/*}"
touch "$stamp"
printf '%s\n' "rea-update: ok: $version"
