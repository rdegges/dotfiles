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


## AI coding tools

- **Claude Code** (`claude`) — installed to `~/.local/bin` via the official
  installer (`run_once_install-claude-code.sh.tmpl`).
- **Codex** (`codex`) — installed via the Homebrew cask.
- **herdr** — terminal multiplexer for AI agents, installed via Homebrew.

`run_onchange_reconcile-agent-clis.sh.tmpl` keeps exactly one copy of `claude`
and `codex` on each box: it removes stray installs from other channels (npm
globals, an extra Homebrew cask) so the managed install is the only one on PATH.

Shell aliases (see `dot_oh-my-zsh/custom/aliases.zsh.tmpl`): `cc` (claude with
permissions bypassed), `cx` (codex with approvals/sandbox bypassed), `agentp`
(herdr on the personal server), and `agentw` (herdr on the work server, defined
only when `work = true`).
