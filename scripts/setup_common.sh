#!/usr/bin/env bash
# setup_common.sh — shared library for multi-agent CLI setup scripts.
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
# One shared, committed workflow file. All agents read it. Claude gets a
# CLAUDE.md shim that imports AGENTS.md.
common_ensure_agents_md() {
  local f="$MASTER_ROOT/AGENTS.md"

  if [[ -f "$f" ]]; then
    echo "AGENTS.md already exists in master repo — leaving it alone."
    return 0
  fi

  echo "Writing shared AGENTS.md to master repo..."
  if $DRY_RUN; then
    echo "DRY-RUN: would create $f"
    return 0
  fi

  cat > "$f" <<AGENTS_EOF
# Agent Workflow — ${PROJECT_NAME}

Three AI agents and one human maintainer work on this repo in parallel. Each
agent works in its own clone. This file is the single source of truth for the
workflow. Your agent identity and clone path are in your agent-specific memory
file — never act as another agent.

## Branch scheme
- \`${SHARED_BRANCH}\` — shared truth. NEVER commit or push to it. Only the human merges here.
- \`issue-<n>/<agent>\` — your working branch for issue n, e.g. \`issue-42/claude\`.
  You may only commit/push to branches carrying YOUR agent name.
- \`issue-<n>/final\` — the consensus branch for issue n. Updated ONLY by merging
  the reviewed pull request. Never push to it directly.

## Workflow per issue
1. Sync: \`git checkout ${SHARED_BRANCH} && git pull ${REMOTE_NAME} ${SHARED_BRANCH}\`
2. The human assigns the issue and announces the issue number <n>.
3. Create YOUR branch: \`git checkout -b issue-<n>/<your-agent-name>\`
4. Implement the issue. Add tests. Run lint/typecheck/test/check. Commit and push.
5. The human picks the best implementation ("best-so-far").
6. REVIEW ROUND — if you are NOT best-so-far: fetch and study the best-so-far
   branch:
   \`git fetch ${REMOTE_NAME} && git diff ${SHARED_BRANCH}...${REMOTE_NAME}/issue-<n>/<winner>\`
   Write concrete, actionable review comments. Do NOT push code to the winner's branch.
7. REVIEW ROUND — if you ARE best-so-far: read all review comments, incorporate
   what is correct, push revisions to your own branch, and reply to each comment
   stating what you changed or why you disagree.
8. Repeat 6–7 until both reviewers approve or the human stops the loop.
9. The human merges the winning branch into \`issue-<n>/final\` and eventually
   into \`${SHARED_BRANCH}\`. Then everyone returns to step 1.

## Hard rules
- Never commit on \`${SHARED_BRANCH}\` or any \`issue-*/final\` branch.
- Never commit/push to another agent's branch.
- Never use \`--no-verify\`, \`--force\`, \`--force-with-lease\`, or change \`core.hooksPath\`.
- Commit messages start with your agent label, e.g. \`Claude: fix login redirect\`.
- If a hook blocks you, the hook is right: fix the state it complains about.

## Conventions
- Prefer editing existing files over creating new ones.
- Add or update tests for behavior you change.
- Run the project check command before committing.
- For pnpm repos, use pnpm. Do not run npm install in a pnpm-lock.yaml repo.
AGENTS_EOF

  echo ""
  echo "AGENTS.md created at:"
  echo "  $f"
  echo ""
  echo "Review it, then commit and push it manually from the master repo:"
  echo "  git add AGENTS.md"
  echo "  git commit -m 'chore: add shared AGENTS.md workflow file'"
  echo "  git push $REMOTE_NAME $SHARED_BRANCH"
  echo ""
  echo "Continuing setup using the local AGENTS.md file."
}

# ---------------------------------------------------------------- clone ----
common_clone_agent() {
  if [[ -d "$CLONE_DIR" ]]; then
    echo "Clone already exists: $CLONE_DIR"
  else
    echo "Cloning agent repo..."
    run git clone "$MASTER_ROOT" "$CLONE_DIR"
    run git -C "$CLONE_DIR" remote set-url "$REMOTE_NAME" "$REMOTE_URL"
  fi
}

# ----------------------------------------------------------------- sync ----
common_sync_clone() {
  $DRY_RUN && {
    echo "DRY-RUN: would sync $CLONE_DIR to $REMOTE_NAME/$SHARED_BRANCH"
    return 0
  }

  # Refuse to destroy in-flight work unless --force.
  if ! git -C "$CLONE_DIR" diff --quiet || ! git -C "$CLONE_DIR" diff --cached --quiet; then
    if ! $FORCE; then
      die "Clone $CLONE_DIR has uncommitted changes. Commit/stash them, or re-run with --force to DISCARD them."
    fi

    echo "WARNING: --force given; discarding uncommitted changes in $CLONE_DIR"
    git -C "$CLONE_DIR" reset --hard HEAD
    git -C "$CLONE_DIR" clean -fd
  fi

  git -C "$CLONE_DIR" checkout "$SHARED_BRANCH"

  if git -C "$CLONE_DIR" fetch "$REMOTE_NAME" "$SHARED_BRANCH" 2>/dev/null; then
    git -C "$CLONE_DIR" reset --hard "$REMOTE_NAME/$SHARED_BRANCH"
    echo "Synced $SHARED_BRANCH to $REMOTE_NAME/$SHARED_BRANCH."
  else
    echo "NOTE: could not fetch $REMOTE_NAME/$SHARED_BRANCH. Using local state."
  fi
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
  # githooks/ is deliberately absent: hooks are tracked files now. The old
  # ignored .githooks/ entry stays out of this list so a clone migrating to the
  # tracked directory never needs a per-clone exclude edit.
  # start-<agent>.sh is deliberately absent: the launchers are covered by the
  # tracked .gitignore, which reaches every clone with the merge instead of
  # depending on whether setup has run in that clone yet.
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
# Hook bodies are TRACKED, agent-neutral files in githooks/ (issue #171). Setup
# no longer generates them: it activates the tracked directory and records this
# clone's identity in local Git config, which is the one contract the hooks
# resolve at runtime. A hook change now reaches every clone with `git pull`, and
# the consensus-critical source digest hashes the same committed bytes in every
# clone instead of per-clone generated output.
#
# The tracked directory is `githooks/`, not `.githooks/`: the old path is
# excluded per clone through .git/info/exclude, so reusing it would require
# hand-editing that untracked file in every clone and would let a clone migrate
# to no hooks at all without saying so.
common_install_hooks() {
  local hd="$CLONE_DIR/githooks"
  local hooks=(commit-msg post-commit post-merge pre-commit pre-push)
  local hook

  $DRY_RUN && {
    echo "DRY-RUN: would activate $hd and record agent identity in $CLONE_DIR/.git/config"
    return 0
  }

  [[ -d "$hd" ]] \
    || die "Clone has no tracked githooks/ directory. Merge the hook migration into $SHARED_BRANCH first, then re-run setup."

  for hook in "${hooks[@]}"; do
    [[ -f "$hd/$hook" ]] || die "Tracked hook githooks/$hook is missing from the clone; pull $SHARED_BRANCH and re-run setup."
    # Backstop for exotic filesystems and core.fileMode=false clones, where the
    # committed 755 mode may not survive checkout. Committed modes cover the
    # normal case; CLI startup validation catches whatever neither does.
    chmod +x "$hd/$hook"
  done

  [[ -r "$hd/lib/identity.sh" ]] || die "Tracked githooks/lib/identity.sh is missing; pull $SHARED_BRANCH and re-run setup."

  git -C "$CLONE_DIR" config core.hooksPath githooks
  git -C "$CLONE_DIR" config consensus.agentId "$AGENT_NAME"
  git -C "$CLONE_DIR" config consensus.agentLabel "$AGENT_LABEL"
  git -C "$CLONE_DIR" config consensus.sharedBranch "$SHARED_BRANCH"
  git -C "$CLONE_DIR" config consensus.remoteName "$REMOTE_NAME"

  echo "Activated tracked hooks: ${hooks[*]}"
  echo "Recorded identity: consensus.agentId=$AGENT_NAME consensus.agentLabel=$AGENT_LABEL"

  # Finish the migration rather than leaving the operator a note. These bodies
  # were generated by an earlier run of this same function, they are inert now
  # that the tracked directory is active, and a stale copy left on disk is the
  # thing most likely to be mistaken later for the hooks Git actually runs.
  # Deleted only after the tracked hooks are verified and activated above, so an
  # early failure can never leave a clone with neither.
  if [[ -d "$CLONE_DIR/.githooks" ]]; then
    rm -rf "$CLONE_DIR/.githooks"
    echo "Removed the pre-migration generated hooks at $CLONE_DIR/.githooks."
  fi

  echo ""
  echo "Verify the installation before publishing anything:"
  echo "  (cd '$CLONE_DIR' && git config --get consensus.agentId)"
}

# --------------------------------------------------- start-<agent>.sh --
common_write_start_sh() {
  $DRY_RUN && {
    echo "DRY-RUN: would write $CLONE_DIR/start-${AGENT_NAME}.sh (launch: $(launcher_command "$AGENT_NAME" | tail -1))"
    return 0
  }

  # The template and this agent's launch command both live in scripts/lib/launcher.sh,
  # because githooks/post-merge regenerates the same file when a pull removes it.
  if ! write_launcher \
    "$CLONE_DIR/start-${AGENT_NAME}.sh" "$AGENT_NAME" "$AGENT_LABEL" "$SHARED_BRANCH"; then
    echo "ERROR: no launch command is defined for agent '$AGENT_NAME'." >&2
    echo "       Add one to launcher_command() in scripts/lib/launcher.sh." >&2
    return 1
  fi
  echo "Wrote launcher: $CLONE_DIR/start-${AGENT_NAME}.sh"
}
