---
name: ai-eng-membership
description: "Add people to, or remove people from, the Snyk AI Engineering team's three shared memberships: the ai-engineering@snyk.io Google Group, the AI Engineering team in the snyk-internal GitHub org, and the @ai-engineering Slack user group. Use when Randall onboards or offboards someone on AI Engineering: \"add X to the team\", \"onboard X\", \"X joined AI Engineering\", \"remove X from the team\", \"offboard X\", \"X left AI Engineering\"."
---

# AI Engineering membership

Every AI Engineering employee must be in three places. This skill adds a
person to all three, or removes a person from all three.

| System | Target | How |
|---|---|---|
| Google Group | `ai-engineering@snyk.io` (calendar invites, email) | Claude in Chrome |
| GitHub | team `ai-engineering` in org `snyk-internal` (repo access) | `gh api` |
| Slack | user group `AI Engineering` (`@ai-engineering`) | Claude in Chrome |

No connector can change Google Group or Slack user group membership. Those
two steps use Claude in Chrome. Load the `claude-in-chrome` skill before them.

## 1. Collect the inputs

You need these values for each person:

- **Action**: `add` or `remove`.
- **Snyk email**: `<name>@snyk.io`. Google and Slack use this email.
- **GitHub username**: the org has no SAML identity lookup, so you cannot
  get the username from the email. If Randall did not give it, ask for it.

You can do more than one person in one run. Collect all inputs first.

## 2. Resolve and check each person

Do these read-only checks before any change:

1. Find the Slack account with `slack_search_users` and the email.
   Record the display name. If no account exists, stop for this person.
2. Read the GitHub org membership:

   ```sh
   gh api /orgs/snyk-internal/memberships/<github-user> -q '.state'
   ```

   - For `add`: the result must be `active`. If the user is not an org
     member, stop for this person. Do not send an org invitation. IT gives
     org access through the normal Snyk access process.
   - For `remove`: a 404 means that the user is not in the org. Record the
     GitHub step as "already done".
3. Read the current team membership:

   ```sh
   gh api /orgs/snyk-internal/teams/ai-engineering/memberships/<github-user> -q '.state'
   ```

   A 404 means that the user is not on the team.

## 3. Get one approval

These changes are outward-facing. Show Randall one table: each person, each
system, the current state, and the planned change. Get one "yes" for the
full table. Then do all rows without more questions.

Skip a row when the person is already in the target state. Show it as
"already done".

## 4. Make the changes

Do the GitHub step first, because it is the only step that does not need
the browser.

### GitHub

```sh
# add (role member, not maintainer)
gh api -X PUT /orgs/snyk-internal/teams/ai-engineering/memberships/<github-user> -f role=member
# remove
gh api -X DELETE /orgs/snyk-internal/teams/ai-engineering/memberships/<github-user>
```

Removal takes the person off the team only. It does not remove them from
the `snyk-internal` org. Org removal is an IT offboarding step. Tell Randall
this in the report.

### Google Group

1. Open `https://groups.google.com/a/snyk.io/g/ai-engineering/members` in a
   new tab.
2. For `add`: click **Add members**. Enter the email. Turn on **Directly
   add members** so that no invitation email is necessary. Click **Add
   members**.
3. For `remove`: find the row of the person. Select its checkbox. Click the
   remove-member control, then confirm.
4. If the page has no **Add members** control, Randall is not a manager of
   the group. Stop this step and report the group owners from the members
   page.

### Slack user group

1. Open Slack in the browser at `https://app.slack.com`. Open **People**,
   then **User groups**, then **AI Engineering**.
2. Click **Edit members**.
3. For `add`: type the display name and select the person.
4. For `remove`: click the remove control next to the person.
5. Click **Save changes**.
6. If the page has no **Edit members** control, Randall does not have the
   permission for this user group. Stop this step and report it.

If a login wall or MFA prompt shows, ask Randall to sign in in that tab.
Then continue.

## 5. Read back each change

A change is done only when you read it back from the system.

- GitHub: run the team membership read from step 2 again. For `add`,
  expect `active`. A `pending` state means that the user has an open org
  invitation. For `remove`, expect a 404.
- Google Group: reload the members page. Search for the email.
- Slack: reopen the user group member list. Search for the display name.

## 6. Report

Give Randall one table: person, system, result (`added`, `removed`,
`already done`, `failed`), and the read-back evidence. For each failure,
give the cause and the fix. For `remove`, also list the steps outside this
skill: org removal in GitHub, and Snyk IT offboarding.
