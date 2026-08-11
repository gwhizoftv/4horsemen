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
#   scripts/setup_common.sh   writes it when a clone is set up
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
      printf 'exec codex\n'
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
  cat > "$path" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "\$(dirname "\${BASH_SOURCE[0]}")"

# Load nvm and use the Node version declared by this repo's .nvmrc. Every step
# fails closed: this repo requires the Node major pinned in .nvmrc, so
# starting an agent on a fallback version only defers the failure to its first
# commit, with a confusing error.
export NVM_DIR="\${NVM_DIR:-\$HOME/.nvm}"

if [[ ! -s "\$NVM_DIR/nvm.sh" ]]; then
  echo "ERROR: nvm not found at \$NVM_DIR/nvm.sh" >&2
  exit 1
fi

. "\$NVM_DIR/nvm.sh"

if [[ ! -f .nvmrc ]]; then
  echo "ERROR: .nvmrc is missing. This repo must declare its Node version." >&2
  exit 1
fi

nvm use

echo "Node: \$(node --version)"
echo "pnpm: \$(pnpm --version)"

# Prefer pnpm via Corepack when this is a pnpm repo.
if [[ -f pnpm-lock.yaml ]] && command -v corepack >/dev/null; then
  corepack enable pnpm >/dev/null 2>&1 || true
fi

echo "=== $label agent | branch scheme issue-<n>/$agent | shared: $shared ==="
git status -sb || true

$command
EOF

  chmod +x "$path"
}
