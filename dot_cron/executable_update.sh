#!/bin/sh
# The daily software update for this Mac: one launchd job (com.rdegges.update),
# one log (~/.cron/logs/update.log), one marker.
#
# It replaces eight jobs (brew, brew-cleanup, asdf, pipx, oh-my-zsh, codex, cf,
# rea) that each had a schedule and a log, and most of which failed without a
# signal. Every step runs, also after an earlier step fails. A step whose tool
# is not installed is skipped.
#
# A failed step writes ~/.cron/logs/update.FAILED with the names of the failed
# steps, and every new shell prints it (dot_zshrc) until a later pass has no
# failure. cf-update.sh and rea-update.sh keep their own logs and markers
# (chezmoi also runs them on a Node bump), so their status does not count here.
#
# Every tool comes from PATH, which lets a test stub each one.

set -u

logs="$HOME/.cron/logs"
marker="$logs/update.FAILED"
stamp="$logs/update.ok"
mkdir -p "$logs"

# launchd runs a job the Mac slept through as soon as the Mac wakes, often
# before the network is back. Skip that run quietly (see wait-for-network.sh),
# but write the marker when no pass has succeeded in 72 hours. Any status but
# 1 (helper missing, or it cannot check) runs the pass as before.
"${WAIT_FOR_NETWORK:-$HOME/.cron/wait-for-network.sh}"
if [ $? -eq 1 ]; then
    printf '%s\n' "update: network not up; skipped"
    if [ ! -e "$marker" ] && [ -z "$(find "$stamp" -mmin -4320 2>/dev/null)" ]; then
        printf '%s\n' "$(date '+%F %R') update: network check failed and no successful run in 72 hours (see ~/.cron/logs/update.log)" > "$marker"
    fi
    exit 0
fi

failed=
have() { command -v "$1" >/dev/null 2>&1; }

# step <name> <command...>: run one updater with no stdin, so nothing can wait
# for an answer. A failure is recorded and the pass goes on.
step() {
    name=$1
    shift
    printf '%s\n' "== $name"
    "$@" < /dev/null
    rc=$?
    if [ "$rc" -ne 0 ]; then
        printf '%s\n' "update: $name FAILED: exit $rc"
        failed="$failed $name"
    fi
}

brew_all() {
    # Plain `brew upgrade` covers formulae and casks. No --greedy: it downloads
    # apps again that update themselves. --no-quit never closes an app in use.
    brew update --quiet && brew upgrade --quiet --no-quit && brew cleanup --prune=30 --quiet
}

have brew && step brew brew_all
# Mac App Store apps.
have mas && step mas mas upgrade
# Plugin repos only: the installed versions stay pinned by ~/.tool-versions,
# and tool-versions-bump.sh (below) proposes new pins.
have asdf && step asdf asdf plugin update --all
have pipx && step pipx pipx upgrade-all
[ -d "$HOME/.oh-my-zsh/.git" ] && step oh-my-zsh git -C "$HOME/.oh-my-zsh" pull -q
# The explicit path, so an asdf shim or an old Homebrew install cannot answer.
[ -x "$HOME/.local/bin/codex" ] && step codex "$HOME/.local/bin/codex" update

for job in cf rea; do
    if [ -x "$HOME/.cron/$job-update.sh" ]; then
        printf '%s\n' "== $job (log: ~/.cron/logs/$job.log)"
        { date; "$HOME/.cron/$job-update.sh"; } > "$logs/$job.log" 2>&1 < /dev/null
    fi
done

# Personal Macs only (.chezmoiignore).
[ -x "$HOME/.cron/tool-versions-bump.sh" ] && step tool-versions "$HOME/.cron/tool-versions-bump.sh"

if [ -n "$failed" ]; then
    printf '%s\n' "update: FAILED:$failed"
    printf '%s\n' "$(date '+%F %R') update failed:$failed (see ~/.cron/logs/update.log)" > "$marker"
    exit 1
fi

rm -f "$marker"
touch "$stamp"
printf '%s\n' "update: ok"
