#!/usr/bin/env bash
# setup_antigravity.sh — set up the Google Antigravity CLI (agy) agent clone.
# Run from the root of your MASTER repo:
#   ./scripts/setup_antigravity.sh [-n|--dry-run] [--force] [shared_branch] [remote_name]
#
# Antigravity specifics (agy replaced Gemini CLI in June 2026):
#   - Binary is `agy`, installed to ~/.local/bin/agy by Google's installer:
#       curl -fsSL https://antigravity.google/cli/install.sh | bash
#   - Reads the repo-root AGENTS.md natively (also legacy GEMINI.md).
#   - Workspace config lives in .agents/ (skills, mcp_config.json, rules).
#   - User settings live under ~/.gemini/antigravity-cli/.
#   - Auth is OAuth on first interactive run (no API key needed for personal use).
#   - IDENTITY: agy has no confirmed global-instructions file (unlike Codex's
#     ~/.codex/AGENTS.md), so identity goes in a git-excluded clone-local
#     AGENT_IDENTITY.md, referenced from the shared AGENTS.md (see note below),
#     with a GEMINI.md copy as a fallback some agy versions auto-load.
#   - Enforcement: git hooks are the hard layer (no PreToolUse equivalent);
#     tune agy's own permission rules in-session with /permissions.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ----------------------------------------------------- vendor parameters ---
AGENT_NAME="antigravity"
AGENT_LABEL="Antigravity"
AGENT_IGNORES=(".agents/" "GEMINI.md" "AGENT_IDENTITY.md" ".antigravityignore")

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

# ==================== Antigravity-specific setup below ======================

if $DRY_RUN; then
  echo "DRY-RUN: would write AGENT_IDENTITY.md + GEMINI.md identity files,"
  echo "         .agents/ workspace dir, and PATH fix in start-antigravity.sh."
  exit 0
fi

# --- Identity: clone-local, git-excluded. Written twice on purpose:
#     AGENT_IDENTITY.md — the canonical file, referenced from shared AGENTS.md.
#     GEMINI.md         — some agy builds auto-load it alongside AGENTS.md;
#                         harmless if this build ignores it.
IDENTITY_CONTENT="# Agent identity — DO NOT act as any other agent

- You are the **Antigravity** agent for the ${PROJECT_NAME} project, running
  in Google's agy CLI. Follow the repo-root AGENTS.md workflow exactly.
