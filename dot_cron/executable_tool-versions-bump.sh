#!/bin/sh
# Propose new asdf pins: open (or refresh) one pull request that moves each
# tool in dot_tool-versions to its newest release.
#
# Nothing else moves the pins, so they went stale for months. A pull request,
# not a direct commit: a new Python or Go minor can break a project, so I
# decide when it lands. After the merge, the hourly `chezmoi update` installs
# the new versions on every Mac (run_onchange_install-tool-versions.sh.tmpl).
#
# It works through the GitHub API only and never touches a working tree: the
# chezmoi source stays on main, clean. The daily update job runs it
# (update.sh), on personal Macs only (.chezmoiignore).
#
# "Newest" keeps the shape of the pin: digits and dots, then the pin's letter
# suffix (the "t" of free-threaded Python). A tool whose newest release cannot
# be read fails the run; no pin is ever guessed or lowered on purpose.
#
# TOOL_VERSIONS_REPO overrides the repository, for a test.

set -u

repo="${TOOL_VERSIONS_REPO:-rdegges/dotfiles}"
file=dot_tool-versions
branch=bump-tool-versions

fail() {
    printf '%s\n' "tool-versions-bump: FAILED: $1"
    exit 1
}

command -v gh >/dev/null 2>&1 || fail "gh not found on PATH"
command -v asdf >/dev/null 2>&1 || fail "asdf not found on PATH"

# newest <tool> <pin>
newest() {
    suffix=$(printf '%s' "$2" | sed 's/^[0-9.]*//')
    case "$suffix" in *[!A-Za-z]*) return 1 ;; esac
    asdf list all "$1" 2>/dev/null | grep -E "^[0-9]+(\.[0-9]+)*$suffix\$" | sort -V | tail -1
}

# raw <ref>: the file's text at a ref. blob <ref>: its blob SHA.
raw() { gh api -H 'Accept: application/vnd.github.raw' "repos/$repo/contents/$file?ref=$1"; }
blob() { gh api "repos/$repo/contents/$file?ref=$1" --jq .sha; }

current=$(raw main) || fail "cannot read $file on main"
[ -n "$current" ] || fail "$file on main is empty"

next=
changes=
nl='
'
while read -r tool pin rest; do
    case "$tool" in
        '' | \#*) next="$next$tool${pin:+ $pin}${rest:+ $rest}$nl"; continue ;;
    esac
    new=$(newest "$tool" "$pin") || new=
    [ -n "$new" ] || fail "cannot read the newest release of $tool (pin $pin)"
    # Never lower a pin: the newest of the two wins.
    top=$(printf '%s\n%s\n' "$pin" "$new" | sort -V | tail -1)
    if [ "$top" != "$pin" ]; then
        changes="$changes- $tool $pin -> $top$nl"
        pin=$top
    fi
    next="$next$tool $pin${rest:+ $rest}$nl"
done <<TOOLS
$current
TOOLS

if [ -z "$changes" ]; then
    printf '%s\n' "tool-versions-bump: ok: every pin is the newest release"
    exit 0
fi
printf '%s' "$changes"

pr=$(gh pr list -R "$repo" --head "$branch" --state open --json number --jq '.[0].number') \
    || fail "cannot list pull requests"

if [ -n "$pr" ]; then
    onbranch=$(raw "$branch") || fail "cannot read $file on $branch"
    if [ "$onbranch$nl" = "$next" ] || [ "$onbranch" = "$next" ]; then
        printf '%s\n' "tool-versions-bump: ok: pull request #$pr already has these pins"
        exit 0
    fi
else
    # A branch left from a merged or closed pull request starts again from main.
    gh api -X DELETE "repos/$repo/git/refs/heads/$branch" >/dev/null 2>&1
    head=$(gh api "repos/$repo/git/ref/heads/main" --jq .object.sha) || fail "cannot read the main ref"
    gh api "repos/$repo/git/refs" -f "ref=refs/heads/$branch" -f "sha=$head" >/dev/null \
        || fail "cannot create the branch $branch"
fi

sha=$(blob "$branch") || fail "cannot read the blob of $file on $branch"
gh api -X PUT "repos/$repo/contents/$file" \
    -f "message=Bump the asdf pins to the newest releases" \
    -f "content=$(printf '%s' "$next" | base64 | tr -d '\n')" \
    -f "sha=$sha" -f "branch=$branch" >/dev/null \
    || fail "cannot write $file on $branch"

body="The daily update job found newer releases for these asdf pins:

$changes
After the merge, the hourly \`chezmoi update\` installs them on every Mac."

if [ -n "$pr" ]; then
    gh pr edit "$pr" -R "$repo" --body "$body" >/dev/null || fail "cannot update pull request #$pr"
    printf '%s\n' "tool-versions-bump: ok: updated pull request #$pr"
else
    url=$(gh pr create -R "$repo" --head "$branch" --base main \
        --title "Bump the asdf pins to the newest releases" --body "$body") \
        || fail "cannot open the pull request"
    printf '%s\n' "tool-versions-bump: ok: opened $url"
fi
