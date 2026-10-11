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

"${CHEZMOI:-chezmoi}" update --force
rc=$?

if [ "$rc" -ne 0 ]; then
    echo "chezmoi-update: FAILED: exit $rc"
    mkdir -p "${marker%/*}"
    echo "$(date '+%F %R') chezmoi update failed: exit $rc (see ~/.cron/logs/chezmoi.log, then run 'chezmoi update')" > "$marker"
    exit "$rc"
fi

rm -f "$marker"
echo "chezmoi-update: ok"
