#!/bin/bash
#
# Bootstrap my dotfiles.

# Install Homebrew.
echo "Installing Homebrew..."
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Configure Homebrew.
(echo; echo 'eval "$(/opt/homebrew/bin/brew shellenv)"') >> ~/.zprofile
source ~/.zprofile
echo "Homebrew installed!"

# Install Git.
echo "Installing Git..."
brew install git
echo "Git installed!"

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
asdf install python latest
asdf install nodejs latest
asdf install golang latest
asdf global python latest
asdf global nodejs latest
asdf global golang latest
echo "Development tools installed!"
