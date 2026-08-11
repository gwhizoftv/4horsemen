#!/usr/bin/env bash
# setup_common.sh — DEPRECATED shared library for multi-agent CLI setup scripts.
#
# Superseded by `coord install`, which owns clone creation, launchers, ignore
# rules, clone identity, and hook wiring. Those responsibilities moved into
# TypeScript so they share the driver's own containment logic and are covered by
# `pnpm check`; the functions below that used to perform them now refuse and
# print the `coord install` command instead.
#
# What remains here and in the setup_<agent>.sh scripts is vendor-specific
# harness configuration — memory shims, trust entries, MCP settings — which runs
# AFTER `coord install` has wired the clone.
#
# DO NOT run this file directly. Source it from a vendor script that first sets:
#   AGENT_NAME    - lowercase id used in paths/branches (claude | codex | antigravity | gemini | cursor)
#   AGENT_LABEL   - display name / commit prefix        (Claude | Codex | Antigravity | Gemini | cursor)
#   AGENT_IGNORES - array of extra .git/info/exclude lines for this vendor's clone
#
# The command start-<agent>.sh execs is NOT set here: it lives in
# launcher_command() in scripts/lib/launcher.sh, which githooks/post-merge reads
# too, so a vendor's flags are recorded exactly once.
#
# The vendor script then calls, in order:
#   common_parse_args "$@"
#   common_detect_repo
#   common_ensure_agents_md
#   common_clone_agent
#   common_sync_clone
#   common_detect_project
#   common_write_gitignore
#   common_install_hooks
#   common_write_start_sh
#   ...then does its vendor-specific work (memory shim, settings, MCP, etc.)

set -euo pipefail

# shellcheck source=lib/launcher.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/launcher.sh"

# ---------------------------------------------------------------- args -----
DRY_RUN=false
FORCE=false
SHARED_BRANCH="main"
REMOTE_NAME="origin"

common_parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -n|--dry-run)
        DRY_RUN=true
        ;;
      --force)
        FORCE=true
        ;;
      -h|--help)
        echo "Usage: $0 [-n|--dry-run] [--force] [shared_branch] [remote_name]"
        echo "  --force  allow sync even if the agent clone has uncommitted work (DESTRUCTIVE)"
        exit 0
        ;;
      *)
        if [[ "$SHARED_BRANCH" == "main" && "$1" != "main" ]]; then
          SHARED_BRANCH="$1"
        else
          REMOTE_NAME="$1"
        fi
        ;;
    esac
    shift
  done

  echo "Agent: $AGENT_LABEL   Shared branch: $SHARED_BRANCH   Remote: $REMOTE_NAME   Dry-run: $DRY_RUN"
}

