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
# 7 days. The 7 days count from the last pass (app-update.ok), or, when no
# pass has ever completed, from the first skip (app-update.since).
#
# The pass. Each app is found by its exact bundle id: the Info.plist must name
# it, and the PID comes from `lsappinfo info -app <bundle id>`, whose output
# must name the same bundleID (lsappinfo also matches app names, and a match on
# the name "claude" would be a Claude Code CLI session). Nothing is found by
# process name, nothing is sent to a process this job did not find that way,
# and no Apple Events are used (TCC). A quit is `kill -TERM` to the app's main
# PID, then a wait of at most 60s; never SIGKILL. A relaunch is
# `open -g -b <bundle id>` and a check for a new PID within 60s.
#   - Herdr (relaunch; herdr_class below can make it report only): pending =
#     /Applications/Herdr.app.new.noindex. As measured (0.1.13 to 0.1.15), the
#     agent shells are children of `herdr-core hold`, which outlives the
#     relaunch: launchd becomes its parent, and its PID and socket stay.
#     Herdr.app's launch restarts `herdr-core --hc-launchd`, a broker that owns
#     no shell, and applies the staged bundle. So the job records each hold
#     (PID and args, which carry --socket) before the quit, and runs `open` as
#     soon as Herdr.app exits. After the relaunch it waits at most 60s for
#     Herdr.app.new.noindex to go (FAILED when it stays), then 15s for the
#     broker restart. A hold that is gone or has other args is FAILED ("hold
#     ended, sessions lost"), and so is no broker; a new broker PID is only
#     logged. No hold found: not relaunched. A `herdr-core connect` client
#     from outside Herdr.app (a terminal or an SSH session) that the relaunch
#     ends is mailed for a reattach by hand.
#   - T3 Code, Fastmail, 1Password (relaunch, Squirrel): pending =
#     ~/Library/Caches/<bundle id>.ShipIt/ShipItState.plist exists and the
#     update bundle that its updateBundleURL names exists. Squirrel never
#     deletes the plist; ShipIt moves or deletes the update bundle when it
#     installs. After the app exits, wait at most 120s until no ShipIt process
#     for that bundle id runs and the update bundle is gone; then `open`. An
#     `open` while ShipIt still swaps the bundle can start a half-installed
#     app. When the 120s run out, wait at most 60s more for ShipIt to exit,
#     then `open` anyway and write FAILED: the job never leaves an app it quit
#     down. 1Password comes back locked, so `op` fails until someone unlocks
#     it; the mail says so.
#   - Claude Desktop (relaunch only with no session): Squirrel, as above. Not
#     relaunched when a `claude` process descends from Claude.app, or when a
#     file under claude-code-sessions/ or local-agent-mode-sessions/, or
#     vm_bundles/claudevm.bundle/rootfs.img, changed in the last 60 min. If
#     this cannot be checked, it is reported, not relaunched.
#   - Chrome (report only; a quit loses tabs): the bundle version against the
#     framework version that the running Chrome's helpers use. Chrome's updater
#     replaces the bundle in place, so a difference is a staged update.
#   - Downie and Ghostty (report only; a Ghostty quit closes its shells):
#     SUFeedURL from Info.plist (Ghostty's has none, so its published feed is
#     the fallback), fetched with curl (20s), newest dotted-number
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
# along in such a mail but do not send one. The "relaunch by hand" list of the
# last mail is kept in app-update.reported; a night with only that same list
# sends no mail. A failure writes ~/.cron/logs/app-update.FAILED (replaced,
# never appended), which every new shell prints (dot_zshrc), and exits 1. So
# does a mail that cannot be sent. A completed pass touches app-update.ok,
# also when an app failed: a failed relaunch is not retried the same night.
# Only a pass with no failure removes the marker.
#
# An app that the job quit and could not bring back goes into
# ~/.cron/logs/app-update.down (bundle id and date). Each pass first checks
# that list: an app that runs again leaves it, and one that still does not is
# FAILED again, so a later quiet night cannot hide it.
#
# launchd appends to app-update.log. The run that does the pass empties it
# first, so the later "already ran today" runs add one line each and the pass
# log stays.
#
# APP_UPDATE_ANY_HOUR=1 skips the hour guard. APP_UPDATE_MAIL_ACCOUNT replaces
# the himalaya account (default icloud), for a forced mail failure. For tests
# only: APP_UPDATE_APPS replaces /Applications, and APP_UPDATE_WAIT replaces
# every bound() wait: the 15s broker wait, the 60s waits (staged bundle, new
# PID, quit, ShipIt grace), the 120s ShipIt wait, and the 10 min wait (the 20
# min bound on the Docker update stays).

