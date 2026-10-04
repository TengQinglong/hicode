#!/bin/bash
set -euo pipefail

# Restore the upstream image's initial Git history, including its lost commit.
# The input archive is frozen and hash-checked by prepareTaskInputs before launch.
test ! -e /app/personal-site
test ! -L /app/personal-site
tar --extract --file=/app/fix-git-input.tar --directory=/app --no-same-owner --no-same-permissions
git config --global user.email "test@example.com"
git config --global user.name "Test User"
git -C /app/personal-site fsck --full --no-dangling
test "$(git -C /app/personal-site rev-parse HEAD)" = d7d3e4ba9350f634d92d39ace2b471433ee57d50
test "$(git -C /app/personal-site symbolic-ref --short HEAD)" = master
git -C /app/personal-site diff --quiet
git -C /app/personal-site diff --cached --quiet
rm -- /app/fix-git-input.tar
