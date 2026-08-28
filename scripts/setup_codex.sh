#!/usr/bin/env bash
# setup_codex.sh — set up the OpenAI Codex CLI agent clone.
# Run from the root of your MASTER repo:
#   ./scripts/setup_codex.sh [-n|--dry-run] [--force] [shared_branch] [remote_name]
#
# Codex specifics vs the Claude script:
#   - Codex reads the repo-root AGENTS.md natively: no shim file needed.
#   - Agent IDENTITY goes in ~/.codex/AGENTS.md (Codex's global instructions),
#     written as a marker-delimited block scoped to this clone's path, so it
#     never affects other Codex projects on this machine.
#   - Per-clone behavior (sandbox/approvals) goes in <clone>/.codex/config.toml,
#     which Codex only loads for TRUSTED projects — so we also register the
#     clone as trusted in ~/.codex/config.toml.
#   - There is no PreToolUse-guard equivalent; the git hooks are the hard
#     enforcement layer, plus Codex's own workspace-write sandbox.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ----------------------------------------------------- vendor parameters ---
AGENT_NAME="codex"
AGENT_LABEL="Codex"
AGENT_IGNORES=(".codex/" "AGENTS.override.md")
LAUNCH_CMD="codex"

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

# ======================== Codex-specific setup below ========================

if $DRY_RUN; then
  echo "DRY-RUN: would write identity block to ~/.codex/AGENTS.md, project"
  echo "         .codex/config.toml, and trust entry in ~/.codex/config.toml."
  exit 0
fi

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
mkdir -p "$CODEX_HOME"

# --- Identity: marker-delimited block in the GLOBAL ~/.codex/AGENTS.md.
#     Codex merges this with the repo-root AGENTS.md. The block is scoped to
#     this clone's path and is idempotent: re-running setup replaces it.
GLOBAL_AGENTS="$CODEX_HOME/AGENTS.md"
BEGIN_MARK="<!-- BEGIN ${PROJECT_NAME}-codex-identity (managed by setup_codex.sh) -->"
END_MARK="<!-- END ${PROJECT_NAME}-codex-identity -->"

touch "$GLOBAL_AGENTS"
# Remove any previous managed block, then append the fresh one.
if grep -qF "$BEGIN_MARK" "$GLOBAL_AGENTS"; then
  awk -v b="$BEGIN_MARK" -v e="$END_MARK" '
    $0 == b {skip=1; next}
    $0 == e {skip=0; next}
    !skip {print}
  ' "$GLOBAL_AGENTS" > "$GLOBAL_AGENTS.tmp" && mv "$GLOBAL_AGENTS.tmp" "$GLOBAL_AGENTS"
fi
cat >> "$GLOBAL_AGENTS" <<EOF
$BEGIN_MARK
## When working in $CLONE_DIR
- You are the **Codex** agent for the ${PROJECT_NAME} project. Follow the
  repo-root AGENTS.md workflow exactly.
- Your branches: \`issue-<n>/codex\` (scratch: \`codex/<name>\`)
- Commit message prefix: \`Codex: \`
- Start your first response in a session with "Codex agent here" so the human
  knows which terminal they are in.
- Session start: \`git checkout $SHARED_BRANCH && git pull $REMOTE_NAME $SHARED_BRANCH\`,
  then determine whether the coordinator supplied an automated issue action or
  the owner supplied a manual chat task. Automated work uses the prepared issue
  branch and action; manual work uses \`codex/<name>\`, follows owner chat, and
  does not fabricate coordinator evidence.
- If a git hook blocks an action, the hook is correct — fix the underlying
  state; NEVER use --no-verify, --force, or alter hooks/config to get around it.
- Temp/scratch files go in .codex/tmp/ (excluded from git), never in the repo tree.
$END_MARK
EOF
echo "Wrote Codex identity block to $GLOBAL_AGENTS"

# --- Per-clone Codex project configuration, local permissions, and reminders.
#     network allowed (pnpm install), approvals on request.
mkdir -p "$CLONE_DIR/.codex/rules" "$CLONE_DIR/.codex/tmp"

cat > "$CLONE_DIR/.codex/config.toml" <<'EOF'
approval_policy = "on-request"
sandbox_mode = "workspace-write"
model_instructions_file = "codex-instructions.md"

[sandbox_workspace_write]
network_access = true
EOF
echo "Wrote project config: .codex/config.toml"

cat > "$CLONE_DIR/.codex/rules/git.rules" <<'EOF'
prefix_rule(pattern=["git", "add"], decision="allow")
prefix_rule(pattern=["git", "fetch"], decision="allow")
prefix_rule(pattern=["git", "checkout"], decision="allow")
prefix_rule(pattern=["git", "branch", "--show-current"], decision="allow")
prefix_rule(pattern=["git", "log"], decision="allow")
prefix_rule(pattern=["mkdir -p .plans/", "show"], decision="allow")
EOF
echo "Wrote Git command rules: .codex/rules/git.rules"

cat > "$CLONE_DIR/.codex/codex-instructions.md" <<'EOF'
- After a sandbox-denied `git fetch`, retry only `git fetch origin` with its
  existing elevated approval. Run `git log` and other reads as separate
  commands so they use their own rules.

- Read this clone's own `.plans/**`, `.signals/**`, and
  `.code-reviews/**` files normally without requesting elevated access.

- Read peer coordination files from the paths listed under
  `## Bound input files` in your action.md. They are exact copies of the cited
  pins, already on disk, so there is no need to fetch a peer branch. Use
  `git show <sha>:<path>` only when a listed file is missing.

- During an automated issue, `git status` and `git diff` against this clone are
  refused by `.coord/bin/git`. Coordination checked this clone out and both
  readings are already in your action; do not work around the refusal.

- Put temporary files in `.codex/tmp/`. Prefer `apply_patch` for writing
  them, and do not request elevated access merely for shell redirection
  into that directory.

- During owner-authorized finalization, delete only the current issue's
  coordination files using `apply_patch`, then stage them with
  `git add -u`. Do not request a reusable elevated `git rm` rule.

EOF
echo "Wrote Codex instructions: .codex/codex-instructions.md"

# --- Trust the clone in the USER config so the project .codex/ layer loads.
#     Appended once; TOML table with a quoted absolute-path key.
USER_CONFIG="$CODEX_HOME/config.toml"
touch "$USER_CONFIG"
if grep -qF "[projects.\"$CLONE_DIR\"]" "$USER_CONFIG"; then
  echo "Clone already registered as trusted in $USER_CONFIG"
else
  cat >> "$USER_CONFIG" <<EOF

# Added by setup_codex.sh: trust the ${PROJECT_NAME} Codex agent clone so its
# project-level .codex/config.toml is loaded.
[projects."$CLONE_DIR"]
trust_level = "trusted"
EOF
  echo "Registered clone as trusted in $USER_CONFIG"
fi

# --- Sanity note if the codex CLI isn't installed yet.
if ! command -v codex >/dev/null 2>&1; then
  echo "NOTE: 'codex' CLI not found on PATH. Install it (e.g. npm i -g @openai/codex"
  echo "      or brew install codex), run 'codex login' once, then use start-codex.sh."
fi

echo ""
echo "=== Codex agent ready ================================================"
echo "Clone   : $CLONE_DIR"
echo "Launch  : $CLONE_DIR/start-codex.sh   (or use start_isolated_codex_agents.sh)"
echo "Identity: $GLOBAL_AGENTS (scoped block) + repo AGENTS.md (native)"
echo "First run: codex will ask you to log in and to confirm workspace trust."
echo "======================================================================"
