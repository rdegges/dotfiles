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
| GitHub | team `ai-engineering` (id `19821548`) in org `snyk-internal` (repo access) | `gh api` |
| Slack | user group `AI Engineering` (`@ai-engineering`) | Claude in Chrome |

No connector can change Google Group or Slack user group membership. Those
two steps use Claude in Chrome. Load the `claude-in-chrome` skill before them.

Each system is one row in the plan. A failure or a skip in one row does not
stop the other rows for that person.

## 1. Collect the inputs

You need these values for each person:

- **Action**: `add` or `remove`.
- **Snyk email**: `<name>@snyk.io`. All three systems start from this email.
- **GitHub username**: optional. Step 2 finds it from the email. If Randall
  gives one, step 2 uses it only as a cross-check.

You can do more than one person in one run. Collect all inputs first.

## 2. Read the current state

Do only read-only calls in this step. Record one state for each system.

### Slack account

Find the account with `slack_search_users` and the Snyk email. Record the
full name, the display name, and the email that it returns.

If no active account exists, mark the Slack row `skipped: no active Slack
account`. On `remove`, still read the user group list below for the full
name. Report the person if they are still in the list.

### GitHub identity

1. Load the org members with their verified Snyk emails:

   ```sh
   gh api graphql --paginate -f query='query($endCursor: String) {
     organization(login: "snyk-internal") {
       membersWithRole(first: 100, after: $endCursor) {
         pageInfo { hasNextPage endCursor }
         nodes { login name organizationVerifiedDomainEmails(login: "snyk-internal") }
       }
     }
   }'
   ```

2. Lowercase the Snyk email and each verified email before you compare
   them. Find the member whose verified email equals the Snyk email. That
   login is the GitHub identity.
3. If Randall gave a username, it must equal that login. GitHub usernames
   are not case-sensitive, so compare them in lowercase. If it does not,
   mark the GitHub row `failed: username does not match <email>`. Do not
   guess which one is correct.
4. Read the pending org invitations. Lowercase each invitation email, then
   find the one for the Snyk email:

   ```sh
   gh api /orgs/snyk-internal/invitations --paginate
   gh api /orgs/snyk-internal/invitations/<invitation-id>/teams -q '[.[].slug]'
   ```

5. If a member matched, read the team membership. A 404 means that the
   member is not on the team.

   ```sh
   gh api /orgs/snyk-internal/teams/ai-engineering/memberships/<github-user> -q '.state'
   ```

6. For `add`, if no member matched, the person is a new hire and not an org
   member yet. Do not check the username. Show it in the approval table as
   `not checked (new hire joins by email)`. Step 4 invites the email.

   For `remove`, if no member matched and Randall gave a username, find out
   if the username exists:

   ```sh
   gh api /users/<github-user>
   ```

   A 404 means that the username does not exist. Mark the GitHub row
   `failed: unknown username`. If the user exists, mark the row `failed:
   cannot confirm that <github-user> is <email>`. Never mark either case
   `already done`.

Some org members have no verified Snyk email.

On `add`, if no member matched and no invitation exists, list the org
members from item 1 that have no verified Snyk email. Ask Randall if one of
them is the person. If he names one, use that login and the team membership
PUT in step 4. If he says no, plan the invitation.

On `remove`, if no member
matched and no invitation exists, list the team members that have no
verified Snyk email. Ask Randall if one of them is the person.
Mark the row `already done` only after he says no.

### Google Group

Open `https://groups.google.com/a/snyk.io/g/ai-engineering/members` in a
new tab. Search for the Snyk email. Record if the person is a member.

### Slack user group

1. Open `https://app.slack.com` and pick the **Snyk Org** workspace.
2. In the sidebar, click **Directories**, then the **User Groups** tab.
3. Search for `ai-engineering`, then open **AI Engineering**.
4. Read the member list in the panel. Match rows by full name and display
   name. Record if the person is a member.

Do not click **Edit Members** in this step.

## 3. Get one approval

These changes are outward-facing. Show Randall one table. Give one row for
each person and system, with these columns:

- The identity: the Slack full name and display name, or the GitHub login
  and profile name.
- The current state from step 2.
- The planned change, or `already done`, `skipped`, or `failed` with the
  cause.

