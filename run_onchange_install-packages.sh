#!/bin/bash

# Install Homebrew packages
if command -v brew &> /dev/null; then
    echo "Installing Homebrew packages from Brewfile..."
    brew bundle --file=~/.brew/Brewfile
else
    echo "Homebrew not found. Skipping Brewfile installation."
fi
