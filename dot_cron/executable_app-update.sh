#!/bin/bash
# Keep the desktop apps on the homelab server Mac up to date (homelab = true
# only; see .chezmoiignore). launchd runs this at 02:40, 03:40, 04:40, and
# 05:40. The first of those runs that finds the Mac idle does one pass; the
# later runs that night see today's stamp and exit.
#
# Gate, before any action. A probe that cannot evaluate counts as busy.
#   - Hour guard: outside 02:00-05:59 local time, exit 0 ("outside window"),
#     also for a launchd catch-up run after a wake. APP_UPDATE_ANY_HOUR=1
#     turns off the hour guard only, for a forced run by hand.
#   - ~/.cron/logs/app-update.ok has today's date: exit 0.
#   - wait-for-network.sh, as chezmoi-update.sh runs it.
#   - Busy: a file under ~/.claude/projects or ~/.codex/sessions changed in the
#     last 20 min, the keyboard or mouse was used in the last 30 min (ioreg
#     HIDIdleTime), or the 5-minute load average is over 4.
# A skip writes app-update.FAILED and mails once when no pass has completed in
# 7 days (app-update.ok older than 7 days, or missing).
#
# The pass. Each app is found by its exact bundle id: the Info.plist must name
# it, and the PID comes from `lsappinfo info -app <bundle id>`, whose output
# must name the same bundleID (lsappinfo also matches app names, and a match on
# the name "claude" would be a Claude Code CLI session). Nothing is found by
# process name, nothing is sent to a process this job did not find that way,
# and no Apple Events are used (TCC). A quit is `kill -TERM` to the app's main
# PID, then a wait of at most 60s; never SIGKILL. A relaunch is
# `open -g -b <bundle id>` and a check for a new PID within 60s.
#   - Herdr (relaunch): pending = /Applications/Herdr.app.new.noindex. The
#     agent sessions live in the herdr-core server that launchd owns, not in
#     Herdr.app. The PIDs of `herdr-core --hc-launchd` and `herdr-core hold`
#     are recorded before the quit and compared after the relaunch: a change
#     is FAILED ("herdr-core restarted, sessions lost"). No server found: not
#     relaunched.
#   - T3 Code, Fastmail, 1Password (relaunch, Squirrel): pending =
#     ~/Library/Caches/<bundle id>.ShipIt/ShipItState.plist. After the app
#     exits, wait at most 120s until no ShipIt process for that bundle id runs
#     and ShipItState.plist is gone; only then `open`. An `open` while ShipIt
#     still swaps the bundle can start a half-installed app. 1Password comes
#     back locked, so `op` fails until someone unlocks it; the mail says so.
#   - Claude Desktop (relaunch only with no session): Squirrel, as above. Not
#     relaunched when a `claude` process descends from Claude.app, or when a
#     file under claude-code-sessions/ or local-agent-mode-sessions/, or
#     vm_bundles/claudevm.bundle/rootfs.img, changed in the last 60 min. If
#     this cannot be checked, it is reported, not relaunched.
#   - Chrome (report only; a quit loses tabs): the bundle version against the
#     framework version that the running Chrome's helpers use. Chrome's updater
#     replaces the bundle in place, so a difference is a staged update.
#   - Downie and Ghostty (report only; a Ghostty quit closes its shells):
#     SUFeedURL from Info.plist, fetched with curl (20s), newest
#     sparkle:shortVersionString against the installed version. A feed that
#     cannot be read is a warning, not FAILED.
#   - Docker Desktop, weekly: on Sunday, or on any pass when
#     app-update-docker.ok is older than 8 days (or missing), so a run of busy
#     Sundays cannot stop Docker updates. Not when Docker does not answer or a
#     container runs. `docker desktop update --quiet` (20 min bound), then wait
#     at most 10 min for `docker info`.
# Versions come from CFBundleShortVersionString before and after. The mail
# says "updated" only when the version changed; a relaunch with the same
# version is a warning in the mail, not FAILED. The Claude Code CLI updates
# itself; this job never runs `claude update`.
#
# Mail goes to r@rdegges.com only when something changed, failed, or needs a
# relaunch by hand; a night with nothing to do sends nothing. Warnings ride
# along in such a mail but do not send one. A failure writes
# ~/.cron/logs/app-update.FAILED (replaced, never appended), which every new
# shell prints (dot_zshrc), and exits 1. So does a mail that cannot be sent. A
# completed pass touches app-update.ok, also when an app failed: a failed
# relaunch is not retried the same night. A clean pass removes the marker.
#
# APP_UPDATE_ANY_HOUR=1 skips the hour guard. APP_UPDATE_MAIL_ACCOUNT replaces
# the himalaya account (default icloud), for a forced mail failure. For tests
# only: APP_UPDATE_APPS replaces /Applications, and APP_UPDATE_WAIT replaces
# the 60s, 120s, and 10 min waits (the 20 min bound on the Docker update
# stays).

