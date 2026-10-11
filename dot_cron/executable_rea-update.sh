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
# write) catches a release that changes the entry's shape.
#
# A failure writes ~/.cron/logs/rea.FAILED, and every new shell prints it
# (dot_zshrc) until a later run succeeds.
#
# REA_UPDATE_PACKAGE overrides the npm spec, which lets a test force a failure.

set -u

pkg="${REA_UPDATE_PACKAGE:-rea-agents@latest}"
marker="$HOME/.cron/logs/rea.FAILED"

fail() {
    echo "rea-update: FAILED: $1"
    mkdir -p "${marker%/*}"
    echo "$(date '+%F %R') rea update failed: $1 (see ~/.cron/logs/rea.log)" > "$marker"
    exit 1
}

command -v npm >/dev/null 2>&1 || fail "npm not found on PATH"

npm install --global "$pkg" || fail "npm install --global $pkg"
command -v asdf >/dev/null 2>&1 && asdf reshim nodejs
version=$(rea --version 2>&1) || fail "rea --version: $version"
rea setup --client claude_code --client opencode --yes --json > /dev/null < /dev/null \
    || fail "rea setup --client claude_code --client opencode"
rea doctor --client codex --json > /dev/null \
    || fail "rea doctor --client codex: dot_codex/config.toml.tmpl no longer matches this release"
rm -f "$marker"
echo "rea-update: ok: $version"
