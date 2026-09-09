---
name: verification-gates
description: "Load when building or changing a gate, CI check, eval, prompt, or AI pipeline, or when reading a subagent's report. Covers eval-driven AI work, gates that fail closed, checking external-system facts against authoritative artifacts, self-improving patterns, and the red flags for trusting reports and pre-filled verdicts."
---

## Verification gates

### Eval-Driven AI Work
- When modifying prompts, AI pipelines, or model behavior: define binary pass/fail
  criteria against a dataset of real-world inputs before shipping. "Looked good on
  3 examples" is not verification.
- When debugging AI output quality: sample real traces, annotate errors with
  one-sentence notes, categorize, frequency-count to prioritize. Fix in priority
  order, not vibes order.
- After automated checks reach ~90% quality, do a human vibe check. When the vibe
  check catches something, encode that feedback as a new eval criterion so it's
  caught automatically next time.

### Facts about external systems
- Before claiming a fact about an external system: check the authoritative artifact
  (reference file, live API, packet capture), not memory and not a mock. For a new
  third-party API client, run at least one live read-only smoke call per endpoint class
  before trusting the mock suite. Record a cause as fact only after a cheap disproof
  attempt; until then it is an observation.

### Gates Fail Closed

A gate is any check that blocks or blesses a merge, deploy, or run.

- Every gate states, in one plain sentence, what a PASSING result proves.
  If that sentence is untrue on any input, the gate is wrong.
- Enumerate every "cannot evaluate" posture (tool missing, empty input,
  nothing matched, API cap, subprocess error) in one classifier and decide
  each deliberately: fail closed, or skip loudly with a reason — never
  report success. "Nothing to do" green is the branch nobody attacks.
- A new gate counts as installed only after it has been observed rejecting
  a seeded violation. A green run that had nothing to reject proves nothing;
  making a gate required multiplies the cost of a false green.

### Self-Improving Patterns
- When fixing a class of recurring issues (flaky tests, lint errors, similar bugs):
  after fixing one instance, search for and fix all sibling instances affected by
  the same root cause.
- If you discover a novel failure pattern while fixing something, update the
  relevant skill file, checklist, or CLAUDE.md section to capture the learning.
  Don't fix and forget — encode it so it's caught automatically next time.

### Red Flags — Stop and Verify
- Trusting a subagent's success report without independently checking. Its
  findings and verdicts are checkable artifacts; its claims about its own
  process ("my reviewers ran") are not — check transcripts.
- Writing a verdict, eval row, or results cell before the ruling exists.
  Verdict cells are copied from the returned artifact, never pre-filled with
  the expected outcome.
- Gating on a command whose output runs through a pipe (`| tail`, `| head`, `| grep`) —
  pipes mask exit codes and truncate evidence. Run the gating command bare, read the
  full result, then filter separately.
