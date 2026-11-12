#!/bin/sh
# Keep the Tailscale client up on the homelab server Mac (homelab = true only;
# see .chezmoiignore). launchd runs this every 5 minutes.
#
# Tailscale is how this Mac is reached from outside, so a client that is down
# locks everyone out until someone is at the keyboard. Updates stay with the
# App Store (or the Standalone build's own updater), which applies them
# unattended. What goes wrong is the client state: after an App Store
# auto-update the client has gone Running -> Stopped (WantRunning=false) and
# stayed down until someone ran `tailscale up` (tailscale/tailscale#21825).
#
# Each run:
#   - App not running: start it in the background (`open -g -b <bundle id>`)
#     and wait up to 30s for it. The bundle id comes from the installed app, so
#     the App Store (io.tailscale.ipn.macos) and Standalone
#     (io.tailscale.ipn.macsys) builds both work; any other id is a failure.
#   - BackendState Stopped while logged in (the #21825 case): `tailscale up`
#     with no flags, bounded at 30s, then wait up to 30s for Running. If `up`
#     refuses because the node has non-default prefs ("requires mentioning all
#     non-default flags"), that is a failure: guessed flags could change the
#     node's routes or exit node.
#   - Starting or NoState: wait up to 30s for the state to settle.
#   - Running: healthy.
#   - Anything else (NeedsLogin, NeedsMachineAuth, logged out, still not
#     Running after the fix) is a failure. So is a CLI or JSON this script
#     cannot read: a probe that cannot evaluate never counts as healthy.
# It never restarts the network extension, re-authenticates, or switches
# between the App Store and Standalone builds: each of those needs a person.
#
# No wait-for-network.sh: an outage is what this job exists to report.
#
# A failure writes ~/.cron/logs/tailscale-watchdog.FAILED (replaced, never
# appended), which every new shell prints (dot_zshrc). A healthy run removes it
# and touches tailscale-watchdog.ok. The log is overwritten every 5 minutes, so
# the marker and the mail carry the reason.
#
# Mail goes out only when the state changes, so an outage sends one mail, not
# one every 5 minutes. tailscale-watchdog.state holds the last state that was
# mailed (or seen, when nothing needed mail): Running, or a failure key. A run
# that fixed something mails what it did. A mail that cannot be sent writes the
# marker and exits non-zero, and the state file keeps a value that makes the
# next run try again.
#
# TAILSCALE_CLI overrides the CLI path, for a forced failure or a test; a stub
# must answer `status --json`, `debug prefs`, and `up`. TAILSCALE_WATCHDOG_WAIT
# overrides the 30s waits for the app and for the state (the 30s bound on
# `tailscale up` stays).

set -u

app=/Applications/Tailscale.app
cli="${TAILSCALE_CLI:-$app/Contents/MacOS/Tailscale}"
wait="${TAILSCALE_WATCHDOG_WAIT:-30}"
logs="$HOME/.cron/logs"
marker="$logs/tailscale-watchdog.FAILED"
stamp="$logs/tailscale-watchdog.ok"
statefile="$logs/tailscale-watchdog.state"
# The himalaya account "icloud" is the Fastmail-backed r@rdegges.com account;
# the name is historical (see dot_config/himalaya/config.toml.tmpl).
account=icloud
rcpt=r@rdegges.com

mkdir -p "$logs"
prev=$(cat "$statefile" 2>/dev/null)
host=$(hostname -s 2>/dev/null) || host="this Mac"

# The loader's pattern: bounded when coreutils' timeout is installed, unbounded
# otherwise. run <seconds> <cmd...>
TO=$(command -v gtimeout || command -v timeout || true)
run() { s=$1; shift; if [ -n "$TO" ]; then "$TO" -k 5 "$s" "$@"; else "$@"; fi; }

# One line, at most 300 characters, for the marker, the mail, and the state.
oneline() { printf '%s' "$1" | tr '\n\t' '  ' | cut -c1-300; }

send_mail() { # send_mail <subject> <body>
    msg=$(printf 'From: %s\nTo: %s\nSubject: %s\n\n%s\n' "$rcpt" "$rcpt" "$1" "$2")
    if out=$(run 60 himalaya message send -a "$account" "$msg" < /dev/null 2>&1); then
        echo "tailscale-watchdog: mailed: $1"
        return 0
    fi
    echo "tailscale-watchdog: mail failed: $(oneline "$out")"
    return 1
}

# fail <key> <reason>: write the marker, mail when the key differs from the
# last one mailed, exit 1.
fail() {
    echo "tailscale-watchdog: FAILED: $2"
    note=
    if [ "$prev" != "$1" ]; then
        if send_mail "Tailscale is down on $host: $1" "Tailscale on $host is not up, and the watchdog could not fix it.

Reason: $2

The watchdog mails again only when this changes. The reason stays in ~/.cron/logs/tailscale-watchdog.FAILED until a run finds Tailscale Running."; then
            echo "$1" > "$statefile"
        else
            note="; the alert mail failed too"
        fi
    fi
    echo "$(date '+%F %R') tailscale-watchdog: $2$note (see ~/.cron/logs/tailscale-watchdog.log)" > "$marker"
    exit 1
}

