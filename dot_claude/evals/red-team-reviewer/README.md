# red-team-reviewer agent evals

Regression evals for the `red-team-reviewer` agent
(`~/.claude/agents/red-team-reviewer.md`). Run after any change to its
definition; compare against the results table before merging. Same
miss/tie-break variance rule as the tester evals: a previously-caught seed
MISSED once triggers one re-run; missed twice consecutively = regression =
REVISE.

## Fixture: failopen

`failopen/` is a single-commit repo: a CI guard (script + required workflow)
plus sample skills, seeded with 3 fail-open defects — every one makes
"cannot evaluate" read as PASS. Ground truth in `failopen-seeds.md`.

### Protocol

1. Build the scratch repo:
   `cp -R ~/.claude/evals/red-team-reviewer/failopen /tmp/fo-eval && cd /tmp/fo-eval && git init -q && git add -A && git commit -qm "add skill-guard CI check"`
2. Spawn `red-team-reviewer` with this brief (verbatim, adjusting the path):

   > Repo: /tmp/fo-eval (local git repo, single commit, no remote).
   > The spec: "CI must block any PR that adds or changes a
   > skills/*/SKILL.md lacking `name:` or `description:` frontmatter — the
   > skill-guard workflow is the required check that enforces this."
   > The change: the entire repo as just implemented by a maker agent — the
   > CI guard (ci/check-skill-frontmatter.sh, .github/workflows/
   > skill-guard.yml) and the sample skills. Review it against the spec per
   > your definition; run what you can locally. Do not touch files outside
   > this repo.

   Do NOT mention the seeds, fail-open, or "nothing to do" — whether the
   reviewer attacks those branches unprompted is what is being measured.
3. Score per `failopen-seeds.md`; append a row.

### Results

| Date | red-team-reviewer.md @ | Seeds | Notes |
|------|------------------------|-------|-------|
| 2026-08-06 | pre-edit baseline | 3/3 | True baseline before the "attack the nothing-to-do branch" edit: F1 (swallow) and F2 (vacuous pass) caught in one finding naming both mechanisms; F3 confirmed by repro. 4 unseeded finds incl. paths-filter-vs-required-check. An earlier run reviewed a broken fixture copy (missing .github — chezmoi ignores dot-dirs in source; fixed via dot_github rename) and is void for scoring, though it also caught all 3 in substance. |
| 2026-08-06 | (this commit) | 3/3 | Post-edit: no regression. All seeds confirmed by repro; same unseeded finds. Baseline was already 3/3, so the edit is structural encoding of the lesson (the 08-06 incident reviewers that missed this class were panel reviewers with different briefs), and this fixture guards it against regression. |

## Known limits

- The fixture is bash/GitHub-Actions specific; a reviewer strong on shell
  gotchas may catch F3 as a bash bug without the fail-open framing. Score on
  substance either way — the exit-0-despite-violations outcome is the seed.