set -u

apps="${APP_UPDATE_APPS:-/Applications}"
logs="$HOME/.cron/logs"
marker="$logs/app-update.FAILED"
stamp="$logs/app-update.ok"
since="$logs/app-update.since"
dstamp="$logs/app-update-docker.ok"
down="$logs/app-update.down"
reported="$logs/app-update.reported"
# Herdr: herdr_class "relaunch" quits and reopens Herdr.app when an update is
# staged; "report" only mails that one is staged.
herdr_class=relaunch
# The himalaya account "icloud" is the Fastmail-backed r@rdegges.com account;
# the name is historical (see dot_config/himalaya/config.toml.tmpl).
account="${APP_UPDATE_MAIL_ACCOUNT:-icloud}"
rcpt=r@rdegges.com
nl='
'

# oneline (lib/text.sh) turns CLI output into one marker or mail line. A
# missing, broken, or incomplete lib writes the marker and exits 1.
lib="$(dirname "$0")/lib/text.sh"
if [ -r "$lib" ] && sh -n "$lib" 2>/dev/null && command . "$lib" && command -v oneline >/dev/null 2>&1; then :; else
    printf '%s\n' "app-update: cannot load $lib"
    mkdir -p "${marker%/*}"
    printf '%s\n' "$(date '+%F %R') app-update: cannot load ~/.cron/lib/text.sh; run chezmoi apply" > "$marker"
    exit 1
fi

# The launchd plist PATH has no /usr/sbin, and macOS ships ioreg and sysctl
# only there.
PATH="$PATH:/usr/sbin:/sbin"

mkdir -p "$logs"

# The loader's pattern: bounded when coreutils' timeout is installed, unbounded
# otherwise. run <seconds> <cmd...>
TO=$(command -v gtimeout || command -v timeout || true)
run() { s=$1; shift; if [ -n "$TO" ]; then "$TO" -k 5 "$s" "$@"; else "$@"; fi; }

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
# marker shows yet, write one and mail once. The 7 days count from the last
# pass, or from the first skip when no pass has ever completed.
skip() {
    say "skipped: $1"
    if [ ! -e "$stamp" ] && [ ! -e "$since" ] && touch "$since"; then
        say "no pass has completed yet; the 7-day stale clock starts now"
        exit 0
    fi
    clock=$stamp
    [ -e "$stamp" ] || clock=$since
    if [ ! -e "$marker" ] && [ -z "$(find "$clock" -mmin -10080 2>/dev/null)" ]; then
        why="no completed pass in the last 7 days; the last skip was: $(oneline "$1")"
        note=
        send_mail "App updates stalled on $host" "The nightly app update on $host has not completed a pass in the last 7 days (~/.cron/logs/app-update.ok is older than 7 days, or no pass has ever completed and the first skip, recorded in ~/.cron/logs/app-update.since, was 7 or more days ago).

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

# The plist appends (>>), so the later runs of the night add their "already
# ran today" line instead of wiping this log. This run starts it fresh.
: > "$logs/app-update.log"
say "run at $(date '+%F %R')"

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

# herdr_core <Herdr.app PID>: list the herdr-core processes (exact basename),
# or return 1 when ps fails. Sets:
#   hc_hold    one "<pid> <args>" line per `herdr-core hold`, sorted; the
#              args carry --socket. These own the agent shells.
#   hc_broker  the PIDs of `herdr-core --hc-launchd`, the broker ('' if none).
#   hc_client  the PIDs of `herdr-core connect` whose parent is not
#              Herdr.app: clients in a terminal.
herdr_core() {
    out=$(ps -A -o pid= -o ppid= -o args= 2>/dev/null) || return 1
    out=$(printf '%s\n' "$out" | awk -v app="$1" '{
        n = split($3, p, "/"); if (p[n] != "herdr-core") next
        a = $0; sub(/^ *[0-9]+ +[0-9]+ +/, "", a)
        if ($4 == "hold") print "H " $1 " " a
        else if ($4 == "--hc-launchd") print "L " $1
        else if ($4 == "connect" && $2 != app) print "C " $1
    }' | sort)
    hc_hold=$(printf '%s\n' "$out" | sed -n 's/^H //p')
    hc_broker=$(printf '%s\n' "$out" | sed -n 's/^L //p' | tr '\n' ' ' | sed 's/ $//')
    hc_client=$(printf '%s\n' "$out" | sed -n 's/^C //p' | tr '\n' ' ' | sed 's/ $//')
}

# shipit_update <bundle id>: set $upd to the update bundle that the app's
# ShipItState.plist names (updateBundleURL, a file:// URL). Return 0 when that
# bundle exists (an update waits), 1 when it does not or there is no plist,
# and 2 when the plist cannot be read.
shipit_update() {
    upd=
    st="$HOME/Library/Caches/$1.ShipIt/ShipItState.plist"
    [ -e "$st" ] || return 1
    u=$(plutil -extract updateBundleURL raw -o - "$st" 2>/dev/null) || return 2
    case "$u" in file:///*) ;; *) return 2 ;; esac
    upd=$(printf '%s' "${u#file://}" | sed 's/%20/ /g')
    upd=${upd%/}
    [ -n "$upd" ] && [ -e "$upd" ]
}

# app_name <bundle id>: the name the mail uses for an app the job relaunches.
app_name() {
    case "$1" in
        dev.herdr.app) printf '%s\n' Herdr ;;
        com.t3tools.t3code) printf '%s\n' "T3 Code" ;;
        com.fastmail.mac.Fastmail) printf '%s\n' Fastmail ;;
        com.1password.1password) printf '%s\n' 1Password ;;
        com.anthropic.claudefordesktop) printf '%s\n' "Claude Desktop" ;;
        *) printf '%s\n' "$1" ;;
    esac
}

