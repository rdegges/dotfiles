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

# One line of printable ASCII, at most 300 characters, for the marker. The
# reason can carry CLI output (`cf --version`), which can have many lines,
# color codes, or bytes that are not ASCII; the same steps as oneline() in
# tailscale-watchdog.sh. Text that carries CLI output is written with
# printf '%s\n', never echo: dash and macOS /bin/sh expand backslash escapes in
# echo, so a \c in it cut the marker short.
esc=$(printf '\033')
oneline() { printf '%s' "$1" | tr '\n\t\r' '   ' | LC_ALL=C sed "s/$esc\[[0-9;?]*[A-Za-z]//g" | LC_ALL=C tr -cd '\40-\176' | cut -c1-300; }

fail() {
    printf '%s\n' "cf-update: FAILED: $1"
    mkdir -p "${marker%/*}"
    printf '%s\n' "$(date '+%F %R') cf update failed: $(oneline "$1") (see ~/.cron/logs/cf.log)" > "$marker"
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
printf '%s\n' "cf-update: ok: $version"
