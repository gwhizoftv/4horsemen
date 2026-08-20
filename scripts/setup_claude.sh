#!/usr/bin/env bash
# setup_claude.sh — set up the Claude Code agent clone.
# Run from the root of your MASTER repo:
#   ./scripts/setup_claude.sh [-n|--dry-run] [--force] [shared_branch] [remote_name]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ----------------------------------------------------- vendor parameters ---
AGENT_NAME="claude"
AGENT_LABEL="Claude"
AGENT_IGNORES=(".claude/" "CLAUDE.md" "CLAUDE.local.md")

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

# ======================= Claude-specific setup below =======================

if $DRY_RUN; then
  echo "DRY-RUN: would write CLAUDE.md shim, .claude/settings.json, PreToolUse guard, MCP servers."
  exit 0
fi

# --- CLAUDE.md: thin shim. The real workflow lives in the committed AGENTS.md
#     (Claude Code doesn't read AGENTS.md natively yet, so we @import it).
cat > "$CLONE_DIR/CLAUDE.md" <<EOF
# Claude agent — ${PROJECT_NAME}

@AGENTS.md

## Your identity (do not deviate)
- You are the **Claude** agent. Working clone: $CLONE_DIR
- Your branches: \`issue-<n>/claude\` for automated issues (scratch: \`claude/<name>\` for manual work)
- Commit message prefix: \`Claude: \`
- Start your first response in a session with "Claude agent here" so the human
  knows which terminal they are in.

## Session start checklist
1. \`git checkout $SHARED_BRANCH && git pull $REMOTE_NAME $SHARED_BRANCH\`
2. For automated issue work: ask the human for the issue number if you don't have one, then \`git checkout -b issue-<n>/claude\` (or checkout your existing branch and continue).
3. For manual owner-driven work: follow the human's chat instructions and work on a scratch branch \`git checkout -b claude/<name>\`.

## Local conveniences
- Temp/scratch files go in .claude/tmp/ (gitignored), never in the repo tree.
- If a git hook blocks an action, the hook is correct — fix the underlying
  state; NEVER use --no-verify or alter hooks/config to get around it.
EOF
mkdir -p "$CLONE_DIR/.claude/tmp" "$CLONE_DIR/.claude/hooks"
echo "Wrote CLAUDE.md shim (imports AGENTS.md)."

# --- PreToolUse guard: hard enforcement inside Claude Code itself, so even a
#     confused model can't bypass the git hooks. Exit code 2 blocks the tool
#     call and feeds stderr back to Claude.
cat > "$CLONE_DIR/.claude/hooks/git-guard.sh" <<EOF
#!/usr/bin/env bash
# PreToolUse guard for Bash tool calls. Reads the tool-call JSON on stdin.
SHARED_BRANCH="$SHARED_BRANCH"
EOF
cat >> "$CLONE_DIR/.claude/hooks/git-guard.sh" <<'GUARD'
input=$(cat)

block() { echo "BLOCKED by git-guard: $1" >&2; exit 2; }

if grep -qE -- '--no-verify' <<<"$input"; then
  block "--no-verify is forbidden. Fix what the hook complained about instead."
fi
if grep -qE 'hooksPath' <<<"$input"; then
  block "modifying git hook configuration is forbidden."
fi
if grep -qE 'git[^;|&]*push[^;|&]*(--force|--force-with-lease|-f([[:space:]]|\\\\|$))' <<<"$input"; then
  block "force-push is forbidden."
fi
# End boundary includes \" and \\ because the command arrives JSON-encoded.
if grep -qE "git[^;|&]*push[^;|&]*[[:space:]]($SHARED_BRANCH|issue-[0-9]+/final)([[:space:]\"\\\\:]|$)" <<<"$input"; then
  block "pushing '$SHARED_BRANCH' or an issue-*/final branch is forbidden; only the human merges those."
fi
exit 0
GUARD
chmod +x "$CLONE_DIR/.claude/hooks/git-guard.sh"
echo "Wrote PreToolUse guard: .claude/hooks/git-guard.sh"

# --- settings.json: permissions + wire up the PreToolUse hook.
cat > "$CLONE_DIR/.claude/settings.json" <<EOF
{
  "permissions": {
    "allow": [
      "Bash(git status:*)", "Bash(git log:*)", "Bash(git diff:*)",
      "Bash(git fetch:*)", "Bash(git pull:*)", "Bash(git checkout:*)",
      "Bash(git add:*)", "Bash(git commit:*)", "Bash(git push:*)",
      "Bash(git branch:*)", "Bash(git merge-base:*)",
      "Bash(npm install:*)", "Bash(npm run lint:*)", "Bash(npm test:*)",
      "Bash(npx tsc:*)", "Bash(ctags:*)", "Bash(mkdir:*)", "Bash(ls:*)",
      "Bash(corepack enable pnpm:*)",
      "Bash(pnpm install:*)",
      "Bash(pnpm lint:*)",
      "Bash(pnpm typecheck:*)",
      "Bash(pnpm test:*)",
      "Bash(pnpm depcruise:*)",
      "Bash(pnpm check:*)",
      "Bash(pnpm build:*)"
    ],
    "deny": [
      "Bash(git push --force:*)",
      "Bash(git push -f:*)",
      "Bash(git config core.hooksPath:*)",
      "Bash(git reset --hard:*)"
    ]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command",
            "command": "\$CLAUDE_PROJECT_DIR/.claude/hooks/git-guard.sh" }
        ]
      }
    ]
  }
}
EOF
echo "Wrote .claude/settings.json (permissions + PreToolUse guard)."

# --- Optional MCP servers (skip silently if claude CLI isn't installed here).
if command -v claude >/dev/null 2>&1; then
  ( cd "$CLONE_DIR" && claude mcp add --transport sse context7 https://mcp.context7.com/sse ) \
    2>/dev/null || echo "NOTE: context7 MCP add skipped/failed (may already exist)."
else
  echo "NOTE: 'claude' CLI not found on PATH — skipped MCP setup. Install Claude Code, then re-run."
fi

echo ""
echo "=== Claude agent ready ==============================================="
echo "Clone   : $CLONE_DIR"
echo "Launch  : $CLONE_DIR/start-claude.sh   (or use start_isolated_claude_agents.sh)"
echo "Reminder: push AGENTS.md from the master repo if this script just created it."
echo "======================================================================"
