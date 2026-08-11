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
    echo "  Fix: coord install --product <product> --coord-root <runtime> --agents <agents>" >&2
    return 1
  fi

  if [[ ! -f "$entry" ]]; then
    echo "HOOK BLOCKED: coord.cliEntry points at '$entry', which does not exist." >&2
    echo "  The coordination install was moved or is unbuilt. Fix: run 'pnpm build' in the install root," >&2
    echo "  or re-run coord install." >&2
    return 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "HOOK BLOCKED: node is not on PATH, so coordination cannot read the declared checks for this clone." >&2
    echo "  Only agent clones need this; the product itself is never made to depend on Node." >&2
    return 1
  fi

  printf '%s\n' "$entry"
}

# coord_verify <precommit|prepush>
#
# Runs the declared commands for one phase in this clone. Any non-zero exit —
# a failing check, an undeclared `verify`, an unresolvable install — blocks.
coord_verify() {
  local phase="$1" entry
  entry="$(coord_cli_entry)" || return 1
  node "$entry" hook-verify --clone "$(git rev-parse --show-toplevel)" --phase "$phase"
}

# coord_scope
#
# Emits the declared pre-push scope filter as `prefix\t<value>` and
# `file\t<value>` lines. Empty output means the project declared no narrowing,
# and the caller must treat every push as in scope.
coord_scope() {
  local entry
  entry="$(coord_cli_entry)" || return 1
  node "$entry" hook-scope --clone "$(git rev-parse --show-toplevel)"
}
