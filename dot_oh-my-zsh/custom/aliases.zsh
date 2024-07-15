# Process handling.
alias psg="ps aux | grep"
alias ka9="killall -9"
alias k9="kill -9"

# Show human friendly numbers and colors.
alias df="df -h"
alias l="ls -ah"
alias ll="ls -alh"
alias du="du -sh"
alias df="df -h"

# Listing files.
alias lsg="ll | grep"

# Common shell functions.
alias tf="tail -f"
alias lh="ls -alt | head"
alias tmux="TERM=xterm-256color tmux"
alias cl="clear"
alias ps="ps aux"

# Quick file zipping.
alias gz="tar -zcvf"

# Vim helpers.
alias v="nvim"

# ZSH helpers.
alias zr="source ~/.zshrc"

# Python helpers.
alias pt="python setup.py test"
alias pyc="rm *.pyc"

# Node helpers.
alias nt="npm test"

# asdf helpers.
alias aa="asdf latest --all"
alias aa="asdf current"
alias ai="asdf install"
alias ap="asdf plugin list all"

# Dotfile helpers.
alias ca="chezmoi add"
alias ce="chezmoi edit"
alias ci="echo 'chezmoi init --apply git@github.com:<GITHUB_USERNAME>/dotfiles.git'"
alias cu="chezmoi update --force"
alias cy="chezmoi apply"

# Brew helpers.
alias bd="brew bundle dump --force --file=~/.brew/Brewfile; chezmoi add ~/.brew/Brewfile"
alias bi="brew install"

# Mac helpers.
alias dstore="find . -name '.DS_Store' -delete"
