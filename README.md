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


## Email (Himalaya)

The [Himalaya CLI](https://github.com/pimalaya/himalaya) is configured for my iCloud Mail account at `~/.config/himalaya/config.toml`. The config never stores the password — it shells out to macOS `security(1)` at runtime to read an app-specific password from the Keychain.

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
