#!/bin/bash
# Stop hook: crash-safe local backup of uncommitted work. Never touches git history.
# Writes .backups/<timestamp>.patch (tracked changes) + .tgz (untracked files); keeps the last 20 of each.
cd "$(dirname "$0")/../.." || exit 0
[ -n "$(git status --porcelain 2>/dev/null)" ] || exit 0
mkdir -p .backups
ts=$(date +%Y-%m-%d_%H-%M-%S)
git diff HEAD > ".backups/$ts.patch" 2>/dev/null
untracked=$(git ls-files --others --exclude-standard)
[ -n "$untracked" ] && git ls-files -z --others --exclude-standard | tar -czf ".backups/$ts.untracked.tgz" --null -T - 2>/dev/null
ls -1t .backups/*.patch 2>/dev/null | tail -n +21 | xargs -I{} rm -f "{}"
ls -1t .backups/*.untracked.tgz 2>/dev/null | tail -n +21 | xargs -I{} rm -f "{}"
exit 0
