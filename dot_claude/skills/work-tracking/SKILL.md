---
name: work-tracking
description: "Where Randall's Snyk work is tracked and how to keep it tracked automatically: the decision rules between Matt Jarvis's engineering board (Jira AI), Colin Campbell's program board (Jira AITE), and the vault; the Jira map (keys, Initiatives, Epics, workflow, cadence); and the REST mechanics for reading, creating, moving, commenting, and closing tickets from Claude Code. Load whenever a task touches Snyk work, Jira, sprint reviews, or Now.md priorities."
---

# Work tracking

Randall is VP, AI Engineering at Snyk. Every piece of his work has exactly one
home. Your job is to keep the right home current without being asked.

## 1. The three homes

| Home | What goes there | Owner of the board |
|---|---|---|
| Jira `AI` (AI Operations) | Work that changes a repository or a deployed system | Matt Jarvis |
| Jira `AITE` (AI Transformation) | Program work with a business outcome someone else sponsors, lasting longer than two weeks | Colin Campbell, Patrick O'Hara |
| Vault (`~/Vault/Personal`) | Everything only Randall must find: replies, reviews, 1:1 follow-ups, reading, same-day decisions | Randall |

Never create a personal Jira project or a project per team. Randall had one
(GAIE) and never used it; Jira only earns its cost when other people read it.

## 2. Deciding the home

Ask two questions, in order.

1. Does it change a repository or a deployed system? Yes: `AI`.
2. Does it have a business outcome someone else sponsors, and will it outlive
   two weeks? Yes: `AITE` Epic.

Both no: vault. Two tie-breakers:

- **Sponsor test.** If you cannot name who is waiting on the outcome besides
  Randall, it stays in the vault.
- **Slice test.** A Story on `AI` must be a shippable slice with acceptance
  criteria a test can check. If it is not that yet, write the spec first or
  park it as an Epic on `AITE`.

When the home is unclear after both tests, ask one targeted question. Do not
create a ticket in the wrong home to save a question.

## 3. Jira map

Host: `https://snyksec.atlassian.net` (not snyk.atlassian.net). Both projects
are classic company-managed software projects with the same issue types and
the same release workflow.

Hierarchy: Initiative (theirs) → Epic (ours, one per workstream) → Story or
Task (slices) → Sub-task. A Story cannot have an Initiative as parent; it needs
an Epic.

Workflow statuses: Pending Requirements → Requirements Complete → Backlog →
In Progress → Ready for Staging → Staging in Progress → Ready for Release →
Released. Side states: Blocked, CANCELLED, Release Parked. Every status is
reachable from every other, so "close" means a transition to `Released` (work
shipped) or `CANCELLED` (not done, explain why). Epics are never auto-closed;
closing a parent is Randall's call.

### `AI` Initiatives (Matt's board)

| Key | Initiative |
|---|---|
| AI-2983 | Central AI Infrastructure |
| AI-2072 | AI for Product |
| AI-2070 | AI for Enterprise Information |
| AI-494 | AI for Employee Experience |
| AI-490 | AI for Business Operations |
| AI-488 | AI for Customer Success |

Epics Randall owns on `AI` as of 2026-09-21: `AI-3685` Automated Renewals
(Account Management Center, under AI-490, Skyler Ebelt and Connor McKay),
`AI-3686` Customer Onboarding Agent, Toffee UI only (under AI-488, Connor).

Board practices: Scrum board 13008, two-week sprints, story points
`customfield_10021` barely used, one-slide-per-person sprint review at the end
of each sprint. Matt's team files tickets through the Agent Factory's
`jira-traceability` gate: spec → ticket → PR, each linked; one ticket is one
well-scoped piece of work with acceptance criteria; the PR references the
ticket; dated milestone comments at spec approved, plan accepted, tasks
generated, implementation complete, PR opened. Match that when you create
tickets by hand. Their process docs live in Confluence space `AO`
("Development Process", "Spec-Driven Development").

### `AITE` Initiatives (Colin's board)

| Key | Initiative |
|---|---|
| AITE-1 | Drivers Program & Business Priorities |
| AITE-2 | Activation & Education |
| AITE-3 | Data Foundation |
| AITE-4 | AI Operating Model |
| AITE-5 | AI Architecture & Foundation |
| AITE-6 | Modernize Tech Stack |
| AITE-36 | Prioritized Builds |

Under AITE-36 Prioritized Builds sit the business-outcome Epics, one per
build: `AITE-37` AI SDR, `AITE-38` AI Campaign Manager, `AITE-39` AI AE (the
Account Management Center / Automated Renewals outcome; its seven decision and
dependency stories moved here from the retired `AITE-47` on 2026-09-21),
`AITE-40` Case Resolution, `AITE-41` Continuous Signal Engine, `AITE-42`
Document Search, `AITE-43` Onboarding Agent, `AITE-44` Vendor & Contract
Intelligence. Randall also owns `AITE-45` AI Adoption & ROI Log (under
AITE-1). Kanban board "AI Transformation Delivery Board".

**Cross-board link convention (Colin Campbell, 2026-09-21).** Every AITE
business-outcome Epic must carry a `Relates` link to the AI Operations Epic
that builds it, for example AITE-37 to AI-3283, AITE-39 to AI-3685, AITE-43 to
AI-3686. When you create an Epic on either board for work that exists on the
other, add the link the same day. AITE holds outcomes and decisions at macro
level; requirements and build detail stay on `AI`.

