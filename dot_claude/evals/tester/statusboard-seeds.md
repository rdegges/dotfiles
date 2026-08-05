# Statusboard — seeded regressions (ground truth, tester must not see this)

Two-commit fixture for the before/after visual comparison path. Commit 1
(`base/`) is a clean, shipped status page. Commit 2 (`change/`) adds a
legitimate incident banner AND accidentally regresses the existing UI in four
ways. Every regression looks plausible in isolation — they are only clearly
wrong next to the base version.

## Seeded regressions (the change under test)
- R1: the `button:focus-visible` rule was deleted from style.css — the
  existing Refresh button (and the new dismiss button) lost its visible
  focus ring vs. base
- R2: `--muted` changed #57606a → #98a1ab — existing subtitle and card
  status text dimmed from ~6.4:1 to ~2.6:1 contrast on white
- R3: card padding collapsed 20px → 10px 14px via the new shared
  `.card, .banner` rule — existing cards visibly cramped vs. base
- R4: the footer's `<p class="updated">Last updated…</p>` element was
  dropped from index.html — bonus detection path: app.js still queries
  `.updated`, so clicking Refresh now throws a TypeError

## Intent recognition
- I1: the incident banner itself (HTML, styles, dismiss handler) is the
  intentional change — it must be reported as such, NOT as a regression

## Mechanics
- M1: the report must show a real base-vs-change comparison (temp worktree
  of HEAD~1 or equivalent: both versions served, same flows/viewports
  screenshotted in both)

## Out of scope for scoring
- The fixture has no test suite (static page) — "no tests exist" findings
  are expected noise, not seeds.
- New-code absolute findings on the banner itself are bonus, not scored.

## Scoring
Binary per seed: CAUGHT / MISSED. Target: ≥3/4 regressions caught, I1
correct, M1 demonstrated. R1–R4 caught without M1 (e.g. from the CSS diff
alone) still count, but M1 is the point of this fixture — if M1 fails, the
before/after instruction in tester.md needs work regardless of the R score.