# left_down <bundle id>: the job quit this app and could not bring it back.
left_down() { printf '%s %s\n' "$1" "$(date '+%F %R')" >> "$down"; }

# check_down: for each app in app-update.down, drop it when it runs again, or
# add FAILED again when it still does not.
check_down() {
    [ -s "$down" ] || { rm -f "$down"; return 0; }
    keep=
    while read -r did when <&3; do
        [ -n "$did" ] || continue
        dname=$(app_name "$did")
        if app_pid "$did" && [ -n "$pid" ]; then
            say "$dname: runs again (the job left it down at $when)"
            continue
        fi
        add F "$dname: still not running since $when; the job quit it${err:+ ($err)}"
        keep="$keep$did $when$nl"
    done 3< "$down"
    if [ -n "$keep" ]; then printf '%s' "$keep" > "$down"; else rm -f "$down"; fi
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
    if [ "$kind" = herdr ]; then
        herdr_core "$old" || { add M "$name: update staged; not relaunched: ps cannot list the herdr-core processes; relaunch by hand"; return; }
        if [ -z "$hc_hold" ]; then
            add M "$name: update staged; not relaunched: no herdr-core hold found, so the job cannot prove the sessions survive; relaunch by hand"; return
        fi
        hold_before=$hc_hold broker_before=$hc_broker client_before=$hc_client
        say "$name: herdr-core hold before: ${hc_hold//$nl/, }"
        say "$name: herdr-core --hc-launchd before: ${hc_broker:-none}; connect clients outside Herdr.app: ${hc_client:-none}"
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
        # Done: no ShipIt for this bundle, and the update bundle ($upd, set by
        # shipit_update) is gone. ShipItState.plist stays: Squirrel never
        # deletes it.
        t=$(bound 120); deadline=$(($(date +%s) + t)); late=
        while shipit_busy "$id" || [ -e "$upd" ]; do
            if [ "$(date +%s)" -ge "$deadline" ]; then late=$t; break; fi
            sleep 1
        done
        if [ -n "$late" ]; then
            # Never leave the app down: once no ShipIt for it runs (at most
            # another 60s), start it anyway.
            t=$(bound 60); deadline=$(($(date +%s) + t))
            while shipit_busy "$id" && [ "$(date +%s)" -lt "$deadline" ]; do sleep 1; done
            if shipit_busy "$id"; then why="ShipIt still runs"; else why="the update bundle is still there"; fi
            add F "$name: ShipIt did not finish within ${late}s ($why); started anyway"
        fi
    fi

    if ! out=$(run 30 open -g -b "$id" < /dev/null 2>&1); then
        add F "$name: quit, but \`open -g -b $id\` failed: $out"
        left_down "$id"
        return
    fi
    t=$(bound 60); deadline=$(($(date +%s) + t))
    while :; do
        if app_pid "$id" && [ -n "$pid" ] && [ "$pid" != "$old" ]; then break; fi
        if [ "$(date +%s)" -ge "$deadline" ]; then
            add F "$name: quit and \`open -g -b $id\` ran, but the app was not running ${t}s later"
            left_down "$id"
            return
        fi
        sleep 1
    done

    noapply=
    if [ "$kind" = herdr ]; then
        # Herdr.app applies the staged bundle when it launches, not when it
        # quits, so this wait comes after `open`.
        t=$(bound 60); deadline=$(($(date +%s) + t))
        while [ -e "$apps/Herdr.app.new.noindex" ]; do
            if [ "$(date +%s)" -ge "$deadline" ]; then
                add F "$name: relaunched, but the staged update did not apply (still at Herdr.app.new.noindex after ${t}s)"
                noapply=yes
                break
            fi
            sleep 1
        done
        # The launch restarts the --hc-launchd broker (about 2s after `open`,
        # as measured). Compare only after that.
        t=$(bound 15)
        sleep "$t"
        up=yes
        if ! app_pid "$id" || [ -z "$pid" ]; then
            add F "$name: relaunched, but the app was not running ${t}s later${err:+ ($err)}"
            left_down "$id"
            up=no
        fi
        if herdr_core "$pid"; then
            hold_after=${hc_hold//$nl/, }
            say "$name: herdr-core hold after: ${hold_after:-none}"
            # Each hold must still run with the same args; a new one is fine.
            lost=
            while IFS= read -r h; do
                [ -z "$h" ] || printf '%s\n' "$hc_hold" | grep -F -x -q -- "$h" || lost=yes
            done <<< "$hold_before"
            [ -z "$lost" ] || add F "$name: herdr-core hold ended, sessions lost (before: ${hold_before//$nl/, }; after: ${hold_after:-none})"
            if [ -z "$hc_broker" ]; then
                add F "$name: no herdr-core --hc-launchd server after the relaunch; sessions unreachable until it starts"
            elif [ "$hc_broker" != "$broker_before" ]; then
                say "$name: herdr-core --hc-launchd restarted ($broker_before -> $hc_broker); expected, not a failure"
            fi
            gone=
            for c in $client_before; do
                case " $hc_client " in *" $c "*) ;; *) gone="$gone $c" ;; esac
            done
            [ -z "$gone" ] || add M "$name: terminal clients attached with herdr-core connect were detached (PIDs ${gone# }); sessions survive in hold; reattach"
        else
            add F "$name: relaunched, but ps cannot list the herdr-core processes, so the job cannot prove the sessions survive"
        fi
        [ "$up" = yes ] || return
    fi

    after=$(version "$plist")
    if [ "$after" != "$before" ]; then
        add C "$name updated and relaunched, $before -> $after$extra"
    elif [ -z "$noapply" ]; then
        add C "$name relaunched, but the version is unchanged ($before): WARNING, the staged update did not apply$extra"
    fi
}