Typical mapping of Randall's program workstreams. Prefer an existing Epic
over a new one: AI enablement and pilot rollouts → AITE-13 or AITE-14 (under
AITE-2); MCP connector approvals → AITE-20; #ask-ai intake → AITE-21; skill
rollout automation → AITE-22; build-versus-buy and vendor decisions → AITE-24;
spend attribution and LLM API management → AITE-29; Snyk Assist and MCP
platform ownership → AITE-27 or AITE-28; vendor and compliance work (Render,
Keycard, procurement) → AITE-34; re-owned builds → the matching outcome Epic
under AITE-36. Create a new AITE Epic only when no outcome above fits, and
tell Colin or Patrick when you do.

## 4. Automatic upkeep

Do these without being asked whenever the session touches Snyk work.

- **Session start.** Read `Now.md`. If the task maps to a hot project with no
  ticket or Epic key on its line, decide the home (section 2) and create or
  find the ticket before the work begins. Put the key on the Now.md line
  through `pkms:archivist`.
- **During engineering work.** Reference the ticket key in branch names, commit
  bodies, and the PR description. When a PR opens, comment the PR URL on the
  ticket.
- **Session end.** For every ticket touched, post one dated comment: what
  changed, what is next, what is blocked. Propose transitions for anything
  done; apply `Released` only when the evidence is a merged PR or a verified
  deploy. Include the ticket list in the session trace.
- **Weekly.** Before the sprint review, draft Randall's slide from tickets that
  moved to `Released` in the sprint: outcomes not activity, five bullets
  target, eight ceiling, no dates.
- **Hygiene, report first.** When you notice open Epics on `AI` without an
  Initiative parent, tickets assigned to people who have left, or Randall's
  items untouched for 60 days, list them and propose the fix. Do not close
  other people's tickets without Randall's word.

## 5. Ticket conventions

- **Summary.** Outcome, not activity: "Lead Uploader runs the first three
  Marketo lists in production", not "Work on Lead Uploader".
- **Description.** Why, acceptance criteria a test can check, out of scope,
  links to the spec or doc. For `AITE` Epics: the sponsor, the outcome, the
  decision needed.
- **Parent.** Always set. Stories under an Epic, Epics under an Initiative.
- **Moves and closes.** Always comment first, in this shape: what is happening,
  the date, at whose request, why, and where the work now lives. Example:
  "Closing as CANCELLED on 2026-09-21 during the wind-down of the Applied AI -
  GTM board after Tim Smith's departure, at Randall Degges's request. Account
  segmentation clusters were handed to Business Operations at the August 2026
  offsite. Track any remaining decisions there."
- **Assignees.** Randall's account lacks "Assign Issues" in `AI`, `AITE`, and
  `AAIGTM`. Name the intended owner in the comment and ask them to
  self-assign, or ask a Jira admin for the permission.

## 6. Mechanics

Preferred path: the Atlassian MCP connector, if it is authenticated in the
session. Fallback that always works: Claude in Chrome on a tab at
`https://snyksec.atlassian.net/jira/your-work`, then `javascript_tool` with
`fetch` against REST v3 on the same origin. Randall is logged in; no token is
needed. The user settings allow the JavaScript tool and Atlassian writes, so
the auto-mode classifier does not prompt.

Gotchas learned on 2026-09-21:

- `javascript_tool` output truncates near 1,000 characters. Aggregate in JS, or
  write a long dump into `document.body` inside `<article><pre>` and read it
  with `get_page_text`.
- `/rest/api/3/search/jql` does not return totals. Counts come from
  `POST /rest/api/3/search/approximate-count` with `{"jql": ...}`.
- Comments and descriptions take Atlassian Document Format:
  `{"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"..."}]}]}`.
- Transition with a comment in one call:
  `POST /issue/{key}/transitions` with `{"transition":{"id":...},"update":{"comment":[{"add":{"body":<adf>}}]}}`.
  Find the id by matching `transitions[].to.name`.
- Create with parent: `POST /rest/api/3/issue` with
  `fields.project.key`, `fields.issuetype.id` (Epic 10000, Story 10001, Task
  10002, Sub-task 10003 in all three projects), `fields.summary`,
  `fields.parent.key`.
- Move between projects: `POST /rest/api/3/bulk/issues/move`, one target per
  call, body `{"sendBulkNotification":true,"targetToSourcesMapping":{"<PROJECT>,<issueTypeId>":{"issueIdsOrKeys":[...],"inferClassificationDefaults":true,"inferFieldDefaults":true,"inferStatusDefaults":true,"inferSubtaskTypeDefault":true}}}`.
  Poll `GET /rest/api/3/bulk/queue/{taskId}` until `COMPLETE`. Sub-tasks move
  with their parent automatically. Only Jira admins can set
  `sendBulkNotification` to false. Re-parent after the move with
  `PUT /issue/{newKey}` and `fields.parent.key`. Old keys keep redirecting.
- A sub-task cannot move without its parent. If the parent stays, recreate the
  sub-task as a Task in the target and close the original with a pointer.
- Chrome tab groups vanish when the last tab closes. Re-run
  `tabs_context_mcp` with `createIfEmpty` before the next call.

Useful JQL:

- Randall's open queue: `assignee = currentUser() AND statusCategory != Done`
- Current sprint on Matt's board: `project = AI AND sprint in openSprints()`
- Epics missing an Initiative: `project = AI AND issuetype = Epic AND statusCategory != Done AND parent is EMPTY`
- Stale personal items: `assignee = currentUser() AND statusCategory != Done AND updated <= -60d`