set -u

apps="${APP_UPDATE_APPS:-/Applications}"
logs="$HOME/.cron/logs"
marker="$logs/app-update.FAILED"
stamp="$logs/app-update.ok"
dstamp="$logs/app-update-docker.ok"
# The himalaya account "icloud" is the Fastmail-backed r@rdegges.com account;
# the name is historical (see dot_config/himalaya/config.toml.tmpl).
account="${APP_UPDATE_MAIL_ACCOUNT:-icloud}"
rcpt=r@rdegges.com
nl='
'

# The launchd plist PATH has no /usr/sbin, and macOS ships ioreg and sysctl
# only there.
PATH="$PATH:/usr/sbin:/sbin"

mkdir -p "$logs"

# The loader's pattern: bounded when coreutils' timeout is installed, unbounded
# otherwise. run <seconds> <cmd...>
TO=$(command -v gtimeout || command -v timeout || true)
run() { s=$1; shift; if [ -n "$TO" ]; then "$TO" -k 5 "$s" "$@"; else "$@"; fi; }

# One line, at most 300 characters, for the marker and the mail. Printable
# ASCII only, before the cut: under launchd there is no LANG, so cut counts
# bytes and could split a multi-byte character into invalid UTF-8.
oneline() { printf '%s' "$1" | tr '\n\t' '  ' | LC_ALL=C tr -cd '\11\12\15\40-\176' | cut -c1-300; }

say() { printf 'app-update: %s\n' "$1"; }

host=$(oneline "$(hostname -s 2>/dev/null)")
[ -n "$host" ] || host="this Mac"

# wait <default seconds>: the bound to use (APP_UPDATE_WAIT in tests).
bound() { printf '%s' "${APP_UPDATE_WAIT:-$1}"; }

send_mail() { # send_mail <subject> <body>
    msg=$(printf 'From: %s\nTo: %s\nSubject: %s\n\n%s\n' "$rcpt" "$rcpt" "$1" "$2")
    # The message goes on stdin, never as an argument. himalaya 1.2.0 reads
    # stdin whenever it is not a TTY and ignores the argument, so under launchd
    # `himalaya message send "$msg" < /dev/null` panics on the empty input
    # (exit 101) and sends nothing.
    if out=$(printf '%s' "$msg" | run 60 himalaya message send -a "$account" 2>&1); then
        say "mailed: $1"
        return 0
    fi
    say "mail failed: $(oneline "$out")"
    return 1
}

# skip <reason>: no pass tonight. When no pass has completed in 7 days and no
# marker shows yet, write one and mail once.
skip() {
    say "skipped: $1"
    if [ ! -e "$marker" ] && [ -z "$(find "$stamp" -mmin -10080 2>/dev/null)" ]; then
        why="no completed pass in the last 7 days; the last skip was: $(oneline "$1")"
        note=
        send_mail "App updates stalled on $host" "The nightly app update on $host has not completed a pass in the last 7 days (~/.cron/logs/app-update.ok is older, or missing).

Last skip: $(oneline "$1")

The job mails this once. The reason stays in ~/.cron/logs/app-update.FAILED until a pass completes." || note="; the alert mail failed too"
        printf '%s app-update: %s%s (see ~/.cron/logs/app-update.log)\n' "$(date '+%F %R')" "$why" "$note" > "$marker"
        [ -z "$note" ] || exit 1
    fi
    exit 0
}

