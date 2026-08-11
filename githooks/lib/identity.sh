#!/usr/bin/env bash
# githooks/lib/identity.sh — the runtime identity contract for tracked hooks.
#
# The hook bodies in githooks/ are agent-neutral tracked files: identical bytes
# in every clone, so a generator change propagates with `git pull` and cannot
# leave two clones running different hooks. Everything agent-specific is read
# here, at hook runtime, from ONE explicit contract: this clone's LOCAL Git
# config.
#
#   consensus.agentId      lowercase agent id used in branch names
#   consensus.agentLabel   commit-message prefix / display label
#
# `--local` is deliberate. A global or system fallback would let an unrelated
# machine-wide setting silently supply an identity, which is exactly the
# failure mode these hooks exist to prevent. There is no default identity and
# no interactive prompt: unresolved identity fails the hook closed.
#
# scripts/setup_common.sh writes these keys, and the automation CLI
# (`doctor`, startup validation, fresh-issue.sh) verifies that consensus.agentId
# agrees with the agent whose configured root is this clone.

consensus_agent_id_key="consensus.agentId"
consensus_agent_label_key="consensus.agentLabel"

consensus_identity_failed() {
  echo "HOOK BLOCKED: $1" >&2
  echo "  Hooks never fall back to a default identity." >&2
  echo "  Fix: from the master repo run this clone's setup script (scripts/setup_<agent>.sh)," >&2
  echo "  which writes $consensus_agent_id_key, $consensus_agent_label_key and core.hooksPath=githooks." >&2
  echo "  Then confirm with: git config --get consensus.agentId" >&2
  exit 1
}

# Populates AGENT_NAME, AGENT_LABEL, SHARED_BRANCH and REMOTE_NAME, or exits 1.
consensus_load_identity() {
  local id label shared remote

  id="$(git config --local --get "$consensus_agent_id_key" 2>/dev/null || true)"
  label="$(git config --local --get "$consensus_agent_label_key" 2>/dev/null || true)"

  if [[ -z "$id" ]]; then
    consensus_identity_failed "this clone has no local $consensus_agent_id_key; agent identity is unresolved."
  fi

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
