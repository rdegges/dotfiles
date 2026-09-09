---
name: codex-delegation
description: "Routing policy and invocation gotchas for delegating work to GPT-5.5 via the codex CLI (work machine only). Load before delegating bulk work, running a Codex review, or choosing a model for a subtask."
---

## Model Delegation — Codex / GPT-5.5 (work machine only)

*This section is applied by chezmoi only on my work laptop, where I have both a
Claude Code subscription and a Codex/OpenAI subscription. On personal machines it
is absent, so ignore any instinct to reach for Codex there.*

You (Claude) are the orchestrator. You own the plan, every taste-sensitive call,
and the final judgment on what ships. **GPT-5.5 — reachable only through the
`codex` CLI — is a second engine you delegate to when it is the better tool, not a
fallback.** My Codex sub's usage is very generous, so treat 5.5 as effectively free
for the work it's good at. The point of delegating is not to save a few tokens; it
is to (a) not burn my scarcer Claude usage on grunt work, and (b) use the model
that is genuinely best at each sub-task.

This generalizes the "Adversarial Review (Codex)" rule at the end of this skill: review is just one
kind of delegation. Here is the full picture.

### Glossary (so we mean the same thing)

- **Intelligence** — how hard a problem the model can handle *unsupervised*.
- **Taste** — UI/UX, code quality, public API/SDK design, and copy.
- **Cost** — my real usage-limit burn and out-of-pocket, not list price.

### Scorecard (higher = better; starting defaults — recalibrate from experience)

| model    | cost | intelligence | taste | reach it via                          |
| -------- | ---- | ------------ | ----- | ------------------------------------- |
| gpt-5.5  |  9   |      8       |   5   | `codex` CLI (skills / `codex exec`)   |
| sonnet-5 |  5   |      5       |   7   | native / sub-agents                   |
| opus-4.8 |  4   |      7       |   8   | native (my current daily driver)      |
| fable-5  |  2   |      9       |   9   | native (when I'm running it)          |

`cost` is inverted on purpose: **higher = cheaper/more available to me.** GPT-5.5
scores 9 because my Codex sub is near-infinite; Fable scores 2 because it's the one
I most need to spend carefully. Never use Haiku for real work — with 5.5 effectively
free, it has no niche.

### Routing rules

- **Bulk mechanical / token-heavy work → GPT-5.5.** Clear-spec implementations,
  migrations, data analysis, digging through large logs, reading giant PDFs/specs,
  wide mechanical refactors. This is exactly the work that burns Claude usage
  fastest and that 5.5 does well, so hand it off.
- **Computer use / runtime verification → the `codex-computer-use` skill.** Driving
  a real app or simulator, browser automation, screenshots, launching apps,
  inspecting a running app. OpenAI's local computer use is currently well ahead of
  what I can do natively; default to that skill when I ask you to "test a flow" or
  "verify the UI."
- **Anything user-facing / taste > 7 → keep on Claude.** UI copy, public API/SDK
  shape, anything I'll ship with my name on it. 5.5 writes TypeScript like a Python
  dev and Rust like a paranoid C++ dev — do not let it own the shape of code I
  ship. Use it to *gather information and try things*, then bring the real change
  back to Claude.
- **Independent review / second opinion → the `/codex` skill** (its `review`,
  `challenge`, and `consult` modes). Always verify Codex's claims against the code
  before presenting them; it's a reviewer, not an authority.

### Escalation philosophy

These are defaults, not limits. You have standing permission to override them: if a
cheaper model's output doesn't meet the bar, redo the work with a smarter one
**without asking**. Judge the output, not the price tag — escalating costs less than
shipping mediocre work. Don't let cost stop you from using the right model; use the
cheap ones to gather information and try things, then move the real work to the
right model. Cost is a tiebreaker only when the other axes genuinely tie.

### Invoking Codex (it is not Claude)

- **Prompt it simply and literally.** Codex does only what you tell it; it won't
  wander or gold-plate the way Claude does, so drop the Claude-style guardrails and
  give it one clear, self-contained instruction.
- **Read-only investigation the skills don't cover:** run
  `codex exec -s read-only "<one self-contained prompt>"` directly and read back
  what it found. Add `-C <dir>` to point it at a specific repo.
- **Known invocation gotchas:** outside a git repo, add `--skip-git-repo-check` —
  without it Codex errors or silently returns empty output. Never pipe stdin to a
  backgrounded `codex exec`; redirect `</dev/null` or it hangs on "Reading additional
  input...". Split 10-minute-plus runs into scoped passes — the JSONL stream can die
  mid-run without `turn.completed`.
- **Bounded implementation on a scratch branch:** `codex exec -s workspace-write`
  inside a git worktree, then review the diff before it goes anywhere near a real
  branch.
- **Inside a Claude Code workflow you cannot pick 5.5 as a sub-agent model.** Spawn
  a `sonnet` sub-agent on **low** whose only job is to shell out to `codex`, capture
  5.5's output, and report it back. Prefix such sub-agents (e.g. `[5.5] …`) so I can
  see at a glance which ones delegated.
- If a Codex command comes back wrong once or twice, ask it what the correct
  invocation is, then tell me so I can pin the fixed command into the relevant skill.

## Adversarial Review (Codex)

This is the cross-model lens of the maker ≠ checker rule (see the `graph-engineering` skill);
the `red-team-reviewer` agent is the always-available first lens and runs regardless.

Before declaring any coding task complete, check whether `codex` is installed and
authenticated (`command -v codex` succeeds and `~/.codex/auth.json` exists). If it is:

- Run an **adversarial review** of your changes via the `/codex` skill in *challenge*
  mode — have it actively try to break the code and surface bugs, edge cases, and
  security issues in the diff.
- Triage the findings: fix every genuine issue. For anything that's a false positive
  or out of scope, note it briefly rather than blindly applying the suggestion.
- Re-run the relevant tests/build after fixing, then end the run.

If `codex` is not installed or not authenticated, skip this step silently — never
block a task on its absence.

For production business logic with spec-able behavior (parsers, protocol handlers,
billing/money math, public API contracts), prefer the stronger form: the
`hermetic-tests` skill (`~/.claude/skills/hermetic-tests/`) — blind cross-model
test verification where the test writer never sees the implementation. When it
runs, it replaces the post-hoc challenge review above for the code it covers.

