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
      # --no-daemon keeps hooks in-process so they inherit this pane's COORD_ISSUE
      # and .coord/bin PATH instead of a shared app-server with a stale issue.
      printf 'exec codex --ask-for-approval never --sandbox workspace-write --no-daemon ${coord_grant[@]+"${coord_grant[@]}"}\n'
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

# write_git_wrapper <path> <real-git> <clone-root>
#
# Emits the untracked `.coord/bin/git` shim that the generated launcher puts on
# PATH. It exists to stop an agent re-deriving checkout state the coordinator
# already owns: during an automated issue `git status` and `git diff` against
# *this clone* are refused, and `git show` is narrowed to the exact peer-pin
# form. Everything else — add, commit, push, fetch, checkout, rev-parse, config,
# log — is delegated untouched.
#
# Two properties keep the shim from becoming a liability:
#
#   1. It refuses only when the invocation actually targets this clone. A
#      product's own tooling and test suite legitimately shell out to git
#      against fixture repositories, and this repository's fast suite does
#      exactly that (`git status --porcelain` in src/gitExec.ts, `git -C <dir>
#      diff` in src/pinValidation.ts). Blocking on the subcommand alone breaks
#      `pnpm check:fast` — the very check an agent must pass before it can
#      commit. So `-C`, `--git-dir`, `--work-tree`, GIT_DIR, and GIT_WORK_TREE
#      are resolved to a path and compared against the clone rather than being
#      treated as an automatic bypass: `git -C . status` inside the clone is
#      still refused, `git -C /tmp/fixture status` is not.
#
#   2. Global options are parsed before the subcommand is chosen, so
#      `git --no-pager diff` cannot slip past a naive `$1` test.
#
# REAL_GIT is absolute and resolved once at install from a PATH without
# .coord/bin, so the shim can never re-enter itself.
write_git_wrapper() {
  local path="$1" real_git="$2" clone="$3" dir

  dir="$(dirname "$path")"
  mkdir -p "$dir" || return 1

  cat > "$path" <<EOF
#!/usr/bin/env bash
# coord-managed-git-wrapper
# Generated per clone and never tracked. Template: scripts/lib/launcher.sh.
# Regenerated by \`coord install\` and by githooks/post-merge; edits are overwritten.
set -uo pipefail
REAL_GIT="$real_git"
COORD_CLONE="$clone"
EOF

  cat >> "$path" <<'COORD_GIT_WRAPPER'

if [[ ! -x "$REAL_GIT" ]]; then
  echo "coord: real git is missing at $REAL_GIT; re-run coord install for this clone." >&2
  exit 127
fi

delegate() {
  # The native tool guard asks this same policy without executing the command.
  if [[ "${COORD_GIT_POLICY_CHECK:-}" == 1 ]]; then exit 0; fi
  exec env COORD_GIT_DELEGATE=1 "$REAL_GIT" "$@"
}

# Anything git itself spawned (hooks, and coordination's own subprocesses) is
# already inside a delegated call and must never be second-guessed.
if [[ "${COORD_GIT_DELEGATE:-}" == 1 ]]; then
  if [[ "${COORD_GIT_POLICY_CHECK:-}" == 1 ]]; then exit 0; fi
  exec "$REAL_GIT" "$@"
fi

# Owner-driven manual mode: no automated issue, no restrictions.
if [[ ! "${COORD_ISSUE:-}" =~ ^[1-9][0-9]*$ ]]; then
  delegate "$@"
fi

# Resolve the repository this invocation targets, and the subcommand, reading
# the global options exactly as git does.
coord_target="${GIT_WORK_TREE:-${GIT_DIR:-$PWD}}"
coord_sub=""
coord_argv=("$@")
coord_i=0
while (( coord_i < $# )); do
  case "${coord_argv[coord_i]}" in
    -C)             coord_target="${coord_argv[coord_i+1]:-}"; coord_i=$(( coord_i + 2 )) ;;
    --git-dir)      coord_target="${coord_argv[coord_i+1]:-}"; coord_i=$(( coord_i + 2 )) ;;
    --work-tree)    coord_target="${coord_argv[coord_i+1]:-}"; coord_i=$(( coord_i + 2 )) ;;
    --git-dir=*)    coord_target="${coord_argv[coord_i]#--git-dir=}"; coord_i=$(( coord_i + 1 )) ;;
    --work-tree=*)  coord_target="${coord_argv[coord_i]#--work-tree=}"; coord_i=$(( coord_i + 1 )) ;;
    -c|--namespace) coord_i=$(( coord_i + 2 )) ;;
    -*)             coord_i=$(( coord_i + 1 )) ;;
    *)              coord_sub="${coord_argv[coord_i]}"; break ;;
  esac
