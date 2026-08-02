#!/bin/sh
# Hourly commit of every Obsidian vault that is a git repo.
#
# This is the undo button for AI-driven vault maintenance: Obsidian Sync has no
# usable version history, and its file-recovery plugin does not capture writes
# made outside the app. Hourly (not every 10 min) so `git log` stays a readable
# audit trail rather than 50k/year of noise.
#
# Vaults are listed explicitly. A vault that does not exist, or is not yet a git
# repo, is skipped silently -- that is the normal state mid-migration.

set -u

for vault in "$HOME/Vault/Personal" "$HOME/Vault/Work"; do
    [ -d "$vault/.git" ] || continue

    # Never snapshot mid-rebase/merge; committing then would bake in a half state.
    if [ -e "$vault/.git/rebase-merge" ] || [ -e "$vault/.git/MERGE_HEAD" ]; then
        echo "skip $vault: rebase/merge in progress"
        continue
    fi

    git -C "$vault" add -A || { echo "fail $vault: git add"; continue; }

    if git -C "$vault" diff --cached --quiet; then
        echo "skip $vault: no changes"
    else
        n=$(git -C "$vault" diff --cached --name-only | wc -l | tr -d ' ')
        git -C "$vault" commit -q -m "snapshot: $n file(s) @ $(date -Iseconds)" \
            && echo "ok   $vault: committed $n file(s)" \
            || echo "fail $vault: git commit"
    fi
done
