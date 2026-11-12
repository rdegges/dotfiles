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
Output goes to `~/.cron/logs/chezmoi.log`. A failed update writes
`~/.cron/logs/chezmoi.FAILED`, and every new shell prints it in red until a
later run succeeds. To fix it, read the log and run `chezmoi update` by hand.
A run that skips because the network is down writes no marker, unless no run
has succeeded in the last 24 hours (see
[Scheduled jobs (launchd)](#scheduled-jobs-launchd)).

On every machine, SSH to `github.com` goes over port 443 (`ssh.github.com`),
not port 22. Some networks drop port 22 at random, and the hourly update then
failed with `Operation timed out`. The source is
`private_dot_ssh/private_config`, which becomes `~/.ssh/config`. Its
`HostKeyAlias` uses the `github.com` key that is already in `known_hosts`, so
unattended runs do not stop at a host key prompt. bootstrap.sh still makes its
first clone over port 22, before this config exists, so run it on a network
that allows port 22.

The hourly job owns `~/.ssh/config` and overwrites it. Put machine-local hosts
in `~/.ssh/config.local`, which it includes first. If the existing
`~/.ssh/config` lacks the line `Include ~/.ssh/config.local`,
`run_once_before_preserve-ssh-config.sh` copies it once to
`~/.ssh/config.local` before the apply replaces it. If
`~/.ssh/config.local` already exists, the script stops the apply and writes
nothing. Then merge `~/.ssh/config` into `~/.ssh/config.local` by hand,
delete `~/.ssh/config`, and run `chezmoi apply` again. The copy runs only in a
full `chezmoi apply` or `chezmoi update`; `chezmoi apply ~/.ssh` runs no
scripts and replaces a hand-written config without copying it, so make the
first apply on a machine a full one.

OpenSSH uses the first value it finds for each setting, so the local file
wins. As a result, a migrated config that sets `Hostname` or `Port` for
`github.com` or under `Host *` quietly cancels port 443.


## Scheduled jobs (launchd)

On macOS, per-user launchd agents run the scheduled jobs. Each job has one
`private_Library/LaunchAgents/com.rdegges.<job>.plist.tmpl`, and all of them use
the shared `.chezmoitemplates/launchagent.plist`. When an agent or the template
changes, `run_onchange_after_load-launch-agents.sh.tmpl` loads the agents again.
Each job still writes its log to `~/.cron/logs/<job>.log`.

Jobs print with `printf '%s\n'`, never `echo`. A job that puts CLI output in a
marker or mail cleans it with `oneline` from `~/.cron/lib/text.sh`. The shell
banner removes control characters. `tests/cron/text-lib.test.mjs` enforces
this.

If the Mac sleeps through a job's time, launchd runs the job once when the Mac
wakes. Cron skipped these runs.

At wake, Wi-Fi and DNS are often not back yet, so the chezmoi, cf, and rea
jobs first run `~/.cron/wait-for-network.sh`. This script waits up to 60
seconds for a default route and a DNS answer for `github.com`. If the network
is still down, the job logs `network not up; skipped`, exits 0, and never
removes or rewrites an existing `.FAILED` marker. If the wait script is missing or cannot check the
network, the job runs as before.

Each successful run touches `~/.cron/logs/<job>.ok`. If no marker exists and no
run succeeded in the last 24 hours (chezmoi) or 72 hours (cf, rea), the skip
writes the marker with `network check failed and no successful run in N hours`.
Right after this change deploys, no stamp exists yet. Thus the first skip can
show one "no successful run" banner, and the next successful run clears it.

- To list the loaded jobs, run `launchctl print gui/$UID | grep com.rdegges`.
- To run a job now, run `launchctl kickstart gui/$UID/com.rdegges.<job>`.

The hourly chezmoi job cannot load its own agent again. If an hourly apply
changes an agent, the load script loads the other agents and then fails. As a
result, `chezmoi.FAILED` shows. `chezmoi.log` tells you to run `chezmoi apply`
by hand.

### Tailscale watchdog (homelab only)

On the homelab server Mac (`homelab = true`, see
[Work vs. personal machines](#work-vs-personal-machines)), launchd runs
`~/.cron/tailscale-watchdog.sh` every 5 minutes, at :02, :07, and so on to :57.
In the normal case, this schedule keeps the job away from the hourly chezmoi
apply at :15. A worst-case run lasts about 4.5 minutes, so a run that starts at
:12 can still be running at :15. In that case the load script leaves the job
alone and sets `chezmoi.FAILED`, and the next apply tries again.

Tailscale updates stay with the App Store (or the updater of the Standalone
build). The watchdog does not update the app. It makes sure that the client is
up:

- If the Tailscale app is not running, the job starts it with
  `open -g -b <bundle id>`. Both the App Store build (`io.tailscale.ipn.macos`)
  and the Standalone build (`io.tailscale.ipn.macsys`) work.
- If the state is `Stopped` and the client is logged in, the job runs
  `tailscale up` with no flags. This is the fault in
  [tailscale/tailscale#21825](https://github.com/tailscale/tailscale/issues/21825),
  where an App Store update stops the client.
- Every other state is a failure: `NeedsLogin`, `NeedsMachineAuth`, logged out,
  still not `Running` after the fix, or output that the job cannot read. If
  `tailscale up` refuses because the node has non-default settings, that is a
  failure too. The job never guesses flags, never logs in, and never changes
  the build.

A failure writes `~/.cron/logs/tailscale-watchdog.FAILED`, and every new shell
prints it. The job also sends mail to r@rdegges.com through the himalaya
account `icloud`. Mail goes out only when the state changes. A fix or a
recovery sends one mail. The job does not wait for the network, because an
outage is what it reports.

Every outage is mailed at least once, also when its first alert cannot be
sent. `~/.cron/logs/tailscale-watchdog.state` is one line:

- `Running` when Tailscale is up.
- `<key> mailed <since>` when the alert for the outage went out.
- `<key> unsent <since>` when the alert did not go out yet.

`<key>` is the failure, for example `NeedsLogin`. `<since>` is the local time
when the job first saw the outage (`2026-11-11T17:12`), or `-` when that time
is not known. While the state is `unsent`, each run sends the alert again.
If Tailscale recovers first, the recovery mail says that the outage was never
reported, with its key and its first-seen time. The FAILED marker says when an
alert is still unsent.

The older state file held one word: `Running`, or the key of the last mail.
The job reads such a word as `<key> mailed -`, so the update sends no repeat
mail.

A deliberate `tailscale down` on the homelab Mac is undone within 5 minutes,
and each fix sends one "recovered" mail. To keep Tailscale down on purpose,
first run `launchctl bootout gui/$UID/com.rdegges.tailscale-watchdog`. The
agent comes back at the next login or the next agent change.

### App updates (homelab only)

On the homelab server Mac, launchd runs `~/.cron/app-update.sh` at 02:40, 03:40,
04:40, and 05:40. The first run that finds the Mac idle does one pass. The later
runs that night find today's `~/.cron/logs/app-update.ok` and exit.

Before it does anything, the job makes sure that the Mac is not in use. A check
that cannot give an answer counts as "in use":

- The local hour must be 02 to 05. A launchd run after a wake, outside these
  hours, exits with `outside window`.
- The network must be up (`wait-for-network.sh`).
- No file under `~/.claude/projects` or `~/.codex/sessions` changed in the last
  20 minutes.
- Nobody used the keyboard or mouse in the last 30 minutes.
- The 5-minute load average is 4 or less.

The job finds each app by its exact bundle id, never by process name. To quit
an app, it sends `kill -TERM` to the main process and waits up to 60 seconds.
It never sends SIGKILL and never uses AppleScript. Then it runs
`open -g -b <bundle id>`. The mail says "updated" only when the version in the
app's `Info.plist` changed. The job never leaves an app that it quit in a
stopped state, unless `open` fails. If an app does not come back, the job puts
it in `~/.cron/logs/app-update.down`. Each later pass writes FAILED again until
the app runs.

| App | What the job does |
| --- | --- |
| Herdr | Relaunches it when `/Applications/Herdr.app.new.noindex` exists. The agent shells are children of `herdr-core hold`, not of Herdr.app. The hold process outlives the broker. After a relaunch, launchd is its parent, and its PID and socket stay the same. The launch of Herdr.app restarts `herdr-core --hc-launchd`, a broker that owns no shell. The launch also applies the staged bundle. The job records the PID and args (with `--socket`) of each hold before the quit, and starts Herdr as soon as it exits. After the relaunch, the job waits up to 60 seconds until `Herdr.app.new.noindex` is gone, then 15 seconds for the broker. If the bundle stays, or a hold is gone or has other args, or no broker runs, the job writes FAILED. A new broker PID is not a failure. If no hold runs before the quit, the job does not relaunch Herdr. If the relaunch ends a `herdr-core connect` client in a terminal, the mail tells you to attach it again. The `herdr_class` line at the top of the script sets the mode: `relaunch` or `report`. |
| T3 Code, Fastmail, 1Password | Relaunch when `~/Library/Caches/<bundle id>.ShipIt/ShipItState.plist` exists and the update bundle that its `updateBundleURL` names also exists. Squirrel never deletes the plist. ShipIt moves or deletes the update bundle when it installs. After the quit, the job waits up to 120 seconds until no ShipIt for that app runs and the update bundle is gone. Then it starts the app. If the 120 seconds run out, the job waits up to 60 seconds more for ShipIt to stop, then starts the app anyway and writes FAILED. 1Password comes back locked, so `op` fails until you unlock it. On this Mac, the Squirrel probe has only been seen to fire for Claude Desktop. For T3 Code, Fastmail, and 1Password it is not measured. |
| Claude Desktop | Same as above, but only when no `claude` process runs under it and its session files and VM disk did not change in the last hour. Otherwise the mail says "skipped: session active". |
| Chrome | Report only, because a quit loses tabs. The mail tells you when the installed version differs from the running version. |
| Downie, Ghostty | Report only. The job reads the Sparkle feed (`SUFeedURL`) and tells you when a newer version is available. Ghostty's `Info.plist` has no `SUFeedURL`, so the job reads Ghostty's published feed, `https://release.files.ghostty.org/appcast.xml`. Only version numbers such as `1.4.0` count. The build labels in Ghostty's feed do not count. |
| Docker Desktop | Once a week, on Sunday (the 02:40 Sunday run is Saturday night). It also runs on any other night when `~/.cron/logs/app-update-docker.ok` is older than 8 days or missing. The job does not update Docker while a container runs. It runs `docker desktop update --quiet` (at most 20 minutes) and waits up to 10 minutes for Docker to answer again. |

The job does not update the Claude Code CLI, which updates itself.

The job sends mail to r@rdegges.com (himalaya account `icloud`) only when an app
changed, failed, or needs a relaunch by hand. A night with nothing to do sends
no mail. Warnings, such as a feed that the job cannot read, are part of the
mail but do not cause one. The "relaunch by hand" list of the last mail is in
`~/.cron/logs/app-update.reported`. A night with no failure, no change, and
the same list sends no mail. A failure, or a mail that the job cannot send,
writes `~/.cron/logs/app-update.FAILED`, and every new shell prints it. Only a
pass with no failure removes the marker. If no pass completes in 7 days, a
skipped run writes the marker and sends one mail.

launchd appends to `~/.cron/logs/app-update.log`. The run that does the pass
empties the log first. Thus the later runs of the night add one "already ran
today" line each, and the log of the pass stays.

Two variables are for a forced run by hand:

- `APP_UPDATE_ANY_HOUR=1` removes the hour limit. The busy checks still apply.
- `APP_UPDATE_MAIL_ACCOUNT=<account>` sends the mail from another himalaya
  account. Use an account that does not exist to force a mail failure.

`run_onchange_after_configure-homelab-updaters.sh.tmpl` sets Downie to check
for and install its own updates (`SUEnableAutomaticChecks` and
`SUAutomaticallyUpdate`). The script runs only when `homelab` is true. Downie
is sandboxed, and macOS can refuse access to its preferences. If the script
cannot write them, it writes `~/.cron/logs/homelab-updaters.FAILED` with the
commands to run once in Terminal. Ghostty's auto-update is a setting in its own
config file, so the script does not change it.

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

Several things consume this pattern today: the Himalaya email config (below), the `agentw` shell alias (a work-only agent server), the AWS SSO profile and the `aws` shell function (below), and gated blocks in the install/cron scripts. For example, the personal Fastmail accounts render everywhere, while the work Gmail account only renders when `work = true`.

Work-only Homebrew packages (today: `awscli`) go in `dot_brew/Brewfile.work`, not the shared `dot_brew/Brewfile`. chezmoi writes `~/.brew/Brewfile.work` only when `work = true`, and `run_onchange_install-packages.sh.tmpl` bundles it after the shared Brewfile. The hourly `chezmoi update` installs a new entry on every work machine, and the daily brew job upgrades it. On work machines, the `bd` alias removes the lines listed in `Brewfile.work` from the dump before it runs `chezmoi add`.

On work machines, chezmoi also writes one AWS SSO profile and wraps the `aws` command:

- `dot_config/aws/private_snyk-sandbox.config` becomes `~/.config/aws/snyk-sandbox.config`, and chezmoi owns that whole file. It defines `[sso-session snyk]` (Snyk's IAM Identity Center) and `[profile snyk-sandbox]` (my sandbox account `597564118722`, role `AWSPowerUserAccess`, region `us-west-2`).
- chezmoi never touches anything under `~/.aws`: not `~/.aws/config`, `~/.aws/credentials`, the caches, or the directory itself, so a symlinked `~/.aws` stays a symlink. `.chezmoiignore` ignores `.aws` on every machine. Other profiles stay as they are, and nothing in those files can stop the hourly update.
- The `aws` function in `dot_oh-my-zsh/custom/aliases.zsh.tmpl` uses `snyk-sandbox` when you give no `--profile` (or `--profile=`), and have no exported `AWS_PROFILE`, `AWS_DEFAULT_PROFILE`, or `AWS_ACCESS_KEY_ID`. A variable that is set but not exported does not count, because the CLI never sees it. Exported keys always go straight to the real binary.
- Every `snyk-sandbox` call runs with `AWS_CONFIG_FILE=~/.config/aws/snyk-sandbox.config` and `AWS_SHARED_CREDENTIALS_FILE=/dev/null`, set for that call only. That includes `--profile snyk-sandbox` and an exported `AWS_PROFILE=snyk-sandbox`. As a result, nothing in `~/.aws/config` (such as a `[DEFAULT]` section) or `~/.aws/credentials` can change the profile. The AWS CLI merges a credentials-file section into the profile of the same name, so that file is cut off too. Other profiles use your normal files.
- Before a `snyk-sandbox` call, the function runs `aws configure export-credentials`. That command fails when the session has expired, and the function then runs `aws sso login` (with `--use-device-code` over SSH) before your command. Login output goes to stderr.
- The `sso`, `configure`, `help`, `login`, and `logout` commands, `--version`, and `--help` skip that session check, even after global options such as `--region`. With no profile chosen, they also keep the CLI's own default, so `aws sso logout` and `aws configure list` act on `~/.aws/config`. To sign in to the sandbox by hand, run `aws sso login --profile snyk-sandbox`. A trailing `help` (such as `aws s3 help`) skips the check but keeps the profile, because some API calls end in a `help` value.
- Each call on `snyk-sandbox` starts one extra `aws` process (about 0.25s) to check the session. That cost is one reason the function exists only in interactive zsh. Scripts, SDKs, Terraform, and non-interactive shells use the real binary and do not see `snyk-sandbox`. For them, set `AWS_CONFIG_FILE=~/.config/aws/snyk-sandbox.config` yourself.
- `aws configure set` or `aws configure sso` with `--profile snyk-sandbox` edits the managed file, and the next hourly apply silently puts it back. To change the profile, edit `dot_config/aws/private_snyk-sandbox.config` in this repo.

### The homelab flag

A second flag, `homelab`, is true only on the homelab server Mac. It gates the
jobs of that Mac (today: the [Tailscale watchdog](#tailscale-watchdog-homelab-only)
and the [app updates](#app-updates-homelab-only)).
`chezmoi init` asks for it once, with the default `false`, next to `work`. A
machine that has not run `chezmoi init` since this flag was added has no
`homelab` key. Templates read the flag as `(index . "homelab")`, so a missing
key counts as `false`.

Two files gate each homelab job, and their lists must stay equal:

- `.chezmoiignore` skips the plist and the `~/.cron` script when the flag is
  not true.
- `run_onchange_after_load-launch-agents.sh.tmpl` skips the same labels under
  the same condition.

A homelab `run_` script is not in `.chezmoiignore`. Instead, its whole body is
inside `{{ if (index . "homelab") }}`, so it is empty on other machines and
chezmoi does not run it.

To turn the flag on, do these steps on the homelab Mac:

1. Run `chezmoi init` and answer "yes" to the homelab prompt.
2. Run `chezmoi apply`.
3. Run `launchctl print gui/$UID | grep -e tailscale-watchdog -e app-update`
   and make sure that both jobs are loaded.

To turn the flag off, set `homelab = false` in
`~/.config/chezmoi/chezmoi.toml`, then run `chezmoi apply`. The load script
then unloads the job. chezmoi does not delete the files of an ignored job, and
launchd loads every plist in `~/Library/LaunchAgents` at login. Thus you must
also delete the files by hand:

```bash
rm -f ~/Library/LaunchAgents/com.rdegges.tailscale-watchdog.plist ~/.cron/tailscale-watchdog.sh
rm -f ~/Library/LaunchAgents/com.rdegges.app-update.plist ~/.cron/app-update.sh
```

If you do not delete them, the job starts again at the next login. The load
script unloads it again only when an agent changes.

## Email (Himalaya)

The [Himalaya CLI](https://github.com/pimalaya/himalaya) is configured for my Fastmail accounts at `~/.config/himalaya/config.toml`. The config never stores the password — it shells out to macOS `security(1)` at runtime to read an app-specific password from the Keychain.

A second, work-only Snyk Gmail account is defined in the same config but gated behind the `work` flag (see [Work vs. personal machines](#work-vs-personal-machines)), so it only renders on my work laptop.

On `chezmoi apply`, a one-shot bootstrap script (`run_once_install-himalaya.sh.tmpl`) installs the himalaya binary to `~/.local/bin` via the [official installer](https://github.com/pimalaya/himalaya#pre-built-binary).

Every account except Snyk uses one Fastmail mailbox and reads one app password from the Keychain. Loading that password is the only per-machine step for these accounts:

1. Generate an app password in Fastmail under Settings, Privacy & Security.
2. Store it in the login Keychain under the service name the config expects:

   ```bash
   read -rs "?Paste app password: " PW; \
     security add-generic-password -U -s himalaya-fastmail -a rdegges@sent.com -w "$PW"; \
     unset PW
   ```

3. Verify it works:

   ```bash
   himalaya folder list
   ```

`himalaya-icloud` is read only by the temporary `~/Code/rdegges/dns` migration check, on the host that runs it.


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
- launchd, daily at 10:10, to update to `cf@latest`. Output goes to `~/.cron/logs/cf.log`. A failed update writes `~/.cron/logs/cf.FAILED`, and every new shell prints it in red until a later run succeeds. A run that skips because the network is down also writes this marker when the `~/.cron/logs/cf.ok` stamp is missing or more than 72 hours old (see [Scheduled jobs (launchd)](#scheduled-jobs-launchd)).

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
- **herdr** — terminal multiplexer for AI agents. The Homebrew formula is the
  `herdr` CLI. `/Applications/Herdr.app` is not from Homebrew and has its own
  updater. The agent shells are children of `herdr-core hold`, which launchd
  owns, so a quit of Herdr.app does not end the sessions. The launch of
  Herdr.app restarts `herdr-core --hc-launchd`, a broker that owns no shell, and
  applies a staged update.
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
- **Parallel Search MCP** — on personal machines (`work = false`), Claude Code,
  opencode, and Codex get [Parallel's Search MCP server](https://parallel.ai)
  (`https://search.parallel.ai/mcp`, tools `web_search` and `web_fetch`),
  signed with my API key (higher rate limits; calls spend the free $5/month
  credit). `run_onchange_after_setup-parallel-mcp.sh.tmpl` reads the key once
  from `op://Private/Parallel/credential` into `~/.config/parallel/api-key`
  (mode 0600), then registers the server with `claude mcp add-json --scope user`
  and `opencode mcp add --global`, because chezmoi does not own those tools'
  config files. The Codex entry is in `dot_codex/config.toml.tmpl`. Claude Code
  gets a `headersHelper` that reads the key file each time it connects, so the
  Claude desktop app works without a shell. opencode reads the file through
  `{file:...}`. Only Codex reads `PARALLEL_API_KEY`, which `dot_zshenv` exports
  from that file. No config stores the key. The only per-machine step: before
  the first apply, sign in to `op` and make sure that the `Private` vault has an
  API Credential item named `Parallel` with the key in its `credential` field.
  Until then every apply fails, and the hourly job shows `chezmoi.FAILED` in
  each new shell. The script reruns only when its text changes, so to rotate
  the key, update the 1Password item, run
  `(umask 077; rm -f ~/.config/parallel/api-key; op read op://Private/Parallel/credential > ~/.config/parallel/api-key)`,
  and open a new shell. The global rules file (dot_claude/CLAUDE.md.tmpl) tells
  each agent to search with Parallel instead of its built-in search tool
  wherever the server is registered, and to fall back to the built-in tool and
  tell me if Parallel is not connected.

`run_onchange_reconcile-agent-clis.sh.tmpl` keeps exactly one copy of `claude`
and `codex` on each box: it removes stray installs from other channels (npm
globals, an extra Homebrew cask) so the managed install is the only one on PATH.

Shell aliases (see `dot_oh-my-zsh/custom/aliases.zsh.tmpl`): `cc` (claude with
permissions bypassed), `cx` (codex with approvals/sandbox bypassed), `agentp`
(herdr on the personal server), and `agentw` (herdr on the work server, defined
only when `work = true`).

`dot_claude/settings.json` sets `permissions.defaultMode` to `bypassPermissions`,
so every `claude` session starts in bypass mode, not only `cc`. (The CLI reads
the mode only under `permissions`; a top-level `defaultMode` is ignored.)

It also sets `remoteControlAtStartup` to `true`, so every interactive `claude`
session starts the Remote Control bridge and I can drive it from my claude.ai
account. The `vault-agent-settings.json` profile sets it to `true` too, by
choice. As of Claude Code 2.1.322 the key does nothing for `claude -p` runs, so
scheduled print-mode runs do not start Remote Control.

`dot_zshenv` exports `CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS=1`.
Bypass mode still blocks a few destructive commands such as `rm -rf ~`; this
lifts that block on every box, by choice. Claude Code reads the key only from
the environment it starts in (it ignores it in any settings file), so it covers
`claude` started from a terminal or SSH, not the desktop app. Any permissions
`deny` rule (Bash, Edit or Read, as of Claude Code 2.1.322) switches the waiver
off for the session; the stricter `vault-agent-settings.json` profile keeps the
guard that way. Remove the export to get the guard back.