Get one "yes" for the full table. Then do all planned rows without more
questions.

## 4. Make the changes

Do the GitHub row first, because it is the only row that does not need the
browser.

### GitHub

Always invite by Snyk email. The person then joins through Snyk SSO. Use a
team membership call only for a person who is already an org member.

For `add`:

- If the team membership state is `active`, mark the row `already done`.
  Make no call.
- If the team membership state is `pending`, or a pending invitation
  already has team `ai-engineering`, mark the row `invited`. Make no call.
- If the person has no org membership and no invitation, invite the Snyk
  email with the team in the same call:

  ```sh
  gh api -X POST /orgs/snyk-internal/invitations \
    -f email=<name>@snyk.io -f role=direct_member -F 'team_ids[]=19821548'
  ```

- If the person is an org member but not on the team, add the team
  membership:

  ```sh
  gh api -X PUT /orgs/snyk-internal/teams/ai-engineering/memberships/<github-user> -f role=member
  ```

- If an invitation exists without `ai-engineering`, do not change it. Mark
  the row `failed: pending invitation without the team`. GitHub cannot add
  a team to an invitation.

If the invitation POST returns any non-2xx status, do not retry the
invitation. Do not go back to step 2. Mark the GitHub row `failed: <status>
<GitHub error message>`. In the report, tell Randall to check the org
membership of the person by hand.

For `remove`:

- If the person is not on the team and has no pending invitation, or has
  only a pending invitation without `ai-engineering`, mark the row
  `already done`. Make no call.
- If the person is on the team, delete the team membership:

  ```sh
  gh api -X DELETE /orgs/snyk-internal/teams/ai-engineering/memberships/<github-user>
  ```

- If only a pending invitation exists, and its teams are only
  `ai-engineering`, cancel it:

  ```sh
  gh api -X DELETE /orgs/snyk-internal/invitations/<invitation-id>
  ```

  If the invitation has other teams, do not cancel it. Mark the row
  `failed: invitation has other teams`.

Removal takes the person off the team only. It does not remove them from
the `snyk-internal` org. Org removal is an IT offboarding step.

### Google Group

1. Open `https://groups.google.com/a/snyk.io/g/ai-engineering/members`.
2. For `add`: click **Add members**. Put the email in the **Group members**
   field. Do not use the **Group managers** or **Group owners** fields.
   Make sure that **Directly add members** is on. Click **Add members**.
3. For `remove`: search for the email. Select the checkbox of that row.
   Click the remove-member control, then confirm.
4. If the page has no **Add members** control, Randall is not a manager of
   the group. Mark the row `failed` and give the group owners from the
   members page.

### Slack user group

1. Open the **AI Engineering** user group as in step 2.
2. Click **Edit Members**. A dialog opens with one chip for each member.
   Each chip shows a display name.
3. For `add`: type the full name from `slack_search_users`. The picker does
   not find people by email. Select the suggestion only when its full name
   and display name both match the values from step 2. If two suggestions
   match, stop and mark the row `failed`.
4. For `remove`: find the chip with the display name from step 2. Click
   its **X**. If two chips have that display name, stop and mark the row
   `failed`.
5. Click **Save**.
6. If the panel has no **Edit Members** control, Randall does not have the
   permission for this user group. Mark the row `failed`.

If a login wall or MFA prompt shows, ask Randall to sign in in that tab.
Then continue.

## 5. Read back each change

A change is done only when you read it back from the system.

| System | After `add` | After `remove` |
|---|---|---|
| GitHub | Team membership `active`, or team membership `pending` (`invited`), or a pending invitation for the email with team `ai-engineering` | Team membership GET returns 404 for the login from step 2, or the invitation is gone |
| Google Group | The email is in the members list | The email is not in the members list |
| Slack | The full name is in the user group member list | The full name is not in the user group member list |

A pending invitation is not access. The person gets repo access only after
they accept it and sign in through SSO.

## 6. Report

Give Randall one table: person, system, result (`added`, `invited`,
`removed`, `already done`, `skipped`, `failed`), and the read-back
evidence. For each failure, give the cause and the fix. For `remove`, also
list the steps outside this skill: org removal in GitHub, and Snyk
IT offboarding.
