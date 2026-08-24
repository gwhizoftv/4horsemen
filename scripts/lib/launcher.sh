#!/usr/bin/env bash
# scripts/lib/launcher.sh — the single source of truth for start-<agent>.sh.
#
# The launcher is generated per clone and never tracked: it carries that clone's
# vendor flags, and setup rewrites it on every run, so a tracked copy guarantees
# a dirty worktree (see docs/launcher-untracking-migration.md).
#
# Two callers generate it, which is exactly why the template lives here rather
# than in either of them:
#
#   src/setupWorkspace.ts     writes it during `coord install`
#   githooks/post-merge       rewrites it when a pull removes it
#
# A second copy of this template drifted from the first within a day of being
# written. Keep both callers on these functions.

# launcher_command <agent>
#
# Emits the shell lines that launch one agent. This is the only place a vendor's
# flags are recorded; setup scripts and the post-merge hook both read them here.
launcher_command() {
  case "$1" in
    claude)
      printf 'exec claude --permission-mode auto "${completion_args[@]}"\n'
      ;;
    codex)
      # The clone and only the current completion drop are writable. The
      # coordinator runtime is deliberately not an added directory.
      printf 'exec codex --ask-for-approval never --sandbox workspace-write "${completion_args[@]}"\n'
      ;;
    antigravity)
      # agy installs into ~/.local/bin, which a login shell does not always
      # have on PATH; without this the launcher cannot find it.
      #
      # --mode accept-edits sets the execution mode; it does not grant tool
      # permissions, so every out-of-whitelist call became an owner prompt and
      # showed up in analytics as agent wait rather than work (median ~7 min,
      # max ~2.3 h on a product run). --dangerously-skip-permissions is a
      # separate flag, so keep the mode and add the grant. Codex already
      # launches unattended for the same reason.
      printf 'export PATH="$HOME/.local/bin:$PATH"\nif (( ${#completion_args[@]} > 0 )); then\n  exec agy --mode accept-edits --dangerously-skip-permissions --sandbox "${completion_args[@]}"\nelse\n  exec agy --mode accept-edits --dangerously-skip-permissions\nfi\n'
      ;;
    gemini)
      printf 'exec gemini\n'
      ;;
    cursor)
      printf 'if (( ${#completion_args[@]} > 0 )); then\n  exec agent --sandbox enabled "${completion_args[@]}"\nelse\n  exec agent\nfi\n'
      ;;
    *)
      return 1
      ;;
  esac
}

# write_launcher <path> <agent> <label> <shared-branch>
#
# Writes an executable launcher, or returns 1 for an agent with no known launch
# command rather than emitting a truncated script.
write_launcher() {
  local path="$1" agent="$2" label="$3" shared="$4" command

  command="$(launcher_command "$agent")" || return 1

  # cd by script location, not by a baked-in absolute path: a clone that moves
  # keeps working, and the file stays free of machine-specific state.
  #
  # The toolchain setup below is conditional on what the clone actually
  # contains. Coordination onboards products in any language; a launcher that
  # demanded .nvmrc and pnpm would fail on a Rust or Go repo for reasons that
  # have nothing to do with the product. Where a repo does pin Node, the pin is
  # honoured and failing to honour it is fatal — starting an agent on a fallback
  # version only defers the failure to its first commit, with a confusing error.
  cat > "$path" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "\$(dirname "\${BASH_SOURCE[0]}")"

if [[ -f .nvmrc ]]; then
  export NVM_DIR="\${NVM_DIR:-\$HOME/.nvm}"

  if [[ ! -s "\$NVM_DIR/nvm.sh" ]]; then
    echo "ERROR: this repo pins a Node version in .nvmrc, but nvm was not found at \$NVM_DIR/nvm.sh" >&2
    exit 1
  fi

  . "\$NVM_DIR/nvm.sh"
  nvm use
  echo "Node: \$(node --version)"
fi

# Prefer pnpm via Corepack when this is a pnpm repo.
if [[ -f pnpm-lock.yaml ]] && command -v corepack >/dev/null; then
  corepack enable pnpm >/dev/null 2>&1 || true
  command -v pnpm >/dev/null && echo "pnpm: \$(pnpm --version)"
fi

# Automated harnesses receive one additional writable root: the current
# issue/current-agent completion drop. The absolute root comes from the strict
# installed workspace config and the issue comes only from the coordinator's
# tmux environment. A direct/manual launch receives no external grant even if
# its clone is still on an issue branch. Never pass a parent-relative path.
completion_args=()
coord_issue="\${COORD_ISSUE:-}"
if [[ -n "\$coord_issue" ]]; then
  if [[ ! "\$coord_issue" =~ ^[1-9][0-9]*$ ]]; then
    echo "ERROR: COORD_ISSUE must be a positive integer; got '\$coord_issue'." >&2
    exit 1
  fi
  workspace_config="\$(git config --local --get coord.workspaceConfig 2>/dev/null || true)"
  if [[ -z "\$workspace_config" || ! -f "\$workspace_config" ]]; then
    echo "ERROR: automated mode cannot read coord.workspaceConfig. Re-run coord install." >&2
    exit 1
  fi
  completes_root="\$(node -e '
    const fs = require("fs");
    const path = require("path");
    const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (typeof config.completesRoot !== "string" || !path.isAbsolute(config.completesRoot)) process.exit(2);
    process.stdout.write(path.resolve(config.completesRoot));
  ' "\$workspace_config")" || {
    echo "ERROR: workspace config has no absolute completesRoot. Re-run coord install." >&2
    exit 1
  }
  complete_dir="\$completes_root/issue-\$coord_issue/$agent"
  if [[ ! -d "\$complete_dir" || -L "\$complete_dir" ]]; then
    echo "ERROR: completion drop is missing or unsafe: \$complete_dir" >&2
    exit 1
  fi
  completion_args=(--add-dir "\$complete_dir")
fi

echo "=== $label agent | branches issue-<n>/$agent or $agent/<name> | shared: $shared ==="
git status -sb || true
echo "Automated issue mode: fetch your coordinator action with:"
echo "  coord next --issue <n>"
echo "(uses this clone's coord.workspaceConfig + consensus.agentId)."
echo "Owner-driven manual mode: wait for the owner's chat task, then work on"
echo "  $agent/<name>"
echo "Do not fabricate coordinator actions or evidence in manual mode."

$command
EOF

  chmod +x "$path"
}
