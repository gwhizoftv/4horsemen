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
      printf 'exec claude --permission-mode auto\n'
      ;;
    codex)
      # complete lives under coord-runtime (outside the clone). workspace-write
      # still prompts for that path; agent clones need unattended out-of-tree writes.
      printf 'exec codex --ask-for-approval never --sandbox danger-full-access\n'
      ;;
    antigravity)
      # agy installs into ~/.local/bin, which a login shell does not always
      # have on PATH; without this the launcher cannot find it.
      printf 'export PATH="$HOME/.local/bin:$PATH"\nexec agy --mode accept-edits\n'
      ;;
    gemini)
      printf 'exec gemini\n'
      ;;
    cursor)
      printf 'exec agent\n'
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

echo "=== $label agent | branch scheme issue-<n>/$agent | shared: $shared ==="
git status -sb || true
echo "When an automated issue is running, fetch your coordinator action with:"
echo "  coord next --issue <n>"
echo "(uses this clone's coord.workspaceConfig + consensus.agentId)."
echo "In owner-driven manual mode (coord manual), follow the owner's chat task"
echo "on your scratch branch ($agent/<name>); do not invent coordinator artifacts."

$command
EOF

  chmod +x "$path"
}
