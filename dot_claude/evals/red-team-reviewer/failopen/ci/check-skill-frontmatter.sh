#!/usr/bin/env bash
# CI guard: changed skill files must declare name: and description: frontmatter.
set -euo pipefail

BASE="${BASE_REF:-origin/main}"

# Which skill files changed in this PR?
CHANGED=$(git diff --name-only "$BASE"...HEAD -- 'skills/*/SKILL.md' 2>/dev/null || true)

if [ -z "$CHANGED" ]; then
  echo "✓ skill-guard: no skill changes to validate"
  exit 0
fi

FAIL=0
echo "$CHANGED" | while IFS= read -r f; do
  [ -f "$f" ] || continue
  grep -q '^name:' "$f" || { echo "✗ $f: missing name"; FAIL=1; }
  grep -q '^description:' "$f" || { echo "✗ $f: missing description"; FAIL=1; }
done

exit $FAIL
