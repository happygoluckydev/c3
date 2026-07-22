#!/usr/bin/env sh
# SPDX-License-Identifier: MIT
# c3 installer: copies the skill + /c3 alias into ~/.claude and writes the feature config.
# Options:
#   --no-fulltext        lite install: skip document-body indexing (smaller catalog)
#   --vectors <provider> enable hybrid vector search (gemini | voyage | openai).
#                        Provider validity is checked at first catalog build by the runtime
#                        (single source of truth: PROVIDERS in scripts/embed.mjs).
set -e
FULLTEXT=true
VECTORS=none
while [ $# -gt 0 ]; do
    case "$1" in
        --no-fulltext) FULLTEXT=false ;;
        --vectors) VECTORS="$2"; shift ;;
        *) echo "unknown option: $1" >&2; exit 1 ;;
    esac
    shift
done

DEST="${HOME}/.claude"
mkdir -p "$DEST/skills" "$DEST/commands" "$DEST/ccc"
cp -r skills/ccc "$DEST/skills/"
# Keep MIT notice with the installed skill (source of truth: repo-root LICENSE).
cp LICENSE "$DEST/skills/ccc/LICENSE"
cp commands/c3.md "$DEST/commands/"
printf '{\n    "fulltext": %s,\n    "vectors": { "provider": "%s" }\n}\n' "$FULLTEXT" "$VECTORS" > "$DEST/ccc/config.json"

echo "Installed /ccc and /c3 (fulltext=$FULLTEXT, vectors=$VECTORS)."
if [ "$VECTORS" != "none" ]; then
    KEY=$(echo "$VECTORS" | tr '[:lower:]' '[:upper:]')_API_KEY
    echo "NOTE: set the $KEY environment variable (default name) before the first catalog build."
fi
echo "Restart your Claude Code session to load the skill."
