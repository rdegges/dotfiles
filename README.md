# dotfiles

My personal dotfiles, managed by [chezmoi](https://www.chezmoi.io).


## Usage

To use these, you must do a few things first:

- Install [Homebrew](https://brew.sh)
- Install Git
- Upload a new SSH key to GitHub (so you can use SSH for this repo)
- Install [oh my zsh](https://ohmyz.sh)
- Install chezmoi

Finally, you'll want to run:

```bash
chezmoi init --apply git@github.com:rdegges/dotfiles.git
```

After that, launchd runs `chezmoi update --force` hourly at :15 through
`~/.cron/chezmoi-update.sh` (source: `dot_cron/executable_chezmoi-update.sh`).
Output goes to `~/.cron/logs/chezmoi.log`. A failure writes
`~/.cron/logs/chezmoi.FAILED`, and every new shell prints it in red until a
later run succeeds. To fix it, read the log and run `chezmoi update` by hand.

On work machines (`work = true`), SSH to `github.com` goes over
port 443 (`ssh.github.com`), not port 22. On other machines chezmoi does not
manage `~/.ssh` at all, and it never deletes a config that is already there.
Some networks drop port 22 at random, and the hourly update then failed with
`Operation timed out`. The source is `private_dot_ssh/private_config`, which
becomes `~/.ssh/config`. Its `HostKeyAlias` uses the `github.com` key that is
already in `known_hosts`, so unattended runs do not stop at a host key prompt.
The hourly job owns ~/.ssh/config and overwrites it; put machine-local hosts
in ~/.ssh/config.local, which it includes. bootstrap.sh still makes its first
clone over port 22, before this config exists, so run it on a network that
allows port 22.


## Scheduled jobs (launchd)

On macOS, per-user launchd agents run the scheduled jobs. Each job has one
`private_Library/LaunchAgents/com.rdegges.<job>.plist.tmpl`, and all of them use
the shared `.chezmoitemplates/launchagent.plist`. When an agent or the template
changes, `run_onchange_after_load-launch-agents.sh.tmpl` loads the agents again.
Each job still writes its log to `~/.cron/logs/<job>.log`.

If the Mac sleeps through a job's time, launchd runs the job once when the Mac
wakes. Cron skipped these runs.

- To list the loaded jobs, run `launchctl print gui/$UID | grep com.rdegges`.
- To run a job now, run `launchctl kickstart gui/$UID/com.rdegges.<job>`.

The hourly chezmoi job cannot load its own agent again. If an hourly apply
changes an agent, the load script loads the other agents and then fails. As a
result, `chezmoi.FAILED` shows. `chezmoi.log` tells you to run `chezmoi apply`
by hand.

The jobs used to run from cron. `run_onchange_after_retire-crontab.sh.tmpl`
removes the old crontab. If it cannot (from cron, `crontab` hangs on a macOS
privacy prompt), it writes `~/.cron/logs/crontab.FAILED`. Then run
`crontab -r && rm -f ~/.cron/logs/crontab.FAILED` once by hand.


## Bootstrap

To bootstrap all of the steps above, I've simplified it into a quick script you can run here.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/rdegges/dotfiles/main/bootstrap.sh)"
```


## Work vs. personal machines

By default, everything in here is personal config and installs on **every** machine. Work-specific config and tooling is gated behind a single `work` flag, so it only lands on machines where I explicitly opt in (e.g. my Snyk laptop).

`work` is a chezmoi data variable defined in `.chezmoi.toml.tmpl`. On `chezmoi init`, chezmoi asks once — _"Is this a work (Snyk) machine?"_ — and persists the answer to that machine's **local** config (`~/.config/chezmoi/chezmoi.toml`), which is never synced to this repo:

```toml
[data]
  work = false   # true on a work machine
```

Because the value lives in each machine's local config, the same source tree renders differently per machine. To flip an existing machine, just re-run init and answer the prompt (it only asks when the value isn't already set):

```bash
chezmoi init   # answer "yes" to the work prompt
```

To make any new item work-only, gate it on `.work` — this works in any template (`*.tmpl`), including install scripts and config files:

```
{{ if .work }}
# work-only config / packages / install steps here
{{ end }}
```

Several things consume this pattern today: the Himalaya email config (below), the `agentw` shell alias (a work-only agent server), and gated blocks in the install/cron scripts. For example, the personal iCloud account renders everywhere, while the work Gmail account only renders when `work = true`.


## Email (Himalaya)

The [Himalaya CLI](https://github.com/pimalaya/himalaya) is configured for my iCloud Mail account at `~/.config/himalaya/config.toml`. The config never stores the password — it shells out to macOS `security(1)` at runtime to read an app-specific password from the Keychain.

A second, work-only Snyk Gmail account is defined in the same config but gated behind the `work` flag (see [Work vs. personal machines](#work-vs-personal-machines)), so it only renders on my work laptop.

On `chezmoi apply`, a one-shot bootstrap script (`run_once_install-himalaya.sh.tmpl`) installs the himalaya binary to `~/.local/bin` via the [official installer](https://github.com/pimalaya/himalaya#pre-built-binary).

The only per-machine step is loading the iCloud app password into the Keychain:

1. Generate an app-specific password at <https://account.apple.com> (Sign-In and Security → App-Specific Passwords).
2. Store it in the login Keychain under the service name the config expects:

   ```bash
   read -rs "?Paste app password: " PW; \
     security add-generic-password -U -s himalaya-icloud -a r@rdegges.com -w "$PW"; \
     unset PW
   ```

3. Verify it works:

   ```bash
   himalaya folder list
   ```


## Toolchain (asdf)

Language runtimes and CLI tools (Python, Node, Go, uv, pipx, Bun) are managed by
[asdf](https://asdf-vm.com). asdf itself is installed via Homebrew (see
`dot_brew/Brewfile`); its data dir (`~/.asdf`) is created on first use.

Exact versions are pinned in `~/.tool-versions` (managed by chezmoi as
`dot_tool-versions`) so every machine resolves the same toolchain. To move to
newer releases, `asdf install <tool> latest`, `asdf set <tool> <version> --home`,
then `chezmoi add ~/.tool-versions` and commit.


## Cloudflare (cf)

The [Cloudflare CLI](https://developers.cloudflare.com/cf/) (`cf`) is installed as an npm global on the asdf Node, because Cloudflare ships it only through npm. `~/.cron/cf-update.sh` (source: `dot_cron/executable_cf-update.sh`) does the install. Two things run it:

- `run_onchange_after_install-cloudflare-cli.sh.tmpl`, on `chezmoi apply`, when `~/.tool-versions` or the script changes. npm globals live per Node version, so a Node bump would otherwise drop `cf`.
- launchd, daily at 10:10, to update to `cf@latest`. Output goes to `~/.cron/logs/cf.log`. A failure writes `~/.cron/logs/cf.FAILED`, and every new shell prints it in red until a later run succeeds.

Run `~/.cron/cf-update.sh` to update immediately.

The only per-machine step is `cf auth login`. `cf` keeps its own credentials, outside the dotfiles.


## AI coding tools

- **Claude Code** (`claude`) — installed to `~/.local/bin` via the official
  installer (`run_once_install-claude-code.sh.tmpl`).
- **Codex** (`codex`) — installed to `~/.local/bin` via the
  [official standalone installer](https://learn.chatgpt.com/docs/codex/cli)
  (`run_once_install-codex.sh.tmpl`). launchd runs the built-in `codex update`
  hourly at :20, with output in `~/.cron/logs/codex.log`.
  Run `~/.local/bin/codex update` to update immediately.
- **Codex rules** — `~/.codex/AGENTS.md` is rendered from
  `dot_claude/CLAUDE.md.tmpl` with `reader=codex` (`dot_codex/AGENTS.md.tmpl`),
  so Claude Code and Codex share one set of global rules.
  `.chezmoiremove` deletes the old `~/AGENTS.md` copy and the unmanaged
  `~/.codex/agents/*.toml` agent copies: Codex opens PRs but runs no review gates.
- **Codex skills** — Codex reads `~/.agents/skills`, not `~/.claude/skills`. For each
  skill the Codex rules name, `dot_agents/skills/symlink_<name>` links
  `~/.agents/skills/<name>` to `../../.claude/skills/<name>`, so Codex reads the live
  Claude skill, not a copy. chezmoi manages only those links; the rest of
  `~/.agents/skills` belongs to the `skills` tool (`dot_agents/skills.txt`).
- **herdr** — terminal multiplexer for AI agents, installed via Homebrew.
- **opencode** (`opencode`) — installed via Homebrew from homebrew-core.
  Not from upstream's `anomalyco/tap`: its `opencode` formula is still OpenCode 1, and its separate `opencode-v2` formula conflicts with core's.
  `~/.config/opencode/AGENTS.md` is rendered from `dot_claude/CLAUDE.md.tmpl`
  with `reader=opencode` (`dot_config/opencode/AGENTS.md.tmpl`), so opencode reads the same
  bytes as `~/.claude/CLAUDE.md` except the Browser section. OpenCode 2 reads only `~/.config/opencode/AGENTS.md` for global rules and has no `~/.claude/CLAUDE.md` fallback, so this managed file is the only way the rules reach opencode. Outside the Browser section the copy is verbatim on purpose, so opencode also sees Claude-only rules (the acceptance-gate agents) that it cannot run. The Browser section points opencode at its built-in `browser` tools (Code Mode `tools.browser.*`). These tools work only in sessions that run in the OpenCode desktop app (`cask "opencode-desktop"`, the official cask from opencode.ai/download), and they drive the app's browser pane, not the real Chrome profile. In the terminal, opencode tells me the task needs the desktop app and stops. Codex and opencode are both told to use only their own browser tool. The desktop app updates itself and bundles its own opencode, while the CLI comes from homebrew-core; when the two versions differ, the app restarts the shared opencode background service (`version-mismatch`), which may interrupt a running terminal session.
- **REA** ([rea.tools](https://rea.tools)) — reverse-engineering MCP server
  and skill. `~/.cron/rea-update.sh` installs `rea-agents@latest` as an npm global on the
  asdf Node, the same way as `cf`. launchd runs it daily at 10:25, and
  `run_onchange_after_install-rea.sh.tmpl` runs it when `~/.tool-versions`
  changes. After each install it runs REA's own `rea setup` for Claude Code and
  opencode, which registers the server and installs the matching
  `reverse-engineer-anything` skill. chezmoi owns `~/.codex/config.toml`, so the
  Codex entry is in `dot_codex/config.toml.tmpl` instead. The script then runs
  `rea doctor --client codex`. If a new REA release expects a different entry,
  the script writes `~/.cron/logs/rea.FAILED`. The optional native engines
  (Hopper, Ghidra, IDA) are not installed. Static JavaScript, .NET, and web
  analysis work without them. Codex reads the skill from `~/.agents/skills`,
  which the opencode setup step writes. Setup re-enables the opencode entry
  each day if you disable it, and leaves `~/.claude.json.rea.backup` and
  `opencode.json.rea.backup` beside the live files.
- **WorkOS MCP** — on personal machines (`work = false`),
  `run_onchange_after_add-workos-mcp.sh.tmpl` registers the
  [WorkOS management MCP server](https://workos.com/docs/mcp) at user scope
  with `claude mcp add`. It does not manage `~/.claude.json`, which is Claude
  Code state. The only per-machine step is to run `/mcp` in Claude Code once and
  finish the WorkOS OAuth sign-in. The script reruns only when its text changes; if you remove the server by hand, add it back with `claude mcp add --scope user --transport http workos https://mcp.workos.com/mcp`.

`run_onchange_reconcile-agent-clis.sh.tmpl` keeps exactly one copy of `claude`
and `codex` on each box: it removes stray installs from other channels (npm
globals, an extra Homebrew cask) so the managed install is the only one on PATH.

Shell aliases (see `dot_oh-my-zsh/custom/aliases.zsh.tmpl`): `cc` (claude with
permissions bypassed), `cx` (codex with approvals/sandbox bypassed), `agentp`
(herdr on the personal server), and `agentw` (herdr on the work server, defined
only when `work = true`).