done

# A bare repository or a `--git-dir` points at `<worktree>/.git`; compare the
# worktree either way.
case "$coord_target" in
  /*) ;;
  *)  coord_target="$PWD/$coord_target" ;;
esac
coord_target="${coord_target%/}"
coord_target="${coord_target%/.git}"
if [[ -d "$coord_target" ]]; then
  coord_resolved="$(cd -- "$coord_target" 2>/dev/null && pwd -P)" || coord_resolved=""
  [[ -n "$coord_resolved" ]] && coord_target="$coord_resolved"
fi

if [[ "$coord_target" != "$COORD_CLONE" ]]; then
  delegate "$@"
fi

coord_refuse() {
  echo "coord: 'git $1' is blocked in this clone during automated issue $COORD_ISSUE." >&2
  echo "  Coordination owns this checkout and already resolved what changed." >&2
  echo "  Read bound peer artifacts from the paths listed under" >&2
  echo "  '## Bound input files' in your action.md, and read your own files directly." >&2
  exit 2
}

# Whether the action in front of this agent already lists the files a `git show`
# would be duplicating. Resolved from the clone's own identity keys and the
# nested-vs-flat topology, exactly as the launcher resolves its grants, and
# through $REAL_GIT so this never re-enters the shim.
#
# Fails open on purpose: every unreadable config, missing action, or absent
# section leaves the pinned read allowed. The documented fallback for a packet
# the coordinator could not produce must survive anything going wrong here.
coord_action_lists_files() {
  local config agent dir parent root action
  config="$("$REAL_GIT" config --local --get coord.workspaceConfig 2>/dev/null)" || return 1
  agent="$("$REAL_GIT" config --local --get consensus.agentId 2>/dev/null)" || return 1
  [[ -n "$config" && -n "$agent" && -f "$config" ]] || return 1
  dir="$(dirname "$config")"
  parent="$(dirname "$dir")"
  if [[ "$(basename "$parent")" == "workspaces" ]]; then root="$(dirname "$parent")"; else root="$dir"; fi
  action="$root/issue-$COORD_ISSUE/agents/$agent/action.md"
  [[ -f "$action" ]] || return 1
  grep -q '^## Bound input files$' "$action" 2>/dev/null || return 1
  # A partly exported action keeps the fallback: the input that is missing from
  # disk is reachable only through its pin. See INCOMPLETE_MATERIALIZATION_NOTE
  # in src/action.ts, which is the line this matches.
  ! grep -q '^Not every bound input could be exported' "$action" 2>/dev/null
}

case "$coord_sub" in
  status|diff)
    coord_refuse "$coord_sub"
    ;;
  show)
    # Two different things wear this name. `git show <rev>` prints a commit and
    # its full diff, which is the reconnaissance `diff` is blocked for. But
    # `git show <rev>:<path>` is an ordinary file read, and a product's own
    # tooling does it against its own history — this repository's language test
    # reads `HEAD:AGENTS.md` that way. Refusing every `show` breaks the suite an
    # agent has to pass; refusing only the peer-pin read does not.
    coord_operand="${coord_argv[coord_i+1]:-}"
    case "$coord_operand" in
      *:*)
        if [[ "$coord_operand" =~ ^[0-9a-f]{40}: ]] && coord_action_lists_files; then
          # A pinned peer read the coordinator has already exported: the same
          # bytes by the expensive route, which is the repetition this change
          # exists to stop. Without the packet it stays allowed as the fallback.
          echo "coord: 'git show' is blocked in this clone during automated issue $COORD_ISSUE." >&2
          echo "  The coordinator already exported this content. Read the paths listed" >&2
          echo "  under '## Bound input files' in your action.md instead." >&2
          exit 2
        fi
        ;;
      *)
        coord_refuse "show"
        ;;
    esac
    ;;
esac

delegate "$@"
COORD_GIT_WRAPPER

  chmod +x "$path"
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

# Grant this harness two narrow writable directories for an automated issue:
# 1) the completion mailbox drop (Git SHA / response markers)
# 2) this agent's ballot response directory under the issue runtime
# Never grant the issue root, peer directories, or the accepted-response archive.
coord_grant=()
coord_completes_root="\$(git config --local --get coord.completesRoot 2>/dev/null || true)"
coord_workspace_config="\$(git config --local --get coord.workspaceConfig 2>/dev/null || true)"
if [[ -n "\$coord_completes_root" && "\${COORD_ISSUE:-}" =~ ^[1-9][0-9]*\$ ]]; then
  coord_drop="\$coord_completes_root/issue-\$COORD_ISSUE/$agent"
  if [[ -d "\$coord_drop" ]]; then
    coord_grant+=(--add-dir "\$coord_drop")
    echo "Completion mailbox: \$coord_drop"
  else
    echo "WARNING: completion mailbox \$coord_drop does not exist; this harness cannot publish its receipt." >&2
    echo "  Fix: coord doctor, or restart the issue so coord start recreates it." >&2
  fi
elif [[ -z "\$coord_completes_root" ]]; then
  echo "WARNING: coord.completesRoot is unset in this clone; no completion mailbox will be granted." >&2
  echo "  Fix: re-run coord install for this workspace." >&2
fi
# Response dir: derive coord root from coord.workspaceConfig path topology
# (nested: …/workspaces/<project>/config.json → outer coord root; flat: config
# dir is the coord root). Never read a coordRoot field from the JSON.
if [[ -n "\$coord_workspace_config" && -f "\$coord_workspace_config" && "\${COORD_ISSUE:-}" =~ ^[1-9][0-9]*\$ ]]; then
  coord_config_dir="\$(dirname "\$coord_workspace_config")"
  coord_config_parent="\$(dirname "\$coord_config_dir")"
  if [[ "\$(basename "\$coord_config_parent")" == "workspaces" ]]; then
    coord_root="\$(dirname "\$coord_config_parent")"
  else
    coord_root="\$coord_config_dir"
  fi
  coord_responses="\$coord_root/issue-\$COORD_ISSUE/agents/$agent/responses"
  if [[ -d "\$coord_responses" ]]; then
    coord_grant+=(--add-dir "\$coord_responses")
    echo "Ballot responses: \$coord_responses"
  else
    echo "WARNING: response directory \$coord_responses does not exist; ballot response actions cannot write." >&2
    echo "  Fix: coord doctor, or restart the issue so coord start recreates it." >&2
  fi
  # Bound peer artifacts the coordinator materialized for this issue. Granted as
  # the two per-issue parents, not per action: this file is regenerated by
  # githooks/post-merge with no issue and no action in hand, and the harness is
  # launched once per pane, so a grant naming a directory that only exists later
  # could never reach the running process. Both parents are created before any
  # harness starts and hold nothing but copies of artifacts already bound into
  # this agent's own action; cursors.json, the journal, peer orders, and peer
  # mailboxes all stay outside them.
  for coord_materialized in "\$coord_root/issue-\$COORD_ISSUE/inputs" "\$coord_root/issue-\$COORD_ISSUE/worktrees"; do
    if [[ -d "\$coord_materialized" ]]; then
      coord_grant+=(--add-dir "\$coord_materialized")
      echo "Bound input files: \$coord_materialized"
    fi
  done
fi

echo "=== $label agent | branches issue-<n>/$agent or $agent/<name> | shared: $shared ==="
echo "Automated issue mode: fetch your coordinator action with:"
echo "  coord next --issue <n>"
echo "(uses this clone's coord.workspaceConfig + consensus.agentId)."
echo "Owner-driven manual mode: wait for the owner's chat task, then work on"
echo "  $agent/<name>"
echo "Do not fabricate coordinator actions or evidence in manual mode."

# Last, so every git read above this line runs unmodified: the shim refuses the
# checkout reads coordination already owns once COORD_ISSUE names an issue.
if [[ -x .coord/bin/git ]]; then
  export PATH="\$(pwd)/.coord/bin:\$PATH"
fi

$command
EOF

  chmod +x "$path"
}
