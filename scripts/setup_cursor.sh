#!/usr/bin/env bash
# setup_cursor.sh — set up the Cursor CLI agent clone.
# Run from the root of your MASTER repo:
#   ./scripts/setup_cursor.sh [-n|--dry-run] [--force] [shared_branch] [remote_name]
#
# Cursor specifics vs the other setup scripts:
#   - Cursor reads the repo-root AGENTS.md natively: no shim file is needed.
#   - Repository-specific guidance is supplied through Cursor rule files in
#     <clone>/.cursor/rules/*.mdc, which are discovered automatically.
#   - There is no equivalent of Codex's trusted-project config; the project-local
#     rule file is the main mechanism for steering Cursor in this clone.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ----------------------------------------------------- vendor parameters ---
AGENT_NAME="cursor"
AGENT_LABEL="Cursor"
AGENT_IGNORES=(".cursor/" "AGENTS.override.md")
LAUNCH_CMD="cursor"

# shellcheck source=setup_common.sh
source "$SCRIPT_DIR/setup_common.sh"

common_parse_args "$@"
common_detect_repo
common_ensure_agents_md
common_clone_agent
common_sync_clone
common_detect_project
common_write_gitignore
common_install_hooks
common_write_start_sh

# ======================== Cursor-specific setup below =======================

if $DRY_RUN; then
  echo "DRY-RUN: would write .cursor/rules/coordination.mdc and a"
  echo "         .cursor/tmp/ directory for scratch files."
  exit 0
fi

mkdir -p "$CLONE_DIR/.cursor/rules" "$CLONE_DIR/.cursor/tmp"
rm -f "$CLONE_DIR/.cursor/rules/consensus-ai.mdc"

cat > "$CLONE_DIR/.cursor/rules/coordination.mdc" <<EOF2
---
description: Repository workflow and agent identity for the coordination repo
globs:
  - "**/*"
---

# Cursor agent for ${PROJECT_NAME}

- You are the **Cursor** agent for this repository.
- Working clone: $CLONE_DIR
- Your branches: \`issue-<n>/cursor\` (scratch: \`cursor/<name>\`)
- Commit message prefix: \`Cursor: \`
- Start your first response in a session with "Cursor agent here" so the human
  knows which terminal they are in.
- Follow the repo-root AGENTS.md workflow exactly.
- Session start: \`git checkout $SHARED_BRANCH && git pull $REMOTE_NAME $SHARED_BRANCH\`,
  then establish the mode before branching. **Automated**: a coordinator
  \`action.md\` or an issue number from the human — use \`issue-<n>/cursor\` and
  publish exactly the artifacts the action names. **Manual**: no action and no
  issue — the human's chat message is the task, so use \`cursor/<name>\` and do not
  fabricate \`action.md\`, \`.plans/\`, \`.signals/\`, or \`.code-reviews/\`
  evidence.
- If a git hook blocks an action, the hook is correct — fix the underlying
  state; NEVER use --no-verify, --force, or alter hooks/config to get around it.
- Put temporary files in .cursor/tmp/ (excluded from git), never in the repo tree.
EOF2

echo "Wrote Cursor rule file: .cursor/rules/coordination.mdc"

cat > "$CLONE_DIR/.cursor/rules/working-style.mdc" <<EOF3
---
description: Working conventions for this repository
globs:
  - "**/*"
---

# Working style

- Prefer editing existing files over creating new ones.
- Add or update tests for behavior you change.
- Use the repository's existing scripts and tools before introducing new ones.
- Keep changes focused and avoid unrelated churn.
EOF3

echo "Wrote Cursor rule file: .cursor/rules/working-style.mdc"

if \! command -v agent >/dev/null 2>&1; then
  echo "NOTE: 'agent' CLI not found on PATH. Install Cursor CLI, then launch"
  echo "      the clone with start-cursor.sh once the command is available."
fi

echo ""
echo "=== Cursor agent ready =============================================="
echo "Clone   : $CLONE_DIR"
echo "Launch  : $CLONE_DIR/start-cursor.sh   (or use start_isolated_claude_agents.sh)"
echo "Rules   : $CLONE_DIR/.cursor/rules/*.mdc"
echo "Temp dir: $CLONE_DIR/.cursor/tmp"
echo "======================================================================"