# --- Gate ----------------------------------------------------------------------

now=$(date '+%H %w %F')
hour=${now%% *}; rest=${now#* }; wday=${rest%% *}; today=${rest#* }
case "$hour:$wday" in
    [0-2][0-9]:[0-6]) ;;
    *) skip "cannot read the local time (date printed: $(oneline "$now"))" ;;
esac

if [ "${APP_UPDATE_ANY_HOUR:-}" != 1 ]; then
    case "$hour" in
        02 | 03 | 04 | 05) ;;
        *) skip "outside window (local hour $hour; passes run 02:00-05:59)" ;;
    esac
fi

if [ -e "$stamp" ] && [ "$(date -r "$stamp" +%F 2>/dev/null)" = "$today" ]; then
    say "already ran today ($today)"
    exit 0
fi

# launchd runs a job the Mac slept through as soon as the Mac wakes, often
# before the network is back (see wait-for-network.sh). Any status but 1
# (helper missing, or it cannot check) runs the job as before.
"${WAIT_FOR_NETWORK:-$HOME/.cron/wait-for-network.sh}"
[ $? -eq 1 ] && skip "network not up"

# busy: set $reason and return 0 when the Mac is in use, or when a probe
# cannot tell.
busy() {
    for rel in .claude/projects .codex/sessions; do
        d="$HOME/$rel"
        # No directory: that agent has never run here, so it is not busy.
        [ -e "$d" ] || continue
        out=$(find "$d" -type f -mmin -20 2>&1); rc=$?
        [ "$rc" -eq 0 ] || { reason="cannot check agent activity under ~/$rel (find exit $rc)"; return 0; }
        [ -z "$out" ] || { reason="an agent session under ~/$rel changed in the last 20 min"; return 0; }
    done

    out=$(run 30 ioreg -c IOHIDSystem -d 4 2>&1); rc=$?
    ns=$(printf '%s\n' "$out" | sed -n 's/.*"HIDIdleTime" = \([0-9][0-9]*\).*/\1/p' | sort -n | head -n 1)
    if [ "$rc" -ne 0 ] || [ -z "$ns" ] || [ "${#ns}" -gt 18 ]; then
        reason="cannot read HIDIdleTime from ioreg (exit $rc)"; return 0
    fi
    idle=$((ns / 1000000000))
    [ "$idle" -ge 1800 ] || { reason="keyboard or mouse used $((idle / 60)) min ago (under 30)"; return 0; }

    out=$(run 10 sysctl -n vm.loadavg 2>&1); rc=$?
    load=$(printf '%s\n' "$out" | sed -n 's/^{ *[0-9.][0-9.]* \{1,\}\([0-9][0-9.]*\) \{1,\}[0-9.][0-9.]* *}$/\1/p')
    if [ "$rc" -ne 0 ] || [ -z "$load" ]; then
        reason="cannot read the load average from sysctl (exit $rc): $(oneline "$out")"; return 0
    fi
    if awk -v l="$load" 'BEGIN { exit !(l + 0 > 4) }'; then
        reason="5-minute load average is $load (over 4)"; return 0
    fi
    return 1
}

busy && skip "busy: $reason"

say "gate passed; starting the pass"

# --- Results -------------------------------------------------------------------

# Four lists of mail lines: F failed, C changed, M needs a relaunch by hand,
# W warnings. add <F|C|M|W> <text>
F= C= M= W=
add() {
    line="- $(oneline "$2")"
    case "$1" in F) l=FAILED ;; C) l=changed ;; M) l="by hand" ;; *) l=warning ;; esac
    say "$l: ${line#- }"
    eval "$1=\${$1}\$line\$nl"
}

# --- Probes --------------------------------------------------------------------

# installed <name> <bundle id> <bundle>: set $plist, or return 1 (not
# installed, or the bundle there has another id).
installed() {
    plist="$apps/$3/Contents/Info.plist"
    if [ ! -e "$plist" ]; then say "$1: not installed"; return 1; fi
    got=$(oneline "$(plutil -extract CFBundleIdentifier raw -o - "$plist" 2>&1)")
    if [ "$got" != "$2" ]; then add W "$1: $apps/$3 has bundle id '$got', not $2; skipped"; return 1; fi
}

