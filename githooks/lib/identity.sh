#!/usr/bin/env bash
# githooks/lib/identity.sh — the runtime identity contract for coordination hooks.
#
# These bodies are canonical: one copy, in the coordination install, exec'd by a
# shim in each agent clone's .git/hooks/. Nothing agent-specific is edited into
# them. Everything agent-specific is read here, at hook runtime, from ONE
# explicit contract: this clone's LOCAL Git config.
#
#   consensus.agentId      lowercase agent id used in branch names
#   consensus.agentLabel   commit-message prefix / display label
#
# `--local` is deliberate. A global or system fallback would let an unrelated
# machine-wide setting silently supply an identity, which is exactly the failure
# mode these hooks exist to prevent.
#
# Three outcomes, and the differences matter:
#
#   wiring present, id unset/malformed -> an agent clone with a broken
#                         identity. FAILS CLOSED. Coordination wiring is what
#                         makes this an agent clone, so an agent that lost its
#                         id must not keep committing ungated. This is the case
#                         all four issue-4 reviews flagged: keying the decision
#                         on the id alone let `git config --unset
#                         consensus.agentId` skip branch ownership, the commit
#                         prefix, and the declared verify, in a clone that was
#                         otherwise fully installed.
#   no wiring, id unset -> not an agent clone. Coordination has no business
#                         here, so the hook passes through. Placement already
#                         guarantees a human clone has no hooks; this keeps that
#                         true for a shared, migrating, or vendored tree, so
#                         coordination can never turn someone else's working
#                         repository into a blocked one.
#   no wiring, id set   -> honour the id. A clone can carry an identity before
#                         the installer has finished wiring it.
#
# `coord doctor` cross-checks that consensus.agentId agrees with the agent whose
# configured root is this clone, which is the check a hook cannot make.

consensus_agent_id_key="consensus.agentId"
consensus_agent_label_key="consensus.agentLabel"

# True when this clone carries coordination install wiring. Any one of these is
# proof: the installer writes all of them, and an agent can only remove them by
# deliberately dismantling its own gating, which is what must fail closed.
consensus_wiring_present() {
  local key value git_dir

  for key in coord.installRoot coord.cliEntry coord.workspaceConfig; do
    value="$(git config --local --get "$key" 2>/dev/null || true)"
    [[ -n "$value" ]] && return 0
  done

  git_dir="$(git rev-parse --absolute-git-dir 2>/dev/null || true)"
  [[ -n "$git_dir" && -f "$git_dir/hooks/coord-hooks.json" ]]
}

consensus_identity_failed() {
  echo "HOOK BLOCKED: $1" >&2
  echo "  This clone has coordination hooks installed, so it is an agent clone and must not commit without running the project's declared checks." >&2
  echo "  Hooks never fall back to a default identity." >&2
  echo "  Fix: coord install --product <product> --coord-root <runtime> --agents <agents>" >&2
  echo "  Then confirm with: git config --local --get consensus.agentId" >&2
  exit 1
}

# Populates CONSENSUS_AGENT_CLONE, and when true also AGENT_NAME, AGENT_LABEL,
# SHARED_BRANCH and REMOTE_NAME. Exits 1 on a malformed agent identity.
consensus_load_identity() {
  local id label shared remote

  id="$(git config --local --get "$consensus_agent_id_key" 2>/dev/null || true)"

  if [[ -z "$id" ]]; then
    if consensus_wiring_present; then
      consensus_identity_failed "this clone carries coordination install wiring but has no local $consensus_agent_id_key; agent identity is unresolved."
    fi
    CONSENSUS_AGENT_CLONE=false
    return 0
  fi

  CONSENSUS_AGENT_CLONE=true
  label="$(git config --local --get "$consensus_agent_label_key" 2>/dev/null || true)"

  if [[ ! "$id" =~ ^[a-z][a-z0-9-]*$ ]]; then
    consensus_identity_failed "local $consensus_agent_id_key '$id' is not a valid agent id (lowercase letters, digits and hyphens)."
  fi

  if [[ -z "$label" ]]; then
    consensus_identity_failed "this clone has no local $consensus_agent_label_key; the commit-message prefix is unresolved."
  fi

  if [[ ! "$label" =~ ^[A-Za-z][A-Za-z0-9\ ._-]*$ ]]; then
    consensus_identity_failed "local $consensus_agent_label_key '$label' is not a valid commit-message label."
  fi

  # Shared branch and remote are project policy, not identity: they are the
  # same in every honest clone, so they default rather than fail closed.
  shared="$(git config --local --get consensus.sharedBranch 2>/dev/null || true)"
  remote="$(git config --local --get consensus.remoteName 2>/dev/null || true)"

  AGENT_NAME="$id"
  AGENT_LABEL="$label"
  SHARED_BRANCH="${shared:-main}"
  REMOTE_NAME="${remote:-origin}"
}

# Every hook body starts with this line; keep the failure path identical.
consensus_load_identity
