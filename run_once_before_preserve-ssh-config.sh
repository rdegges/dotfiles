#!/bin/sh
# chezmoi owns ~/.ssh/config and overwrites it. Before it does that the first
# time, keep a hand-written config by copying it to ~/.ssh/config.local, which
# the managed config includes first, so its hosts keep working.
#
# A config that has the managed config's Include line is already chezmoi's.
# If config.local already exists, stop the apply (nothing is written yet,
# because this is a before_ script) instead of overwriting or appending to it.
# chezmoi records a run_once script only when it exits 0, so it tries again on
# the next apply.
set -u

config="$HOME/.ssh/config"
local_config="$HOME/.ssh/config.local"

[ -e "$config" ] || exit 0

grep -qxF 'Include ~/.ssh/config.local' "$config"
rc=$?
if [ "$rc" -eq 0 ]; then
    exit 0
elif [ "$rc" -ne 1 ]; then
    echo "preserve-ssh-config: cannot read $config (grep exit $rc)" >&2
    exit 1
fi

if [ -e "$local_config" ] || [ -L "$local_config" ]; then
    echo "preserve-ssh-config: $config was not written by chezmoi, and $local_config already exists." >&2
    echo "preserve-ssh-config: merge $config into $local_config by hand, delete $config, then run chezmoi apply again." >&2
    exit 1
fi

if ! cp -p "$config" "$local_config"; then
    echo "preserve-ssh-config: cannot copy $config to $local_config" >&2
    exit 1
fi
echo "preserve-ssh-config: copied $config to $local_config; chezmoi now manages $config"
exit 0
