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
#
# Every vendor below accepts --add-dir for an extra writable root, so the
# completion mailbox is granted with "${coord_grant[@]}" rather than by widening
# the sandbox. That array is computed by the generated launcher at exec time
# (see write_launcher); it is empty when there is no current issue. The
# expansion is written as ${a[@]+"${a[@]}"} because macOS /bin/bash is 3.2,
# where a plain "${a[@]}" on an empty array aborts under `set -u`.
launcher_command() {
  case "$1" in
    claude)
      printf 'exec claude --permission-mode auto ${coord_grant[@]+"${coord_grant[@]}"}\n'
      ;;
    codex)
      # The completion receipt now lives in the mailbox, which is granted
      # explicitly, so workspace-write is enough. danger-full-access was only
      # ever here because `complete` sat under coord-runtime and workspace-write
      # prompted for it — that reason is gone, and the broad grant reached
      # cursors.json and peers' orders along with it.
      printf 'exec codex --ask-for-approval never --sandbox workspace-write ${coord_grant[@]+"${coord_grant[@]}"}\n'
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
      #
      # Deliberately NOT given `agy --sandbox`, which its own --help describes as
      # "Run in a sandbox with terminal restrictions enabled". This agent has to
      # run `git push` and the project's declared checks from its terminal; a
      # restriction there would stop it publishing the very commit whose SHA it
      # must then write, which is worse than the write refusal being fixed. It
      # also contradicts --dangerously-skip-permissions on the same line. The
      # add-dir below is therefore advisory for this vendor until the sandbox
      # can be verified against a real agy run that pushes.
      printf 'export PATH="$HOME/.local/bin:$PATH"\nexec agy --mode accept-edits --dangerously-skip-permissions ${coord_grant[@]+"${coord_grant[@]}"}\n'
      ;;
    gemini)
      # No mailbox grant: gemini is not a configured coordination harness and
      # has no completion receipt to write.
      printf 'exec gemini\n'
      ;;
    cursor)
      # --add-dir only means something if the harness is sandboxed: an
      # unsandboxed agent can already write anywhere, so the narrow grant would
      # be decoration. `agent --sandbox` documents the exact choices
      # enabled|disabled, so state it rather than relying on the vendor default.
      printf 'if (( ${#coord_grant[@]} > 0 )); then\n  exec agent --sandbox enabled "${coord_grant[@]}"\nelse\n  exec agent\nfi\n'
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
#
# The signature stays at four arguments on purpose. The mailbox grant is
# per-issue, and neither caller knows an issue number: `coord install` runs
# before any issue exists, and `githooks/post-merge` has only the clone's
# identity. Baking a drop directory in here would need a fifth argument the hook
# cannot supply, and re-rendering the file at `coord start` would make the
# coordinator write inside agent clones and give the hook a second, disagreeing
# template. So the generated launcher stays path-independent and resolves the
# current drop itself, from the clone-local coord.completesRoot key plus
# COORD_ISSUE, which coordination exports on the tmux session before the harness
# starts.
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

# Grant this harness exactly two extra writable directories, both scoped to the
# current issue and this agent:
#
#   1. its own drop inside the completion mailbox, and
#   2. its own responses/ directory inside the coordinator runtime.
#
# Never the coordinator runtime itself (which holds cursors.json, the journal,
# and peers' orders), never the whole mailbox (which holds peers' receipts), and
# never this agent's own runtime root — that root holds action.md, the document
# carrying this agent's current authority, and an agent able to rewrite its own
# order could authorize its own ballot. The accepted-response archive is a
# sibling of responses/ and is deliberately outside both grants: it is the
# record of what was accepted, so a vote that could be edited afterwards would
# not be evidence. Both are empty outside an automated issue.
coord_grant=()
coord_completes_root="\$(git config --local --get coord.completesRoot 2>/dev/null || true)"
coord_workspace_config="\$(git config --local --get coord.workspaceConfig 2>/dev/null || true)"
if [[ -n "\$coord_completes_root" && "\${COORD_ISSUE:-}" =~ ^[1-9][0-9]*\$ ]]; then
  coord_drop="\$coord_completes_root/issue-\$COORD_ISSUE/$agent"
  if [[ -d "\$coord_drop" ]]; then
    coord_grant+=(--add-dir "\$coord_drop")
    echo "Completion mailbox: \$coord_drop"
  else
    echo "WARNING: completion mailbox \$coord_drop does not exist; this harness cannot publish its SHA." >&2
    echo "  Fix: coord doctor, or restart the issue so coord start recreates it." >&2
  fi
elif [[ -z "\$coord_completes_root" ]]; then
  echo "WARNING: coord.completesRoot is unset in this clone; no completion mailbox will be granted." >&2
  echo "  Fix: re-run coord install for this workspace." >&2
fi

# The coordinator runtime root is the directory holding the workspace config, in
# both the flat and nested layouts.
if [[ -n "\$coord_workspace_config" && "\${COORD_ISSUE:-}" =~ ^[1-9][0-9]*\$ ]]; then
  coord_responses="\$(dirname "\$coord_workspace_config")/issue-\$COORD_ISSUE/agents/$agent/responses"
  if [[ -d "\$coord_responses" ]]; then
    coord_grant+=(--add-dir "\$coord_responses")
    echo "Response directory: \$coord_responses"
  else
    echo "WARNING: response directory \$coord_responses does not exist; this harness cannot answer a ballot." >&2
    echo "  Fix: coord doctor, or restart the issue so coord start recreates it." >&2
  fi
elif [[ -z "\$coord_workspace_config" ]]; then
  echo "WARNING: coord.workspaceConfig is unset in this clone; no response directory will be granted." >&2
  echo "  Fix: re-run coord install for this workspace." >&2
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
