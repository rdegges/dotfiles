# Shared text cleaning for the ~/.cron jobs. Sourced, never run: each job that
# calls oneline loads it right after its variables, with a loader that writes
# the job's FAILED marker and exits 1 when this file is missing, unreadable,
# or does not parse.
#
# This file only sets esc and bel and defines oneline. It runs no other
# command and changes no `set` option.
#
# Every job used to carry its own copy of oneline, and each copy had its own
# bug: a multi-byte character cut in half, BSD tr stopping at an invalid byte,
# color codes that left fragments such as `[31m`. One copy, tested once, ends
# that. tests/cron/text-lib.test.mjs fails a job that cleans text itself.

esc=$(printf '\033')
bel=$(printf '\007')

# oneline <text>: print <text> as one line of printable ASCII, at most 300
# bytes, for a FAILED marker, a mail, or a state file.
#
# The hard guarantees (one line, printable ASCII, at most 300 bytes) come from
# the tr and cut stages, for any input. Stripping escape sequences only keeps
# the text readable; it covers only the forms below, and the bytes of any
# other form are still cut down to printable ASCII.
#
# The stages, in order:
#   1. Newline, tab, and CR become spaces.
#   2. Escape sequences go, before the ASCII filter, which would drop the ESC
#      and keep the rest (`[31m`), and before the cut, so color codes do not
#      use up the 300 bytes:
#      - CSI: ESC [, then parameter bytes 0-?, then intermediate bytes
#        space-/, then one final byte @-~ (ECMA-48). This covers SGR colors,
#        `38:5:196` sub-parameters, and private modes such as `>4;2`.
#      - OSC ending in BEL or in ST (ESC \): window titles, OSC 8 links.
#      - Any other ESC, intermediate bytes space-/, one final byte 0-~:
#        ESC ( B, ESC 7, ESC =.
#      Each form is its own sed expression: BSD sed (macOS) has no \| in a BRE.
#   3. Only printable ASCII (space to ~) stays.
#   4. Cut at 300 bytes.
# Every stage runs with LC_ALL=C. Cron and launchd set no LANG, but a job run
# from a shell inherits a UTF-8 locale: BSD tr then stops at the first invalid
# byte, sed ranges stop being byte ranges, and cut can split a character.
oneline() {
    printf '%s' "$1" \
        | LC_ALL=C tr '\n\t\r' '   ' \
        | LC_ALL=C sed \
            -e "s|${esc}\[[0-?]*[ -/]*[@-~]||g" \
            -e "s|${esc}][^${bel}${esc}]*${bel}||g" \
            -e "s|${esc}][^${bel}${esc}]*${esc}\\\\||g" \
            -e "s|${esc}[ -/]*[0-~]||g" \
        | LC_ALL=C tr -cd '\40-\176' \
        | LC_ALL=C cut -c1-300
}