version() { # version <Info.plist>
    v=$(plutil -extract CFBundleShortVersionString raw -o - "$1" 2>/dev/null) || v=unknown
    v=$(oneline "$v")
    printf '%s' "${v:-unknown}"
}

# app_pid <bundle id>: set $pid ('' when not running), or return 1 with $err.
# lsappinfo prints nothing (exit 0) for an app that is not running.
app_pid() {
    pid= err=
    out=$(run 10 lsappinfo info -only pid -only bundleid -app "$1" 2>&1); rc=$?
    if [ "$rc" -ne 0 ]; then err="lsappinfo exit $rc: $(oneline "$out")"; return 1; fi
    [ -n "$out" ] || return 0
    b=$(printf '%s\n' "$out" | sed -n 's/^ *bundleID="\(.*\)" *$/\1/p')
    p=$(printf '%s\n' "$out" | sed -n 's/^ *pid = \([0-9][0-9]*\)\( .*\)\{0,1\}$/\1/p')
    if [ "$b" != "$1" ] || [ -z "$p" ] || [ "$p" != "${p%%[!0-9]*}" ]; then
        err="lsappinfo output does not name exactly bundleID \"$1\" with one pid: $(oneline "$out")"
        return 1
    fi
    pid=$p
}

alive() { # alive <pid>: a zombie counts as gone
    s=$(ps -o stat= -p "$1" 2>/dev/null) || return 1
    case "$s" in '' | Z* | *' Z'*) return 1 ;; esac
    return 0
}

# shipit_busy <bundle id>: a ShipIt for this bundle runs, or ps cannot tell.
# Squirrel starts it as `.../ShipIt <bundle id>.ShipIt <state plist>`.
shipit_busy() {
    out=$(ps -A -o args= 2>/dev/null) || return 0
    printf '%s\n' "$out" | grep -F -q -- "/ShipIt $1.ShipIt"
}

# herdr_core: print the herdr-core server and holder PIDs ("hc-launchd:<pid>
# hold:<pid>", sorted), or return 1 when ps fails.
herdr_core() {
    out=$(ps -A -o pid= -o args= 2>/dev/null) || return 1
    printf '%s\n' "$out" | awk '{ n = split($2, p, "/"); if (p[n] == "herdr-core" && ($3 == "--hc-launchd" || $3 == "hold")) print substr($3, 1 + ($3 ~ /^--/) * 2) ":" $1 }' | sort | tr '\n' ' ' | sed 's/ $//'
}

