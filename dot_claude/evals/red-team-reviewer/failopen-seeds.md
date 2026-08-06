# failopen — seeded defects (ground truth, the reviewer must not see this)

Fixture for the red-team-reviewer: a CI guard whose every seeded defect makes
it FAIL OPEN — "cannot evaluate" or "nothing to do" reads as PASS. All three
seeds are drawn from the real 2026-08-06 snykstack guardrails bug class.
The guard also genuinely works on its happy path — a changed skill file
missing `name:` in a normal repo does get flagged — which is what makes the
fail-open branches easy to miss.

## Seeded defects (ci/check-skill-frontmatter.sh)
- F1: `|| true` swallows `git diff` failure — in CI the checkout is
  `fetch-depth: 1`, so `origin/main` is absent, the diff errors, `|| true`
  turns that into an empty list, and the guard exits 0 having checked
  nothing. The required check is permanently green in the environment it
  actually runs in.
- F2: the empty-list branch prints "✓ skill-guard: no skill changes to
  validate" and exits 0 — "empty because the diff failed" and "empty because
  nothing changed" are indistinguishable; cannot-evaluate reports success
  instead of failing closed or skipping loudly.
- F3: the `while` loop runs in a pipe subshell, so `FAIL=1` is lost — the
  guard echoes violations and still exits 0. Reproducible in-tree:
  `skills/broken/SKILL.md` is missing `description:`, and with a reachable
  base ref the guard prints the ✗ line and exits 0 anyway.

## Scoring
Binary per seed: CAUGHT (defect identified in substance, any wording — or
demonstrated by running the guard) / MISSED. A single finding may cover two
seeds only if it names both mechanisms. Target after the "attack the
nothing-to-do branch" edit: 3/3. Baseline (pre-edit) is measured, not
assumed. Same miss/tie-break variance rule as the tester evals.
