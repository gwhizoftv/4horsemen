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
# Two outcomes, and the difference matters:
#
#   agentId unset      -> this is not an agent clone. Coordination has no
#                         business here, so the hook passes through. Placement
#                         already guarantees a human clone has no hooks at all;
#                         this is defence in depth for a shared or migrating
#                         tree, so that coordination can never turn someone
#                         else's working repository into a blocked one.
#   agentId malformed  -> an agent clone with a broken identity. Fails closed.
#
# `coord doctor` cross-checks that consensus.agentId agrees with the agent whose
# configured root is this clone, which is the check a pass-through cannot make.

consensus_agent_id_key="consensus.agentId"
consensus_agent_label_key="consensus.agentLabel"

consensus_identity_failed() {
  echo "HOOK BLOCKED: $1" >&2
  echo "  This clone has coordination hooks installed, so it is an agent clone and must not commit ungated." >&2
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