# run: execute or echo. Uses "$@" directly — no eval, no word-splitting bugs.
run() {
  if $DRY_RUN; then
    echo -n "DRY-RUN:"
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

common_ensure_node_version() {
  local nvm_script="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  local repo_root="${MASTER_ROOT:-$PWD}"

  if [[ -s "$nvm_script" ]]; then
    # shellcheck disable=SC1090
    . "$nvm_script"

    if [[ -f "$repo_root/.nvmrc" ]]; then
      (
        cd "$repo_root"
        nvm use >/dev/null 2>&1 || nvm install "$(cat .nvmrc)" >/dev/null 2>&1
      )
    fi
  else
    echo "NOTE: nvm not found at $nvm_script; using the current PATH for Node." >&2
  fi
}

# ------------------------------------------------------- repo detection ----
common_detect_repo() {
  MASTER_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" \
    || die "Run this from inside your master repo (not a git repo here)."

  PROJECT_NAME="$(basename "$MASTER_ROOT")"
  PARENT_DIR="$(dirname "$MASTER_ROOT")"

  # Refuse to run from inside an agent clone — run from the master repo.
  if [[ "$PROJECT_NAME" =~ -(claude|codex|antigravity|gemini|cursor)[0-9]*$ ]]; then
    die "You appear to be inside an agent clone ('$PROJECT_NAME'). cd to the master repo and re-run."
  fi

  REMOTE_URL="$(git -C "$MASTER_ROOT" config --get "remote.${REMOTE_NAME}.url" || true)"
  [[ -n "$REMOTE_URL" ]] \
    || die "Master repo has no '$REMOTE_NAME' remote. Add one first: git remote add $REMOTE_NAME <url>"

  git -C "$MASTER_ROOT" show-ref --verify --quiet "refs/heads/$SHARED_BRANCH" \
    || die "Branch '$SHARED_BRANCH' does not exist in the master repo."

  CLONE_DIR="$PARENT_DIR/${PROJECT_NAME}-${AGENT_NAME}"

  common_ensure_node_version

  echo "Master repo : $MASTER_ROOT"
  echo "Remote      : $REMOTE_URL"
  echo "Agent clone : $CLONE_DIR"
}

# ------------------------------------------------------------ AGENTS.md ----
# Writing AGENTS.md into the product is now opt-in and belongs to
# `coord install --write-product`. The default install adds no tracked file to
# the product, so that a developer who clones it normally inherits no new
# obligations from coordination.
common_ensure_agents_md() {
  echo "NOTE: AGENTS.md is no longer written by setup. Use 'coord install --write-product' if you want it committed."
}

# ---------------------------------------------------------------- clone ----
# Cloning and syncing moved to `coord install`, which never resets an existing
# clone: re-running the installer to repair wiring must not discard an agent's
# in-flight work.
common_clone_agent() {
  [[ -d "$CLONE_DIR" ]] \
    || die "Clone $CLONE_DIR does not exist. Create it first: coord install --product '$MASTER_ROOT' --coord-root <runtime> --agents $AGENT_NAME"
  echo "Clone present: $CLONE_DIR"
}

common_sync_clone() {
  echo "NOTE: setup no longer syncs the clone. Sync it yourself when you mean to: (cd '$CLONE_DIR' && git checkout $SHARED_BRANCH && git pull $REMOTE_NAME $SHARED_BRANCH)"
}

# ---------------------------------------------------- project detection ----
common_detect_project() {
  PROJECT_TYPE="unknown"

  if [[ -f "$CLONE_DIR/package.json" ]]; then
    if grep -q '"react-native":' "$CLONE_DIR/package.json"; then
      PROJECT_TYPE="react-native"
    elif grep -q '"react":' "$CLONE_DIR/package.json"; then
      PROJECT_TYPE="react"
    elif grep -q '"typescript":' "$CLONE_DIR/package.json" || [[ -f "$CLONE_DIR/tsconfig.json" || -f "$CLONE_DIR/tsconfig.base.json" ]]; then
      PROJECT_TYPE="typescript"
    else
      PROJECT_TYPE="javascript"
    fi
  elif [[ -f "$CLONE_DIR/Cargo.toml" ]]; then
    PROJECT_TYPE="rust"
  elif [[ -f "$CLONE_DIR/go.mod" ]]; then
    PROJECT_TYPE="go"
  elif [[ -f "$CLONE_DIR/pyproject.toml" || -f "$CLONE_DIR/requirements.txt" ]]; then
    PROJECT_TYPE="python"
  fi

  echo "Detected project type: $PROJECT_TYPE"

  if [[ "$PROJECT_TYPE" =~ ^(javascript|typescript|react|react-native)$ && ! -d "$CLONE_DIR/node_modules" ]]; then
    if [[ -f "$CLONE_DIR/pnpm-lock.yaml" ]]; then
      echo "Installing pnpm dependencies with frozen lockfile..."
      run bash -c "cd '$CLONE_DIR' && corepack enable pnpm && pnpm install --frozen-lockfile" \
        || echo "WARNING: pnpm install --frozen-lockfile failed; agent may need to run it after lockfile/dependency issues are fixed."
    elif [[ -f "$CLONE_DIR/package-lock.json" ]]; then
      echo "Installing npm dependencies..."
      run bash -c "cd '$CLONE_DIR' && npm install" \
        || echo "WARNING: npm install failed; agent may need to run it."
    elif [[ -f "$CLONE_DIR/yarn.lock" ]]; then
      echo "Installing yarn dependencies..."
      run bash -c "cd '$CLONE_DIR' && corepack enable yarn && yarn install --immutable" \
        || echo "WARNING: yarn install failed; agent may need to run it."
    else
      echo "No recognized lockfile found. Skipping automatic dependency install."
      echo "Install dependencies manually in the clone if needed."
    fi
  fi
}

# ------------------------------------------------- per-clone ignore rules --
# Agent-local files are excluded via .git/info/exclude — per-clone, never
# committed, so each clone's history stays identical to the remote and vendors'
# local ignore lists cannot conflict.
common_write_gitignore() {
  local ex="$CLONE_DIR/.git/info/exclude"
  # Only this vendor's extra entries belong here now. The shared set — launchers,
  # generated indexes, agent tool directories — is written by `coord install` as
  # a delimited managed block in the same file, so uninstall can remove exactly
  # what it added without touching anything a vendor script or an operator wrote.
  local lines=("tags" "directory_tree.md")
  lines+=("${AGENT_IGNORES[@]}")

  $DRY_RUN && {
    echo "DRY-RUN: would add to .git/info/exclude: ${lines[*]}"
    return 0
  }

  mkdir -p "$(dirname "$ex")"
  touch "$ex"

  mkdir -p .plans
  mkdir -p .signals
  mkdir -p .code-reviews

  local added=false
  local line

  for line in "${lines[@]}"; do
    if ! grep -qxF "$line" "$ex"; then
      if ! $added; then
        printf '\n# %s agent-local files added by setup\n' "$AGENT_LABEL" >> "$ex"
        added=true
      fi
      printf '%s\n' "$line" >> "$ex"
    fi
  done

  if $added; then
    echo "Added agent-local ignore rules to .git/info/exclude."
  else
    echo ".git/info/exclude already up to date."
  fi
}

# ---------------------------------------------------------------- hooks ----
# Hook wiring moved to `coord install`, which writes fail-closed shims into the
# clone's .git/hooks/ — untracked by construction, so a human clone of the same
# product remote never receives them. This function now only verifies that the
# installer has run, and refuses to proceed with vendor configuration if it has
# not: vendor settings on an unwired clone look configured and enforce nothing.
common_install_hooks() {
  local manifest="$CLONE_DIR/.git/hooks/coord-hooks.json"

  $DRY_RUN && {
    echo "DRY-RUN: would require coordination hooks at $manifest"
    return 0
  }

  [[ -f "$manifest" ]] \
    || die "Clone $CLONE_DIR has no coordination hooks. Run: coord install --product '$MASTER_ROOT' --coord-root <runtime> --agents $AGENT_NAME"

  local recorded
  recorded="$(git -C "$CLONE_DIR" config --local --get consensus.agentId || true)"
  [[ "$recorded" == "$AGENT_NAME" ]] \
    || die "Clone $CLONE_DIR records consensus.agentId='$recorded', not '$AGENT_NAME'. Re-run coord install with the intended layout."

  echo "Coordination hooks present and identity recorded: consensus.agentId=$recorded"
}

# --------------------------------------------------- start-<agent>.sh --
# The launcher is written by `coord install` (and regenerated by
# githooks/post-merge when a merge removes it), both through the single template
# in scripts/lib/launcher.sh.
common_write_start_sh() {
  local launcher="$CLONE_DIR/start-${AGENT_NAME}.sh"

  $DRY_RUN && {
    echo "DRY-RUN: would require $launcher"
    return 0
  }

  [[ -x "$launcher" ]] \
    || die "Launcher $launcher is missing. Run: coord install --product '$MASTER_ROOT' --coord-root <runtime> --agents $AGENT_NAME"
  echo "Launcher present: $launcher"
}
