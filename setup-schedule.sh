#!/usr/bin/env sh
# SPDX-License-Identifier: MIT
# Registers a weekly cron job (Mon 09:00) that rebuilds the c3 catalog.
# The rebuild is HTTP-only (no LLM calls), so it costs nothing but a few seconds of CPU.
set -e
NODE="$(command -v node)"
SCRIPT="$HOME/.claude/skills/ccc/scripts/build-index.mjs"
( crontab -l 2>/dev/null | grep -v 'c3-catalog-update' ; echo "0 9 * * 1 $NODE $SCRIPT # c3-catalog-update" ) | crontab -
echo "Registered weekly cron job 'c3-catalog-update' (Mon 09:00)."
echo "Remove by deleting the 'c3-catalog-update' line via: crontab -e"
