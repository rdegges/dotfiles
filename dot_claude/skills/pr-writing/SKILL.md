---
name: pr-writing
description: "Write pull request titles and descriptions in plain English for a maintainer who never saw the plan. Load before opening or editing any PR."
---

## Pull Requests — Plain English

Write PR titles and descriptions for a maintainer who has never seen my plan,
phase names, or internal PR-numbering scheme — only the diff and the PR itself.

- **Check for the repo's PR template first.** If `.github/PULL_REQUEST_TEMPLATE.md`
  (or a `PULL_REQUEST_TEMPLATE/` directory) exists, fill out its headings and
  checkboxes instead of inventing your own structure. The rules below still
  apply to the prose you write inside it.
- **Title: say what the PR does, not its plan label.** Bad: "PR-C1: run-scoped
  output dirs + resume + rerun-with-archival". Good: "Add the ability to resume
  interrupted uploads". Bad: "PR-I2: extraction layer + deterministic garbage
  precheck". Good: "Add tests to filter out garbage inputs quickly".
- **Body: run the `simple-english` skill.** Load it first if this session has not
  loaded it yet, then write the body against its rules and run its verification
  checklist before you open or edit the PR. Never draft a PR body from memory.
- **No internal jargon — but keep real tracking IDs.** Strip plan codenames,
  phase numbers, and architecture-speak the maintainer wasn't part of designing.
  If a technical term is unavoidable, define it in one clause. A label you or I
  invented ("PR-C1", "Phase 2") goes. An ID that exists outside my plan — a JIRA
  key like "DOCT-2626", a GitHub issue number — stays, and gets a linking line
  ("Fixes #123") when one applies. When in doubt, ask whether the ID resolves to
  something a maintainer can open. If it does, keep it.
- **Test plan: report what you ran, not what you expect.** List the commands you
  actually ran and their real result. Leave a template checkbox unticked when
  you did not run that check, and say why. See the `verification-gates` skill — writing a verdict
  before the ruling exists is a red flag, and a ticked PR checkbox is a verdict.
- **Structure:** if the repo has no template, lead with what changed and why it
  matters to the maintainer, then implementation notes if genuinely useful, then
  the test plan. The summary must stand on its own without requiring the plan as
  context.
- **Length: scale the body to the diff.** An overlong body is the most common
  way an AI-written PR goes wrong — ahead of jargon. A one-concern PR gets a
  short paragraph, not a report. Cut any section that adds no fact the
  maintainer needs in order to review the diff. Never pad a template heading to
  look thorough: "N/A" is a real answer, and an empty optional section is
  better than filler.