# ok <what this run fixed, or empty> <state key before the fix>: healthy.
ok() {
    if [ -n "$1" ] || { [ -n "$prev" ] && [ "$prev" != Running ]; }; then
        what=${1:-"the last report was $prev, and this run found Tailscale Running"}
        if ! send_mail "Tailscale recovered on $host" "Tailscale on $host is Running again.

What happened: $what."; then
            # A fix that the mail could not report must still be reported:
            # record the state before the fix, so the next run mails again.
            if [ -z "$prev" ] || [ "$prev" = Running ]; then echo "$2" > "$statefile"; fi
            echo "$(date '+%F %R') tailscale-watchdog: Tailscale is Running again ($what), but the recovery mail failed (see ~/.cron/logs/tailscale-watchdog.log)" > "$marker"
            exit 1
        fi
    fi
    echo Running > "$statefile"
    rm -f "$marker"
    touch "$stamp"
    echo "tailscale-watchdog: ok: Running"
    exit 0
}

# read_state: set $st to the BackendState, or return 1 with $st empty and the
# reason in $err. Exactly one known value must appear in the JSON. The exit
# code is not trusted either way: the state the JSON states is what counts.
read_state() {
    st= err=
    out=$(run 10 "$cli" status --json < /dev/null 2>&1); rc=$?
    v=$(printf '%s\n' "$out" | sed -n 's/.*"BackendState": *"\([A-Za-z]*\)".*/\1/p')
    case "$v" in
        NoState | NeedsLogin | NeedsMachineAuth | Stopped | Starting | Running | InUseOtherUser) st=$v ;;
        *) err="cannot read BackendState from \`tailscale status --json\` (exit $rc): $(oneline "$out")"; return 1 ;;
    esac
}

# poll <settled|running>: read the state until it is settled (not Starting or
# NoState) or Running, at most $wait seconds. Returns 1 when the last read
# failed or the state is not what was asked for.
poll() {
    deadline=$(($(date +%s) + wait))
    while :; do
        if read_state; then
            case "$1:$st" in
                running:Running) return 0 ;;
                settled:Starting | settled:NoState | running:*) ;;
                settled:*) return 0 ;;
            esac
        fi
        [ "$(date +%s)" -ge "$deadline" ] && return 1
        sleep 1
    done
}

[ -x "$cli" ] || fail cli-missing "Tailscale CLI not found or not executable: $cli"

fixed= before=
pgrep -fx "$app/Contents/MacOS/Tailscale" > /dev/null 2>&1; prc=$?
if [ "$prc" -eq 1 ]; then
    id=$(oneline "$(plutil -extract CFBundleIdentifier raw -o - "$app/Contents/Info.plist" 2>&1)")
    case "$id" in
        io.tailscale.ipn.macos | io.tailscale.ipn.macsys) ;;
        *) fail app-not-running "Tailscale app is not running, and $app has no known bundle id ($id); not started" ;;
    esac
    echo "tailscale-watchdog: app not running; starting $id"
    out=$(run 30 open -g -b "$id" < /dev/null 2>&1) || fail app-not-running "Tailscale app is not running, and \`open -g -b $id\` failed: $(oneline "$out")"
    deadline=$(($(date +%s) + wait))
    until pgrep -fx "$app/Contents/MacOS/Tailscale" > /dev/null 2>&1; do
        [ "$(date +%s)" -ge "$deadline" ] && fail app-not-running "started $id, but the app was not running ${wait}s later"
        sleep 1
    done
    fixed="the Tailscale app was not running; the watchdog started it (open -g -b $id)"
    before=app-not-running
elif [ "$prc" -ne 0 ]; then
    fail cannot-evaluate "pgrep could not check whether the Tailscale app runs (exit $prc)"
fi

if ! poll settled; then
    [ -n "$st" ] || fail cannot-evaluate "$err"
    fail "$st" "BackendState is still $st after ${wait}s"
fi

case "$st" in
Running) ok "$fixed" "$before" ;;
Stopped)
    out=$(run 10 "$cli" debug prefs < /dev/null 2>&1); rc=$?
    lo=$(printf '%s\n' "$out" | sed -n 's/.*"LoggedOut": *\([a-z]*\).*/\1/p')
    case "$lo" in
        false) ;;
        true) fail logged-out "BackendState is Stopped and the client is logged out; log in by hand" ;;
        *) fail cannot-evaluate "BackendState is Stopped, and LoggedOut cannot be read from \`tailscale debug prefs\` (exit $rc): $(oneline "$out")" ;;
    esac
    echo "tailscale-watchdog: BackendState Stopped while logged in; running tailscale up"
    out=$(run 30 "$cli" up < /dev/null 2>&1); rc=$?
    [ "$rc" -eq 0 ] || fail up-failed "BackendState was Stopped, and \`tailscale up\` failed (exit $rc; 124 or 137 is the 30s timeout): $(oneline "$out")"
    poll running || fail not-running "BackendState was Stopped; \`tailscale up\` ran, but the state is ${st:-unreadable} ${wait}s later"
    fixed="${fixed:+$fixed; }BackendState was Stopped while logged in; the watchdog ran \`tailscale up\`"
    ok "$fixed" "${before:-Stopped}"
    ;;
NeedsLogin | NeedsMachineAuth | InUseOtherUser)
    fail "$st" "BackendState is $st; this needs a person (the watchdog never re-authenticates)" ;;
*) fail "$st" "BackendState is $st" ;;
esac
