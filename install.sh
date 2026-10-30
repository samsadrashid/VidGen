#!/usr/bin/env sh
# Install VidGen skill + slash commands (wrapper around install.mjs; macOS only in v1).
#   ./install.sh                 -> ~/.claude (Claude Code, user-wide)
#   ./install.sh --project DIR   -> DIR/.claude (single project)
#   ./install.sh --target DIR    -> DIR/skills/vidgen + DIR/commands (other agents with same layout)
command -v node >/dev/null 2>&1 || { echo "ERROR: node not found (need >= 20)" >&2; exit 1; }
exec node "$(dirname "$0")/install.mjs" "$@"
