#!/bin/sh
# Wait until the network is up, for the launchd jobs that need it.
#
# launchd runs a job the Mac slept through as soon as the Mac wakes, before
# Wi-Fi and DNS are back. The job then failed on "Could not resolve host" and
# wrote its FAILED marker for nothing. The jobs call this first and skip the
# run when it exits 1.
#
# Up means a default route exists and the system resolver returns an address
# for github.com. dscacheutil asks the same resolver that ssh, curl, and npm
# use (host and dig do not). It exits 0 even when the lookup fails, so its
# output decides.
#
# Exit 0: up. Exit 1: still down after WAIT_FOR_NETWORK_TIMEOUT seconds
# (default 60). Exit 2: cannot evaluate (route or dscacheutil not found, output
# this script cannot read, or a bad timeout); the caller then runs the job as
# before.

set -u

timeout="${WAIT_FOR_NETWORK_TIMEOUT:-60}"
host=github.com

case "$timeout" in
    '' | *[!0-9]* | ???????*) echo "wait-for-network: bad WAIT_FOR_NETWORK_TIMEOUT: $timeout" >&2; exit 2 ;;
esac

# The launchd plist PATH has no /sbin, and macOS ships route only as /sbin/route.
PATH="$PATH:/usr/sbin:/sbin"

for tool in route dscacheutil; do
    command -v "$tool" >/dev/null 2>&1 \
        || { echo "wait-for-network: $tool not found; cannot check" >&2; exit 2; }
done

# Sets route_ok and dns_ok to yes or no. Exits 2 on output it cannot read.
probe() {
    route_ok=no
    dns_ok=no
    # No default route: macOS route prints "not in table" on stderr and
    # nothing on stdout, and exits 0. A non-zero exit also counts as no route.
    # Only stdout with no interface: line is output this script cannot read.
    if out=$(route -n get default 2>/dev/null) && [ -n "$out" ]; then
        case "$out" in
            *interface:*) route_ok=yes ;;
            *) echo "wait-for-network: cannot read 'route -n get default' output" >&2; exit 2 ;;
        esac
    fi
    out=$(dscacheutil -q host -a name "$host" 2>/dev/null) \
        || { echo "wait-for-network: dscacheutil failed" >&2; exit 2; }
    if printf '%s\n' "$out" | grep -Eq '^(ip|ipv6)_address: '; then
        dns_ok=yes
    elif [ -n "$out" ]; then
        echo "wait-for-network: cannot read dscacheutil output" >&2
        exit 2
    fi
}

waited=0
while :; do
    probe
    if [ "$route_ok" = yes ] && [ "$dns_ok" = yes ]; then
        [ "$waited" -gt 0 ] && echo "wait-for-network: up after ${waited}s"
        exit 0
    fi
    if [ "$waited" -ge "$timeout" ]; then
        echo "wait-for-network: down after ${waited}s (default route: $route_ok, $host DNS: $dns_ok)"
        exit 1
    fi
    sleep 2
    waited=$((waited + 2))
done