- Working clone: $CLONE_DIR
- Your branches: \`issue-<n>/antigravity\` (scratch: \`antigravity/<name>\`)
- Commit message prefix: \`Antigravity: \`
- Start your first response in a session with \"Antigravity agent here\" so the
  human knows which terminal they are in.
- Session start: \`git checkout $SHARED_BRANCH && git pull $REMOTE_NAME $SHARED_BRANCH\`,
  then establish the mode before branching. **Automated**: a coordinator
  \`action.md\` or an issue number from the human — use \`issue-<n>/antigravity\` and
  publish exactly the artifacts the action names. **Manual**: no action and no
  issue — the human's chat message is the task, so use \`antigravity/<name>\` and do not
  fabricate \`action.md\`, \`.plans/\`, \`.signals/\`, or \`.code-reviews/\`
  evidence.
- If a git hook blocks an action, the hook is correct — fix the underlying
  state; NEVER use --no-verify, --force, or alter hooks/config to get around it.
- Temp/scratch files go in .agents/tmp/ (excluded from git), never in the repo tree.

## Terminal & Automation Rules
- **No Shell Chaining or Subshells:** When running terminal commands, never chain commands with \`&&\`, \`||\`, or pipes (\`|\`), and never use dynamic subshells like \`\$(pwd)\`. Run commands sequentially in separate tool calls and resolve absolute paths manually to ensure they cleanly match the pre-approved settings whitelist.
- **Use Native File Tools:** Never use bash commands like \`touch\`, \`cat\`, or \`echo\` to create, read, or modify files. Always use your native \`write_to_file\`, \`replace_file_content\`, and \`read_file\` tools, which are already fully whitelisted for the workspace.
- **Proactively Request Permissions:** If you must run a script or command prefix (e.g., \`scripts/\` or \`pnpm --dir automation\`) that is likely to be called repeatedly and may not be pre-approved, use the \`ask_permission\` tool once at the start of the phase so the owner can approve the prefix upfront, preventing repeated workflow interruptions."

printf '%s\n' "$IDENTITY_CONTENT" > "$CLONE_DIR/AGENT_IDENTITY.md"
printf '%s\n' "$IDENTITY_CONTENT" > "$CLONE_DIR/GEMINI.md"
mkdir -p "$CLONE_DIR/.agents/tmp"
echo "Wrote identity: AGENT_IDENTITY.md + GEMINI.md (both git-excluded)."

# --- Set up user settings.json under ~/.gemini/antigravity-cli/
SETTINGS_DIR="$HOME/.gemini/antigravity-cli"
SETTINGS_FILE="$SETTINGS_DIR/settings.json"
mkdir -p "$SETTINGS_DIR"

echo "Configuring permissions and trusted workspaces in settings.json..."

# Use node (available in this environment) to merge rules cleanly
node - "$SETTINGS_FILE" "$CLONE_DIR" <<'EOF'
const fs = require('fs');
const path = require('path');
const [,, settingsPath, cloneDir] = process.argv;

// Derive clone paths for all three agents in the same parent directory
const parentDir = path.dirname(cloneDir);
const projectName = path.basename(cloneDir).replace(/-antigravity$/, '');
const agentClones = ['antigravity', 'claude', 'codex'].map(agent =>
  path.join(parentDir, `${projectName}-${agent}`)
);

let settings = {
  allowNonWorkspaceAccess: true,
  colorScheme: "tokyo night",
  enableTelemetry: false,
  model: "Gemini 3.5 Flash (High)",
  permissions: { allow: [] },
  trustedWorkspaces: []
};

// Load existing settings if they exist
if (fs.existsSync(settingsPath)) {
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    console.warn("Warning: Could not parse existing settings.json, starting fresh.");
  }
}

// Guarantee expected object structures exist
settings.permissions = settings.permissions || {};
settings.permissions.allow = settings.permissions.allow || [];
settings.trustedWorkspaces = settings.trustedWorkspaces || [];

// The list of canonical commands to allow without prompt
const requiredCommands = [
  "command(git)",
  "command(git checkout)",
  "command(git pull)",
  "command(git branch)",
  "command(git log)",
  "command(git add)",
  "command(git commit)",
  "command(git diff)",
  "command(git push)",
  "command(git fetch)",
  "command(pnpm install)",
  "command(pnpm lint)",
  "command(pnpm depcruise)",
  "command(pnpm typecheck)",
  "command(pnpm build)",
  "command(pnpm check)",
  "command(pnpm test)",
  "command(pnpm --filter @multi-agent/core typecheck)",
  "command(pnpm --filter @multi-agent/core test)",
  "command(pnpm --filter @multi-agent/core build)",
  "command(pnpm --filter @multi-agent/storage typecheck)",
  "command(pnpm --filter @multi-agent/storage build)",
  "command(node --input-type=module -e \"import * as z from 'zod'; console.log(z.toJSONSchema.toString())\")",
  "command(node -e \"import('zod').then(z => console.log(typeof z.toJSONSchema))\")",
  "command(node -e \"import('./dist/schemas/records.js').then(m => import('zod').then(z => console.log(JSON.stringify(z.toJSONSchema(m.responseRecordSchema), null, 2))))\")",
  "command(node -e \"import('zod').then(z => console.log(JSON.stringify(z.toJSONSchema(z.object({ a: z.string().nullable() })), null, 2)))\")",
  "command(./scripts/wait.sh)",
  "command(scripts/wait.sh)",
  "command(grep)",
  "command(npx)",
  "command(mkdir)",
  "command(echo)",
  "command(head)",
  "command(sed)",
  "command(find)"
];

// Merge command allowances
for (const cmd of requiredCommands) {
  if (!settings.permissions.allow.includes(cmd)) {
    settings.permissions.allow.push(cmd);
  }
}

// Merge workspace paths
for (const clone of agentClones) {
  if (!settings.trustedWorkspaces.includes(clone)) {
    settings.trustedWorkspaces.push(clone);
  }
}

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n",
'utf8');
console.log("Updated settings.json successfully.");
EOF

# --- The ~/.local/bin PATH export that agy needs is emitted by launcher_command()
#     in scripts/lib/launcher.sh, so that githooks/post-merge produces the same
#     launcher this setup does. No post-hoc patch of the generated file remains.

# --- Shared AGENTS.md should point every agent at its identity file. Add the
#     line for the human to review/commit if it isn't there yet.
if ! grep -q "AGENT_IDENTITY.md" "$MASTER_ROOT/AGENTS.md" 2>/dev/null; then
  echo ""
  echo "ACTION NEEDED: add this line near the top of AGENTS.md in the master"
  echo "repo, then commit and push it (it helps agy load its identity):"
  echo ""
  echo "  If a file named AGENT_IDENTITY.md exists in the repo root, read it"
  echo "  first — it declares which agent you are."
  echo ""
fi

# --- Sanity note if agy isn't installed yet.
if ! command -v agy >/dev/null 2>&1 && [[ ! -x "$HOME/.local/bin/agy" ]]; then
  echo "NOTE: 'agy' not found. Install Antigravity CLI:"
  echo "      curl -fsSL https://antigravity.google/cli/install.sh | bash"
  echo "      Then run 'agy' once to complete Google OAuth sign-in."
fi

echo ""
echo "=== Antigravity agent ready =========================================="
echo "Clone   : $CLONE_DIR"
echo "Launch  : $CLONE_DIR/start-antigravity.sh   (or use start_isolated_antigravity_agents.sh)"
echo "Identity: AGENT_IDENTITY.md + GEMINI.md in clone + repo AGENTS.md (native)"
echo "First run: agy walks you through theme + Google OAuth. Then check"
echo "           /permissions (keep request-review) and ask it to confirm its"
echo "           identity and workflow before assigning a real issue."
echo "======================================================================"
