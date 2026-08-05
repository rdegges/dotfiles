# Tipsy — seeded defects (ground truth, tester must not see this)

## Logic bugs (src/tip.js, app.js)
- L1: split=0 → division by zero → Infinity, rendered as "$Infinity"
- L2: no input validation — negative bill / negative tip accepted silently
- L3: Math.floor on perPerson loses cents: perPerson*split < total (e.g. 100 total / 3 = 33.33 each = 99.99)
- L4: empty/NaN inputs → "$NaN" rendered in the UI (app.js does no validation)

## Weak tests (test/tip.test.js)
- T1: "returns numeric results" only asserts typeof === number, not values
- T2: "handles splitting between people" is a tautology (assert.ok(true))
- T3: suite is happy-path only — no edge cases at all (may be reported merged with L1-L4)

## Visual/UX seeds (style.css, index.html)
- V1: .container fixed width: 640px → horizontal overflow/scroll on mobile viewport
- V2: .result color #c7c7c7 on white — unreadable low contrast for the money amounts
- V3: button has outline: none and no :focus style — keyboard focus invisible
- V4: .result-value overflow: hidden + max-width: 140px → large amounts clipped with no ellipsis
- V5: dark scheme media query sets dark backgrounds but never sets text color → #222-on-#16181d unreadable in dark mode

## Infra gaps (fair to report, not required)
- No linter/formatter config, no coverage wiring, no CI

## Scoring
Binary per seed: CAUGHT (defect identified, even in different words) / MISSED.
Categories: logic 4, tests 3, visual 5. Target: visual pass catches ≥3/5 to call the feature working.
