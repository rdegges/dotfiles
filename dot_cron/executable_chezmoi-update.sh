#!/bin/sh
# Pull and apply the dotfiles (`chezmoi update --force`) for the hourly cron job.
#
# A failed apply used to go unnoticed: chezmoi stops at the first failed run_
# script, so every later script is skipped too, and cron output only lands in a
# log nobody reads. Now a failure writes ~/.cron/logs/chezmoi.FAILED, and every
# new shell prints it (dot_zshrc) until a later run succeeds.
#
# CHEZMOI overrides the chezmoi command, which lets a test stub it.

set -u

marker="$HOME/.cron/logs/chezmoi.FAILED"
stamp="$HOME/.cron/logs/chezmoi.ok"

# launchd runs a job the Mac slept through as soon as the Mac wakes, often
# before the network is back. Skip that run quietly (see wait-for-network.sh),
# but write the marker when no run has succeeded in 24 hours. Any status but
# 1 (helper missing, or it cannot check) runs the job as before.
"${WAIT_FOR_NETWORK:-$HOME/.cron/wait-for-network.sh}"
if [ $? -eq 1 ]; then
    echo "chezmoi-update: network not up; skipped"
    if [ ! -e "$marker" ] && [ -z "$(find "$stamp" -mmin -1440 2>/dev/null)" ]; then
        mkdir -p "${marker%/*}"
        echo "$(date '+%F %R') chezmoi: network check failed and no successful run in 24 hours (see ~/.cron/logs/chezmoi.log)" > "$marker"
    fi
    exit 0
fi

"${CHEZMOI:-chezmoi}" update --force
rc=$?

if [ "$rc" -ne 0 ]; then
    echo "chezmoi-update: FAILED: exit $rc"
    mkdir -p "${marker%/*}"
    echo "$(date '+%F %R') chezmoi update failed: exit $rc (see ~/.cron/logs/chezmoi.log, then run 'chezmoi update')" > "$marker"
    exit "$rc"
fi

rm -f "$marker"
mkdir -p "${marker%/*}"
touch "$stamp"
echo "chezmoi-update: ok"