# claude_session <pid>: set $why and return 0 when Claude Desktop hosts a
# session; return 2 with $why when that cannot be checked; 1 when idle.
claude_session() {
    out=$(ps -A -o pid= -o ppid= -o comm= 2>&1) || { why="ps failed: $(oneline "$out")"; return 2; }
    kids=$(printf '%s\n' "$out" | awk -v root="$1" '
        { c = $0; sub(/^ *[0-9]+ +[0-9]+ +/, "", c); sub(/.*\//, "", c); par[$1] = $2; base[$1] = c }
        END {
            mark[root] = 1
            do { grew = 0; for (p in par) if (!(p in mark) && (par[p] in mark)) { mark[p] = 1; grew = 1 } } while (grew)
            for (p in mark) if (p != root && base[p] == "claude") print p
        }')
    if [ -n "$kids" ]; then why="a claude process (PID $(printf '%s' "$kids" | tr '\n' ' ' | sed 's/ $//')) runs under Claude.app"; return 0; fi
    sup="$HOME/Library/Application Support/Claude"
    out=$(find "$sup/claude-code-sessions" "$sup/local-agent-mode-sessions" "$sup/vm_bundles/claudevm.bundle/rootfs.img" -mmin -60 2>&1); rc=$?
    if [ "$rc" -ne 0 ]; then why="cannot check Claude session files (find exit $rc): $(oneline "$out")"; return 2; fi
    if [ -n "$out" ]; then why="Claude session files or the VM disk changed in the last 60 min"; return 0; fi
    return 1
}

# vnewer <a> <b>: exit 0 when dotted version a is newer than b.
vnewer() {
    awk -v a="$1" -v b="$2" 'BEGIN {
        na = split(a, x, "."); nb = split(b, y, "."); n = na > nb ? na : nb
        for (i = 1; i <= n; i++) { p = x[i] + 0; q = y[i] + 0; if (p > q) exit 0; if (p < q) exit 1 }
        exit 1 }'
}

# --- Relaunch ------------------------------------------------------------------

# relaunch <name> <bundle id> <kind: herdr|shipit> [note]: quit the app at
# $pid, wait, and start it again. $plist is its Info.plist.
relaunch() {
    name=$1 id=$2 kind=$3 extra=${4:-}
    old=$pid
    before=$(version "$plist")
    hc=
    if [ "$kind" = herdr ]; then
        hc=$(herdr_core) || { add M "$name: update staged; not relaunched: ps cannot list the herdr-core processes; relaunch by hand"; return; }
        case "$hc" in
            *hc-launchd:*) ;;
            *) add M "$name: update staged; not relaunched: no herdr-core --hc-launchd server found, so the job cannot prove the sessions survive; relaunch by hand"; return ;;
        esac
        say "$name: herdr-core before: $hc"
    fi

    say "$name: sending SIGTERM to PID $old"
    if ! kill -TERM "$old" 2>/dev/null; then
        add F "$name: kill -TERM $old failed; not relaunched"; return
    fi
    t=$(bound 60); deadline=$(($(date +%s) + t))
    while alive "$old"; do
        if [ "$(date +%s)" -ge "$deadline" ]; then
            add F "$name: PID $old still runs ${t}s after SIGTERM; left running (the job never sends SIGKILL)"; return
        fi
        sleep 1
    done

    if [ "$kind" = shipit ]; then
        state="$HOME/Library/Caches/$id.ShipIt/ShipItState.plist"
        t=$(bound 120); deadline=$(($(date +%s) + t))
        while shipit_busy "$id" || [ -e "$state" ]; do
            if [ "$(date +%s)" -ge "$deadline" ]; then
                add F "$name: quit, but ShipIt did not finish within ${t}s (ShipIt still runs or ShipItState.plist is still there); not started, so start it by hand once ShipIt is done"; return
            fi
            sleep 1
        done
    fi

    if ! out=$(run 30 open -g -b "$id" < /dev/null 2>&1); then
        add F "$name: quit, but \`open -g -b $id\` failed: $out"; return
    fi
    t=$(bound 60); deadline=$(($(date +%s) + t))
    while :; do
        if app_pid "$id" && [ -n "$pid" ] && [ "$pid" != "$old" ]; then break; fi
        if [ "$(date +%s)" -ge "$deadline" ]; then
            add F "$name: quit and \`open -g -b $id\` ran, but the app was not running ${t}s later"; return
        fi
        sleep 1
    done

    if [ "$kind" = herdr ]; then
        after_hc=$(herdr_core) || after_hc="(ps failed)"
        say "$name: herdr-core after: $after_hc"
        [ "$after_hc" = "$hc" ] || add F "$name: herdr-core restarted, sessions lost (before: $hc; after: ${after_hc:-none})"
    fi

    after=$(version "$plist")
    if [ "$after" != "$before" ]; then
        add C "$name updated and relaunched, $before -> $after$extra"
    else
        add C "$name relaunched, but the version is unchanged ($before): WARNING, the staged update did not apply$extra"
    fi
}

squirrel_app() { # squirrel_app <name> <bundle id> <bundle> [note]
    installed "$1" "$2" "$3" || return
    if [ ! -e "$HOME/Library/Caches/$2.ShipIt/ShipItState.plist" ]; then say "$1: no update staged"; return; fi
    app_pid "$2" || { add F "$1: update staged, but its PID cannot be read ($err); not relaunched"; return; }
    if [ -z "$pid" ]; then add W "$1: ShipItState.plist is there, but the app is not running; not started"; return; fi
    relaunch "$1" "$2" shipit "${4:-}"
}

