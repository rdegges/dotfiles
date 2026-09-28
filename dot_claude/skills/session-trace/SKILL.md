---
name: session-trace
description: "Loop Architecture and session traces: after any non-trivial session (>15 min) capture a structured trace in the vault and feed the hill-climbing loop. Load when a long session ends or when asked to reflect or improve CLAUDE.md/skills."
---

## Loop Architecture

Design work as nested loops, not flat steps. Each loop level has a clear exit
condition. Work at the highest loop level the task demands — don't drop to
execution-level thinking when the task is system-level.

### The Loop Stack (inner → outer)

1. **Execution Loop** — complete a single instruction.
   Exit: instruction done, output verified with fresh evidence (a command you ran).

2. **Task Loop** — complete a spec or user request.
   Exit: all requirements met, tests pass, adversarial review clean.
   *This is where most Claude Code sessions live.*

3. **Product Loop** — maintain a product-level concern continuously.
   Exit: none by design — the loop runs on a schedule or trigger.
   Examples: vault health, dependency freshness, content pipeline, eval suites.
   *Implementation: scheduled tasks and skills that run without prompting.*

4. **System Loop** — improve the whole system (CLAUDE.md, skills, evals, vault conventions).
   Exit: evals and judges say the system is measurably better.
   *This is the hill climbing loop — the most important and most neglected.*

5. **Oversight Loop** — strategic human judgment.
   Exit: my call. I decide what to invest in, what to deprecate, where to push.
   *I should live here. If I am stuck in loop 1-2, something is wrong.*

### Session Traces (feeding the System Loop)

After any non-trivial session (>15 min of real work), capture a session trace.
A trace is not a transcript — it is a structured reflection:

- **What worked** — patterns, tools, approaches that produced good results
- **What failed** — things that took >2 attempts, dead ends, wrong assumptions
- **What surprised** — unexpected behaviors, undocumented quirks, new capabilities
- **What should change** — concrete CLAUDE.md edits, skill improvements, or vault updates

File traces in ~/Vault/Personal/Resources/Personal/Session Traces/YYYY-MM-DD — <slug>.md.
When 3+ traces show the same pattern, propose a CLAUDE.md or skill update.
The `hill-climber` agent owns this mining: run it through the trigger below,
or on demand. It returns ranked proposals with evidence and a binary eval
each; apply them via chezmoi and merge through the BDFL gate like any other
change.

### Hill-climb trigger

Nothing counts "new" traces by itself, so every trace filing runs this
trigger. Hill-climb records live in the `Hill-climbs/` subfolder of the
Session Traces folder. Each record's frontmatter `mined:` is a YAML block
list, one trace file name per line, of the traces that run read. A trace is
**unmined** when it is a note in the Session Traces folder that the `mined:`
of no record lists. `_template.md` and the records themselves never count.

1. **File and list.** The same `pkms:archivist` brief that files the trace
   then runs this listing exactly. The brief tells it to follow
   `Preferences.md` §Vault Hygiene and to return (a) the exact command it
   ran, (b) the unmined list, oldest first, and (c) the `unmined:` count.

   ```bash
   bash <<'SH'
   set -euo pipefail
   cd "$HOME/Vault/Personal/Resources/Personal/Session Traces"
   mined=$(mktemp) && trap 'rm -f "$mined"' EXIT
   for f in Hill-climbs/*.md; do
     [ -f "$f" ] || continue
     awk '/^---[[:space:]]*$/ { if (++fm == 2) exit; next }
       fm == 1 && /^mined:/ { m = 1; next }
       fm == 1 && m && /^[[:space:]]*- / {
         sub(/^[[:space:]]*- [[:space:]]*/, ""); sub(/[[:space:]]+$/, "")
         gsub(/^"|"$/, ""); print; next }
       fm == 1 { m = 0 }' "$f"
   done | LC_ALL=C sort -u > "$mined"
   list=$(find . -maxdepth 1 -type f -name '*.md' ! -name '_template.md' \
     | sed 's|^\./||' | LC_ALL=C sort | LC_ALL=C comm -23 - "$mined")
   [ -n "$list" ] && printf '%s\n' "$list"
   printf 'unmined: %s\n' "$(printf '%s' "$list" | grep -c . || true)"
   SH
   ```

2. **Check.** Count the returned list yourself. If the count is not the
   stated `unmined:` count, or the archivist could not run the command, the
   trigger FAILED. Do not guess a list.
3. **Mine.** If 3 or more traces are unmined, run `hill-climber` in the
   FOREGROUND, never in the background, on at most the 25 OLDEST unmined
   traces (the first 25 of the list). Pass their full paths.
4. **Record.** The archivist then files hill-climber's report as
   `Hill-climbs/YYYY-MM-DD HHMM — hill-climb.md` (same §Vault Hygiene rule).
   Its frontmatter `mined:` lists exactly the trace notes hill-climber read.
5. **Report.** The session's final message contains exactly one of these
   lines. The trigger is never silent.
   - `hill-climb: filed <note name>`
   - `hill-climb: skipped (<n> unmined, need 3)`
   - `hill-climb trigger FAILED: <why>`

Hill-climber's proposals go to me. Any that I adopt go through `planner` and
`bdfl` like other work.


### Loop Hygiene

- **Do not solve loop-3+ problems with loop-1 effort.** If you keep manually fixing
  the same class of issue, that is a signal to move up a loop — create a scheduled
  check, add an eval, or update CLAUDE.md.
- **When debugging hits 3 strikes, question the loop level.** The three-strike rule
  (see the three-strike rule in CLAUDE.md) is a loop-level signal: you may be in the wrong loop.

