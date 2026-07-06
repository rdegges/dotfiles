#!/bin/bash
#
# Bootstrap my dotfiles.

# Install Homebrew.
echo "Installing Homebrew..."
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Configure Homebrew for this bootstrap shell. chezmoi installs the managed
# ~/.zprofile (which runs brew shellenv) later, so we only need brew active now.
# Works on both Apple Silicon (/opt/homebrew) and Intel (/usr/local).
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
echo "Homebrew installed!"

# Install Git.
echo "Installing Git..."
brew install git
echo "Git installed!"

# Install Starship.
echo "Installing Starship..."
brew install starship
echo "Starship installed!"

echo "Creating SSH key..."
ssh-keygen -t rsa -C "r@rdegges.com" -f ~/.ssh/id_rsa -N ""
echo "SSH key created!"

echo "Copy the SSH key below and add it to your GitHub profile: https://github.com/settings/keys"
cat ~/.ssh/id_rsa.pub

echo "Press ENTER to continue..."
read

echo "Installing oh my zsh..."
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
echo "oh my zsh installed!"

echo "Installing chezmoi..."
brew install chezmoi
echo "chezmoi installed!"

echo "Syncing Homebrew packages and dotfiles..."
chezmoi init --apply git@github.com:rdegges/dotfiles.git
echo "Homebrew packages and dotfiles installed!"

echo "Installing development tools..."
asdf plugin add python
asdf plugin add nodejs
asdf plugin add golang
asdf plugin add pipx
asdf plugin add uv
asdf plugin add bun

asdf install python latest
asdf install nodejs latest
asdf install golang latest
asdf install pipx latest
asdf install uv latest
asdf install bun latest

asdf set python latest --home
asdf set nodejs latest --home
asdf set golang latest --home
asdf set pipx latest --home
asdf set uv latest --home
asdf set bun latest --home

echo "Development tools installed!"