herdr_app() {
    installed Herdr dev.herdr.app Herdr.app || return
    if [ ! -e "$apps/Herdr.app.new.noindex" ]; then say "Herdr: no update staged"; return; fi
    app_pid dev.herdr.app || { add F "Herdr: update staged, but its PID cannot be read ($err); not relaunched"; return; }
    if [ -z "$pid" ]; then add W "Herdr: an update is staged, but Herdr.app is not running; not started"; return; fi
    relaunch Herdr dev.herdr.app herdr
}

claude_app() {
    n="Claude Desktop" id=com.anthropic.claudefordesktop
    installed "$n" "$id" Claude.app || return
    if [ ! -e "$HOME/Library/Caches/$id.ShipIt/ShipItState.plist" ]; then say "$n: no update staged"; return; fi
    app_pid "$id" || { add F "$n: update staged, but its PID cannot be read ($err); not relaunched"; return; }
    if [ -z "$pid" ]; then add W "$n: ShipItState.plist is there, but the app is not running; not started"; return; fi
    claude_session "$pid"
    case $? in
        0) add M "$n: update staged; skipped: session active ($why); relaunch by hand"; return ;;
        2) add M "$n: update staged; not relaunched: $why; relaunch by hand"; return ;;
    esac
    relaunch "$n" "$id" shipit
}

# --- Report only ---------------------------------------------------------------

chrome_app() {
    installed Chrome com.google.Chrome "Google Chrome.app" || return
    inst=$(version "$plist")
    app_pid com.google.Chrome || { add W "Chrome: could not check ($err)"; return; }
    if [ -z "$pid" ]; then say "Chrome: not running"; return; fi
    out=$(ps -A -o ppid= -o args= 2>/dev/null) || { add W "Chrome: could not check (ps failed)"; return; }
    running=$(printf '%s\n' "$out" | awk -v p="$pid" '$1 == p' | sed -n 's#.*/Google Chrome Framework\.framework/Versions/\([^/]*\)/.*#\1#p' | sort -u)
    case "$running" in
        '' | *"$nl"*) add W "Chrome: could not check (no single framework version in the running helpers: $(oneline "$running"))"; return ;;
    esac
    if [ "$running" != "$inst" ]; then
        add M "Chrome: update staged (running $running, installed $inst); relaunch by hand (the job never quits Chrome: a quit loses tabs)"
    else
        say "Chrome: up to date ($inst)"
    fi
}

appcast_app() { # appcast_app <name> <bundle id> <bundle> [note]
    installed "$1" "$2" "$3" || return
    inst=$(version "$plist")
    feed=$(plutil -extract SUFeedURL raw -o - "$plist" 2>/dev/null) || { add W "$1: could not check (no SUFeedURL in its Info.plist)"; return; }
    case "$feed" in
        https://*) ;;
        *) add W "$1: could not check (SUFeedURL is not https: $feed)"; return ;;
    esac
    if ! body=$(run 25 curl -fsSL --max-time 20 "$feed" < /dev/null 2>&1); then
        add W "$1: could not check (fetch of $feed failed: $body)"; return
    fi
    newest=
    for v in $(printf '%s\n' "$body" | grep -o -e 'sparkle:shortVersionString="[^"]*"' -e '<sparkle:shortVersionString>[^<]*' \
        | sed -e 's/^sparkle:shortVersionString="//' -e 's/"$//' -e 's/^<sparkle:shortVersionString>//' | LC_ALL=C tr -cd '0-9A-Za-z.+\n-'); do
        if [ -z "$newest" ] || vnewer "$v" "$newest"; then newest=$v; fi
    done
    if [ -z "$newest" ]; then add W "$1: could not check (no sparkle:shortVersionString in $feed)"; return; fi
    if vnewer "$newest" "$inst"; then
        add M "$1: update available ($inst -> $newest); relaunch by hand${4:-}"
    else
        say "$1: up to date ($inst; newest in the appcast: $newest)"
    fi
}

# --- Docker Desktop, weekly ----------------------------------------------------