# squirrel_pending <name> <bundle id>: return 0 when a Squirrel update waits
# ($upd is its bundle); say why not and return 1 otherwise.
squirrel_pending() {
    shipit_update "$2"
    case $? in
        0) return 0 ;;
        1) say "$1: no update staged" ;;
        *) add M "$1: cannot read updateBundleURL from its ShipItState.plist; not relaunched; relaunch by hand if an update waits" ;;
    esac
    return 1
}

squirrel_app() { # squirrel_app <name> <bundle id> <bundle> [note]
    installed "$1" "$2" "$3" || return
    squirrel_pending "$1" "$2" || return
    app_pid "$2" || { add F "$1: update staged, but its PID cannot be read ($err); not relaunched"; return; }
    if [ -z "$pid" ]; then add M "$1: update staged, but the app is not running; not started; start it by hand"; return; fi
    relaunch "$1" "$2" shipit "${4:-}"
}

herdr_app() {
    installed Herdr dev.herdr.app Herdr.app || return
    if [ ! -e "$apps/Herdr.app.new.noindex" ]; then say "Herdr: no update staged"; return; fi
    staged=$(version "$apps/Herdr.app.new.noindex/Contents/Info.plist")
    if [ "$herdr_class" != relaunch ]; then add M "Herdr: update staged ($staged); relaunch by hand"; return; fi
    app_pid dev.herdr.app || { add F "Herdr: update staged, but its PID cannot be read ($err); not relaunched"; return; }
    if [ -z "$pid" ]; then add M "Herdr: update staged ($staged), but Herdr.app is not running; not started; start it by hand"; return; fi
    relaunch Herdr dev.herdr.app herdr
}

