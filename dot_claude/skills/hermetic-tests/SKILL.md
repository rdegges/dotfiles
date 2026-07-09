---
name: hermetic-tests
description: Blind, cross-model test verification. Implementation and tests are written independently from the same frozen spec — the test writer (Codex/GPT-5.5) never sees the implementation, and the implementer never sees the tests. Disagreements are adjudicated against the spec before anything is edited. Use for production business logic with spec-able behavior (parsers, protocol handlers, billing, API contracts). Skip for UI, glue code, or exploratory work.
---

# Hermetic Tests

Break the author-verifies-own-work confirmation bias: when one context writes both
implementation and tests, the tests inherit the implementation's misreading of the
spec. Here, two different models work blind from the same spec, and a third pass
adjudicates disagreements — the spec, not the test suite, is the authority.

## When to use

- Production logic where correctness matters and behavior can be written down
  precisely: parsers, evaluators, protocol/format handling, billing/money math,
  public API contracts.
- NOT for UI, glue code, prototypes, or anything where writing the spec would take
  longer than the value at risk. If the spec is vague, this degrades to two agents
  guessing differently — fix the spec or don't use this skill.

## Requirements

- `codex` CLI installed and authenticated (`command -v codex`, `~/.codex/auth.json`).
  If absent, fall back to a fresh Claude subagent as the blind test writer (weaker:
  same-model blind spots survive) and say so in the final report.

## Process

### 1. Spec

Write `SPEC.md` in the project: exact behavior, edge cases, error behavior, and the
public interface (signatures + types). Every MUST in the spec should be testable.
If the user hasn't nailed down behavior, resolve ambiguities with them NOW — the
spec is frozen once blind work starts. Also write the interface stub file
(signatures + docstrings, bodies raise/throw "not implemented").

### 2. Implement (blind side A)

Claude writes the implementation from `SPEC.md` only. This MUST happen before any
tests exist in your context — never read, generate, or imagine the test file first.
Write it to satisfy the spec, including every edge case the spec names.

### 3. Blind test generation (blind side B)

Create a clean sandbox dir containing ONLY `SPEC.md` and the interface stub —
never the implementation. Then:

```
codex exec -s workspace-write --skip-git-repo-check -C <sandbox-dir> \
  "Read SPEC.md and the interface stub in this directory. Write a thorough test
   suite (<framework>) in <test-file> that verifies an implementation of this spec.
   Test every MUST, every edge case, and error behavior. You cannot see the
   implementation — derive expectations ONLY from SPEC.md. Do not write the
   implementation."
```

Prompt Codex simply and literally; one self-contained instruction. Copy the
resulting test file back into the project unmodified. Do not "fix up" tests that
look wrong — that's adjudication's job.

### 4. Run

Run the suite (in Docker per global rules). Expect failures — that's the point.

### 5. Adjudicate

For EACH failure, read spec + test + implementation and rule which is wrong
**before editing anything**:

- **Implementation wrong** → fix the implementation. (The common case, and the
  value this skill exists to capture.)
- **Test wrong** (misread the spec) → fix or delete the test, and note it. Never
  bend a correct implementation to satisfy a wrong test — that silently promotes
  the test writer's misreading to truth.
- **Spec ambiguous** (both readings defensible) → this is a spec bug. Fix
  `SPEC.md` first (ask the user if the choice is user-facing), then align both
  sides to it.

Re-run until green. Log every verdict as you go: `failure → blame (impl|test|spec)
→ fix`.

### 6. Report

Tell the user: pass/fail counts on first run, the adjudication table, and — most
importantly — **which real implementation bugs the blind tests caught** (i.e., the
bugs that same-context tests would likely have baked in). If the answer is "none,"
say so plainly; that's data about when this skill pays for itself.

## Rules that make it hermetic

1. The test writer NEVER sees the implementation — only spec + stub in a clean dir.
2. The implementation is finished before tests enter the orchestrator's context.
3. On disagreement, the spec is the authority; blame is assigned before edits.
4. The spec is frozen during blind work; changing it reopens both sides.
