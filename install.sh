#!/usr/bin/env sh
# c3 installer: copies the skill and the /c3 alias into ~/.claude
set -e
DEST="${HOME}/.claude"
mkdir -p "$DEST/skills" "$DEST/commands"
cp -r skills/ccc "$DEST/skills/"
cp commands/c3.md "$DEST/commands/"
echo "Installed /ccc and /c3. Restart your Claude Code session to load them."
