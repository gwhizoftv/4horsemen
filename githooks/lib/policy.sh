#!/usr/bin/env bash
# githooks/lib/policy.sh — the bridge from a hook body to the project's own
# declared verification.
#
# What is deliberately absent from every hook in this directory: any test for
# package.json, for a lockfile name, or for a script name. Those tests made the
# hooks silently do nothing on a Rust or Go product — a guard that is skipped
# reports success, which is the one failure this project refuses. What runs is
# whatever the project declared as argument vectors in the owner's workspace
# config, and a project that declared nothing blocks rather than passes.
#
# The config is read by the coordination CLI, not parsed here: one parser,
# shared with `coord start`, so the hooks and the driver cannot disagree about
# what a workspace config means.

coord_cli_entry() {
  local entry
  entry="$(git config --local --get coord.cliEntry 2>/dev/null || true)"

  if [[ -z "$entry" ]]; then
    echo "HOOK BLOCKED: this clone has no local coord.cliEntry, so the project's declared checks cannot be resolved." >&2
    echo "  Fix: coord install --product <product> --coord-runtime <runtime> --agents <agents>" >&2
    return 1
  fi

  if [[ ! -f "$entry" ]]; then
    echo "HOOK BLOCKED: coord.cliEntry points at '$entry', which does not exist." >&2
    echo "  The coordination install was moved or is unbuilt. Fix: run 'pnpm build' in the install root," >&2
    echo "  or re-run coord install." >&2
    return 1
  fi

  printf '%s\n' "$entry"
}

# coord_node <entry>
#
# The install's Node selector, found from the recorded entry rather than from
# this file: vendored clones carry a copy of this library but no install root.
# The selector, not PATH, picks the Node that runs the CLI, so a product that
# pins an older Node (issue 234) keeps it for its own checks. Only agent clones
# need this; the product itself is never made to depend on Node.
coord_node() {
  local runtime
  runtime="$(dirname "$(dirname "$1")")/scripts/lib/node-runtime.sh"
  if [[ ! -x "$runtime" ]]; then
    echo "HOOK BLOCKED: '$runtime' is missing, so coordination cannot choose the Node that reads the declared checks." >&2
    echo "  The coordination install was moved or is incomplete. Fix: update it, or re-run coord install." >&2
    return 1
  fi
  printf '%s\n' "$runtime"
}

# coord_verify <precommit|prepush>
#
# Runs the declared commands for one phase in this clone. Any non-zero exit —
# a failing check, an undeclared `verify`, an unresolvable install — blocks.
# Prepush receives the buffered outgoing ref list on stdin; precommit inspects
# Git's index. Classification and measurement live in the same CLI as coord.
coord_verify() {
  local phase="$1" entry runtime
  entry="$(coord_cli_entry)" || return 1
  runtime="$(coord_node "$entry")" || return 1
  "$runtime" "$entry" hook-verify --clone "$(git rev-parse --show-toplevel)" --phase "$phase"
}

# coord_scope (legacy installed-hook compatibility only)
#
# Current hooks use coord_verify's shared classifier, not this older filter.
coord_scope() {
  local entry runtime
  entry="$(coord_cli_entry)" || return 1
  runtime="$(coord_node "$entry")" || return 1
  "$runtime" "$entry" hook-scope --clone "$(git rev-parse --show-toplevel)"
}
