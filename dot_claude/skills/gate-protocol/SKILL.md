---
name: gate-protocol
description: "Load before you launch the acceptance-gate workflow, when a gate returns, and after a PR merges or is abandoned. The steps around a gate: what to commit when it returns, when the tree is clean enough for the next gate, and how to clean up the worktrees that the implementer, tester, and gate agents made."
---

## Gate protocol

The global rules say when a change needs the `acceptance-gate` workflow. This
skill holds the steps around it. The steps were in the global rules. They moved
here because they matter only around a gate, and the global rules load in every
session.

### When a gate returns

- When it returns, commit the files the tester's report lists under Tests added/modified, as they are (red included), in their own commit on the branch under review, and push it if the branch has a remote; delete tests meant to be ephemeral (scratch probes, throwaway harnesses) instead.
- After REVISE, the rework goes back through the full workflow on that committed tip.

### Before the next gate

- Launch the next gate only when `git status --porcelain` is empty, or when `git status --porcelain -uall` prints only `?? .claude/worktrees/agent-*/` lines and `git -C <wt> status --porcelain` exits 0 and prints nothing in each of those worktrees, and name any leftover path to me.
- Never edit the tree while a gate runs.

### Worktree cleanup

- After a PR merges or is abandoned, clean up the worktrees its implementer, tester, and gates reported. Use the exact paths from their reports and never pick worktrees by pattern, because another agent may be working in one. First run `git -C <repo> fetch -q origin`. Run `git worktree remove` (never `--force`) on a worktree only when `git -C <wt> status --porcelain` exits 0 and prints nothing, and one of these holds: `git -C <wt> merge-base --is-ancestor HEAD origin/<base>` passes, or `gh pr view <n> --json state,headRefOid` shows `MERGED` and `headRefOid` equals `git -C <wt> rev-parse HEAD`. Then run `git worktree prune` and delete the branches those agents created. Use `git branch -d`, or `git branch -D` only for a branch whose tip equals that merged `headRefOid`. Name to me any worktree that is dirty, unmerged, or orphaned (a dir under `.claude/worktrees` that `git worktree list` does not show), and any branch that `git branch -d` refuses and `git branch -D` is not allowed to delete, and leave them in place.
