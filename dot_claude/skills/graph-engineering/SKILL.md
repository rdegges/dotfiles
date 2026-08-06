---
name: graph-engineering
description: "Design and run a task as a graph of agents — decompose, delegate with complete briefs, parallelize reads, keep writes single-threaded, and verify with fresh-context reviewers before synthesis. Use whenever task triage classifies a request as graph-shaped: parallelizable research, audits, migrations, multi-lens review, or work exceeding one context window. Skip for direct edits and single-loop coding tasks — fan-out must earn its ~15x token cost."
---

# Graph Engineering

Make topology an explicit decision, not an accident. A graph is only worth
building when its nodes are already reliable loops — each node must plan,
execute, and verify on its own, or weak loops multiply across the graph.

## 1. Design the graph before spawning anything

Write the shape down first (a few lines in the reply or a plan artifact):
phases, node count per phase, what flows along each edge, and where
verification sits. Name which of the five base patterns each phase uses:

- **Chain** — sequential steps with checkable gates between them. Use when the
  task decomposes into fixed stages (spec → implement → verify).
- **Route** — classify, then dispatch to a specialized handler. Use when inputs
  fall into distinct categories handled better separately.
- **Parallelize** — *sectioning* (independent subtasks fan out) or *voting*
  (same question asked N ways for confidence). Use for reads: research,
  audits, multi-file investigation, multi-lens review.
- **Orchestrate** — a coordinator decomposes work it can't fully predict and
  delegates dynamically. Use for open-ended scope (deep research, migrations).
- **Evaluate–optimize** — generator + critic loop until a condition is met.
  Use when clear evaluation criteria exist and iteration measurably helps.

Prefer the simplest pattern that fits. Mix node types deliberately:
deterministic code for deterministic steps, a single model call for bounded
judgment, a full agent only for genuine uncertainty. Expect cycles — retry,
revise, re-verify are normal edges, not failures.

## 2. Effort scaling (encode, don't vibe)

- Lookup / single-fact question → no subagents, 3–10 tool calls inline.
- Comparison, moderate research → 2–4 subagents, clearly divided.
- Audit, migration, deep research, "be comprehensive" → orchestrated workflow,
  10+ nodes, phased.
- Most coding tasks parallelize *worse* than research. Tightly-coupled changes
  stay single-threaded no matter how large.

## 3. Delegation briefs

Every spawned agent gets all four, every time:

1. **Objective** — one sentence, outcome-shaped.
2. **Output format** — what comes back (structured findings, compact brief,
   file paths + one-line claims). Summaries and references, never raw dumps.
3. **Tool/source guidance** — where to look, what to prefer, what to skip.
4. **Boundaries** — what is explicitly out of scope, so parallel nodes don't
   overlap or leave gaps.

### Review briefs

Brief content, not reviewer count, determines what a review finds. For any
review/panel node:

- Embed the binding decision policy **verbatim** in every persona prompt —
  reviewers converge on the policy they can see, not the one you meant.
- Ask what to CUT, not only what is missing (the subtraction rule in
  CLAUDE.md's Graph Engineering section governs; do not restate it, point
  to it).
- Attack the branch where the code decides there is nothing to do — a check
  that "cannot evaluate" and reports success is a finding.
- For any stateful pass, require constructed interaction tests (A→B→A), not
  single-transition checks.
- For security/DoS properties, use a lens that *executes* probes; a reading
  lens verifies prose, not behavior.
- State prior lessons as rules, not anecdotes — an incident briefed by name
  does not transfer; the same lesson restated as a rule does.

## 4. Reads fan out; writes stay single-threaded

- Research, exploration, log-reading, review: fan out freely — that work
  exists to be kept *out* of the main context.
- Code writing: one thread per ownership boundary. Parallel writers only in
  separate worktrees with contracts (interfaces, file ownership) agreed in the
  plan before any worker starts.
- Cap concurrent write streams at my review bandwidth (~4). Unreviewed
  parallel output is where slop enters.

## 5. Phase-boundary compaction

End each phase by writing a compressed artifact (markdown plan, findings
brief) and start the next phase from that artifact in fresh context — don't
drag research residue into implementation. Keep the implementation thread's
context lean; when a thread degrades, restart it from the artifact rather
than pushing through.

## 6. Verification topology

Scale the checker to the stakes; the maker never grades its own work:

- **Every non-trivial change**: one fresh-context `red-team-reviewer` pass —
  diff vs. spec, gaps not style.
- **Risky or subtle diffs**: 3 diverse lenses (correctness, security,
  spec-compliance) as parallel reviewers; disagreements resolved against the
  spec, not by vote alone.
- **High-stakes work**: adversarial panel — independent skeptics prompted to
  *refute* each finding/claim; only survivors ship.
- Cross-model lenses (Codex challenge review, hermetic-tests) stack on top
  where their triggers apply — see CLAUDE.md §Verification.
- Verifiers get a runnable check wherever possible (tests, build, repro) —
  evidence, not assertions.

## 7. Codify recurring graphs

The second time the same fan-out shape appears, stop re-planning it
turn-by-turn: save it as a named workflow under `~/.claude/workflows/` so it
can be re-invoked by name with args. The orchestration itself is then a
reviewable, versionable artifact — and a candidate for the dotfiles repo.

## Anti-patterns (refuse these)

- Fanning out because the task is big rather than because it is parallel.
- Persona-zoo agents — roles exist for context isolation or tool scoping,
  not cosplay.
- A coordinator that pipes full subagent transcripts through its own context.
- Verification by the same context that produced the work.
- Unbounded loops — every cycle needs an exit condition and iteration cap.