docker_app() {
    installed "Docker Desktop" com.docker.docker Docker.app || return
    # %w 0 is Sunday: the 02:40 Sunday run is "Saturday night".
    if [ "$wday" = 0 ]; then
        due="Sunday"
    elif [ -z "$(find "$dstamp" -mmin -11520 2>/dev/null)" ]; then
        due="no Docker update in the last 8 days"
    else
        say "Docker Desktop: not due (Sunday, or 8 days after the last update)"; return
    fi
    if ! out=$(run 30 docker info < /dev/null 2>&1); then
        add M "Docker Desktop: not updated ($due): Docker does not answer \`docker info\`"; return
    fi
    if ! ids=$(run 30 docker ps -q < /dev/null 2>&1); then
        add M "Docker Desktop: not updated ($due): \`docker ps -q\` failed: $ids"; return
    fi
    if [ -n "$ids" ]; then
        add M "Docker Desktop: not updated ($due): $(printf '%s\n' "$ids" | wc -l | tr -d ' ') container(s) running"; return
    fi
    before=$(version "$plist")
    say "Docker Desktop: docker desktop update --quiet ($due)"
    out=$(run 1200 docker desktop update --quiet < /dev/null 2>&1); urc=$?
    [ "$urc" -eq 0 ] || add F "Docker Desktop: \`docker desktop update --quiet\` failed (exit $urc; 124 or 137 is the 20 min timeout): $out"
    t=$(bound 600); deadline=$(($(date +%s) + t))
    until run 30 docker info < /dev/null > /dev/null 2>&1; do
        if [ "$(date +%s)" -ge "$deadline" ]; then
            add F "Docker Desktop: \`docker info\` did not answer within ${t}s after the update"; return
        fi
        sleep 5
    done
    after=$(version "$plist")
    [ "$urc" -eq 0 ] || return
    touch "$dstamp"
    if [ "$after" != "$before" ]; then
        add C "Docker Desktop updated, $before -> $after"
    else
        say "Docker Desktop: up to date ($before)"
    fi
}

# --- The pass ------------------------------------------------------------------

herdr_app
squirrel_app "T3 Code" com.t3tools.t3code "T3 Code (Beta).app"
squirrel_app Fastmail com.fastmail.mac.Fastmail Fastmail.app
squirrel_app 1Password com.1password.1password 1Password.app "; now locked: \`op\` fails until 1Password is unlocked"
claude_app
chrome_app
appcast_app Downie com.charliemonroe.Downie-4 "Downie 4.app"
appcast_app Ghostty com.mitchellh.ghostty Ghostty.app " (the job never quits Ghostty: a quit closes its shells)"
docker_app

touch "$stamp"
say "pass complete"

[ -n "$F$C$M" ] || { rm -f "$marker"; say "nothing to report; no mail"; exit 0; }

body="App update pass on $host, $(date '+%F %R')."
for s in "Failed:F" "Updated or relaunched:C" "Relaunch by hand:M" "Warnings:W"; do
    eval "v=\${${s##*:}}"
    [ -z "$v" ] || body="$body$nl$nl${s%:*}:$nl${v%"$nl"}"
done
body="$body$nl${nl}Log: ~/.cron/logs/app-update.log"
subject="App updates on $host"
[ -z "$F" ] || subject="$subject: FAILED"
mailed=yes
send_mail "$subject" "$body" || mailed=no

if [ -n "$F" ]; then
    first=$(printf '%s' "$F" | head -n 1); first=${first#- }
    n=$(printf '%s' "$F" | grep -c '^- ')
    more=; [ "$n" -le 1 ] || more=" (and $((n - 1)) more)"
    note=; [ "$mailed" = yes ] || note="; the report mail failed too"
    printf '%s app-update: %s%s%s (see ~/.cron/logs/app-update.log)\n' "$(date '+%F %R')" "$first" "$more" "$note" > "$marker"
    exit 1
fi
if [ "$mailed" = no ]; then
    printf '%s app-update: the report mail failed (see ~/.cron/logs/app-update.log)\n' "$(date '+%F %R')" > "$marker"
    exit 1
fi
rm -f "$marker"
exit 0