claude_app() {
    n="Claude Desktop" id=com.anthropic.claudefordesktop
    installed "$n" "$id" Claude.app || return
    squirrel_pending "$n" "$id" || return
    app_pid "$id" || { add F "$n: update staged, but its PID cannot be read ($err); not relaunched"; return; }
    if [ -z "$pid" ]; then add M "$n: update staged, but the app is not running; not started; start it by hand"; return; fi
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

# appcast_app <name> <bundle id> <bundle> [note] [fallback feed]: the fallback
# feed is used only when Info.plist has no SUFeedURL.
appcast_app() {
    installed "$1" "$2" "$3" || return
    inst=$(version "$plist")
    feed=$(plutil -extract SUFeedURL raw -o - "$plist" 2>/dev/null) || feed=
    if [ -z "$feed" ]; then
        feed=${5:-}
        if [ -z "$feed" ]; then add W "$1: could not check (no SUFeedURL in its Info.plist)"; return; fi
        say "$1: no SUFeedURL in its Info.plist; using $feed"
    fi
    case "$feed" in
        https://*) ;;
        *) add W "$1: could not check (SUFeedURL is not https: $feed)"; return ;;
    esac
    if ! body=$(run 25 curl -fsSL --max-time 20 "$feed" < /dev/null 2>&1); then
        add W "$1: could not check (fetch of $feed failed: $body)"; return
    fi
    # Only dotted numbers count: Ghostty's feed also has build labels such as
    # "663205b5 (2024-12-20)", which are not versions.
    newest=
    for v in $(printf '%s\n' "$body" | grep -o -e 'sparkle:shortVersionString="[^"]*"' -e '<sparkle:shortVersionString>[^<]*' \
        | sed -e 's/^sparkle:shortVersionString="//' -e 's/"$//' -e 's/^<sparkle:shortVersionString>//' | grep -E '^[0-9]+(\.[0-9]+)*$'); do
        if [ -z "$newest" ] || vnewer "$v" "$newest"; then newest=$v; fi
    done
    if [ -z "$newest" ]; then add W "$1: could not check (no dotted version number in the appcast at $feed)"; return; fi
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

check_down
herdr_app
squirrel_app "T3 Code" com.t3tools.t3code "T3 Code (Beta).app"
squirrel_app Fastmail com.fastmail.mac.Fastmail Fastmail.app
squirrel_app 1Password com.1password.1password 1Password.app "; now locked: \`op\` fails until 1Password is unlocked"
claude_app
chrome_app
appcast_app Downie com.charliemonroe.Downie-4 "Downie 4.app"
appcast_app Ghostty com.mitchellh.ghostty Ghostty.app " (the job never quits Ghostty: a quit closes its shells)" \
    https://release.files.ghostty.org/appcast.xml
docker_app

touch "$stamp"
rm -f "$since"
say "pass complete"

if [ -z "$F$C" ]; then
    if [ -z "$M" ]; then
        rm -f "$marker" "$reported"
        say "nothing to report; no mail"
        exit 0
    fi
    # The same "relaunch by hand" list as the last mail: no new mail.
    if [ -f "$reported" ] && [ "$(cat "$reported")" = "${M%"$nl"}" ]; then
        say "the same items as the last mail need a hand; no mail"
        exit 0
    fi
fi

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
if [ "$mailed" = yes ]; then
    if [ -n "$M" ]; then printf '%s' "$M" > "$reported"; else rm -f "$reported"; fi
fi

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
