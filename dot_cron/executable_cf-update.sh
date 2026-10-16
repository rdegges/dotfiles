#!/bin/sh
# Install or update the Cloudflare CLI (`cf`) as an npm global on the asdf Node.
#
# Cloudflare ships cf only through npm, so there is no Homebrew formula to ride
# on. npm globals live inside one asdf Node version: a Node pin bump drops cf,
# which is why chezmoi also runs this when ~/.tool-versions changes
# (run_onchange_after_install-cloudflare-cli.sh.tmpl). Cron runs it daily.
#
# A failure writes ~/.cron/logs/cf.FAILED, and every new shell prints it
# (dot_zshrc) until a later run succeeds: cron output only lands in a log
# nobody reads. Not a macOS notification: from cron, `launchctl asuser` needs
# root and plain osascript exits 0 but shows nothing.
#
# CF_UPDATE_PACKAGE overrides the npm spec, which lets a test force a failure.

set -u

pkg="${CF_UPDATE_PACKAGE:-cf@latest}"
marker="$HOME/.cron/logs/cf.FAILED"
stamp="$HOME/.cron/logs/cf.ok"

fail() {
    echo "cf-update: FAILED: $1"
    mkdir -p "${marker%/*}"
    echo "$(date '+%F %R') cf update failed: $1 (see ~/.cron/logs/cf.log)" > "$marker"
    exit 1
}

# launchd runs a job the Mac slept through as soon as the Mac wakes, often
# before the network is back. Skip that run quietly (see wait-for-network.sh),
# but write the marker when no run has succeeded in 72 hours. Any status but
# 1 (helper missing, or it cannot check) runs the job as before.
"${WAIT_FOR_NETWORK:-$HOME/.cron/wait-for-network.sh}"
if [ $? -eq 1 ]; then
    echo "cf-update: network not up; skipped"
    if [ ! -e "$marker" ] && [ -z "$(find "$stamp" -mmin -4320 2>/dev/null)" ]; then
        mkdir -p "${marker%/*}"
        echo "$(date '+%F %R') cf: network check failed and no successful run in 72 hours (see ~/.cron/logs/cf.log)" > "$marker"
    fi
    exit 0
fi

command -v npm >/dev/null 2>&1 || fail "npm not found on PATH"

npm install --global "$pkg" || fail "npm install --global $pkg"
command -v asdf >/dev/null 2>&1 && asdf reshim nodejs
version=$(cf --version 2>&1) || fail "cf --version: $version"
rm -f "$marker"
mkdir -p "${marker%/*}"
touch "$stamp"
echo "cf-update: ok: $version"
