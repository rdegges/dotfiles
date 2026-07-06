---
name: codex-computer-use
description: Ask the Codex CLI (GPT-5.5) to run local app verification that needs computer use — browser automation, simulators, screenshots, app launching, or independent runtime inspection. This is how GPT-5.5 is invoked for computer-use work. Use when the user asks Claude to test a flow, verify UI behavior, inspect a running app, capture screenshots, or report confirmation and feedback about implemented behavior that benefits from real computer use. Work machine only (requires an authenticated Codex CLI).
allowed-tools:
  - Bash
  - Read
---

# Codex Computer Use

Use Codex (GPT-5.5) as a separate local verification agent when the task needs real
UI interaction, screenshots, simulator/browser/device state, or an independent
runtime check outside your current context. OpenAI's local computer use is currently
well ahead of what Claude can do natively — delegate to it rather than struggling
with SSH-unfriendly, screenshot-heavy verification yourself.

Do **not** use this for ordinary code reading, typechecking, linting, or tests you
can run directly. Launching apps, simulators, or browsers to verify the requested
work is fine without asking; ask first only if the run could disrupt the user's
environment beyond that (closing their apps, changing system settings, or acting on
real accounts or production data).

## Preflight

```bash
command -v codex >/dev/null || { echo "codex CLI not installed — cannot delegate"; exit 1; }
[ -f "${CODEX_HOME:-$HOME/.codex}/auth.json" ] || [ -n "$CODEX_API_KEY$OPENAI_API_KEY" ] \
  || { echo "codex not authenticated — run 'codex login'"; exit 1; }
```

If either check fails, stop and tell the user; do not silently fall back to doing
fragile computer use yourself.

## Workflow

1. **Write a single, self-contained prompt.** Codex won't wander or gold-plate, so
   be literal: name the app/URL/simulator, the exact flow to exercise, what counts
   as success, and what to report back. Ask it to save screenshots to a known
   directory so you can read them afterward.
2. **Run it with full local access** (computer use needs to launch apps and capture
   the screen):

   ```bash
   SHOT=$(mktemp -d)
   codex exec -s danger-full-access -C "$PWD" \
     "Verify <flow> in <app/url>. Steps: <...>. Success = <...>. \
      Save each screenshot as PNG into $SHOT and end with a short PASS/FAIL report \
      naming exactly what you observed. Do not modify project files."
   ```

   - Point Codex at a specific repo/app with `-C <dir>`.
   - Attach an input image (e.g. a failing screenshot the user pasted) with
     `-i <file>`.
   - For read-only inspection that must not touch anything, use `-s read-only`
     instead of `danger-full-access`.
3. **Read the evidence, don't trust the summary.** Read the screenshots Codex saved
   (`Read` on the PNGs in `$SHOT`) and check its claims against them before you
   report to the user. Codex is a verification agent, not an authority.
4. **Report back** what was actually observed — PASS/FAIL, the screenshots, and any
   discrepancy between Codex's summary and what the images show.

## Notes

- The user's `~/.codex/config.toml` already runs `approval_policy = "never"` and a
  full-access sandbox, so `codex exec` runs hands-off; the explicit `-s` flag above
  keeps this skill correct even on a machine whose config differs.
- Override the model with `-m <model>` only if the user asks; otherwise use the
  Codex default.
- If a command comes back wrong once or twice, ask Codex for the correct invocation,
  fix it here, and tell the user so the skill stays accurate.
