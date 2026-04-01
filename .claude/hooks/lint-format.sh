#!/bin/bash
# Claude Code PostToolUse hook — lints and formats edited files.
# Runs on the single changed file (not the whole project) for speed (~1.5s vs ~26s).
# Parses the file path from JSON stdin because the hook API doesn't expose it directly.
# Always exits 0 so errors appear as feedback to Claude, not as blocked operations.
#
# Note: --cache only tracks the linted file's hash, not its dependents. If an exported
# type changes, other files' cached results won't re-run. Fine for the feedback loop;
# run full `yarn lint` before committing.

if ! command -v jq &>/dev/null; then
  echo "WARNING: jq not installed, skipping lint hook" >&2
  exit 0
fi

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [[ -z "$FILE_PATH" || ! -f "$FILE_PATH" || ! "$FILE_PATH" =~ \.(ts|tsx|js|jsx)$ ]]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR" || exit 0

# ESLint first (correctness + auto-fix), then Prettier last (final word on formatting).
yarn eslint --fix --cache "$FILE_PATH" 2>&1
yarn prettier --write "$FILE_PATH" 2>&1

exit 0
