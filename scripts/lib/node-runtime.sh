#!/bin/sh
# Select a Node runtime that satisfies the coordinator engines floor (>=26.0.0)
# without sourcing nvm or mutating the caller's interactive shell.
#
# Usage:
#   scripts/lib/node-runtime.sh --print-path
#     Print the absolute path of a compatible node binary; exit 0.
#   scripts/lib/node-runtime.sh <args...>
#     Exec the selected node with the given arguments (stdin inherited).
set -eu

# Keep in lockstep with package.json engines.node and .nvmrc (asserted in tests).
COORD_NODE_MIN_MAJOR=26

coord_node_version_ok() {
  # Probe the executable itself; reject failures, malformed output, and prereleases.
  bin=$1
  [ -n "$bin" ] && [ -x "$bin" ] || return 1
  case $(basename "$bin") in
    node) ;;
    *) return 1 ;;
  esac
  ver=$("$bin" --version 2>/dev/null) || return 1
  # Expect vMAJOR.MINOR.PATCH with no prerelease suffix.
  case $ver in
    v[0-9]*.[0-9]*.[0-9]*)
      rest=${ver#v}
      case $rest in
        *-*) return 1 ;;
      esac
      major=${rest%%.*}
      rest=${rest#*.}
      minor=${rest%%.*}
      patch=${rest#*.}
      case $major$minor$patch in
        *[!0-9]*) return 1 ;;
      esac
      [ "$major" -gt "$COORD_NODE_MIN_MAJOR" ] && return 0
      [ "$major" -eq "$COORD_NODE_MIN_MAJOR" ] || return 1
      [ "$minor" -gt 0 ] && return 0
      [ "$minor" -eq 0 ] || return 1
      [ "$patch" -ge 0 ]
      ;;
    *) return 1 ;;
  esac
}

coord_node_abs() {
  bin=$1
  case $bin in
    /*) printf '%s\n' "$bin" ;;
    *)
      # Resolve relative candidates without changing the caller's cwd permanently.
      dir=$(CDPATH= cd -P -- "$(dirname -- "$bin")" && pwd)
      printf '%s\n' "$dir/$(basename -- "$bin")"
      ;;
  esac
}

coord_node_version_label() {
  bin=$1
  if [ -n "$bin" ] && [ -x "$bin" ]; then
    "$bin" --version 2>/dev/null || printf '%s\n' "unreadable"
  else
    printf '%s\n' "none"
  fi
}

coord_node_fail() {
  ambient_path=
  ambient_ver=none
  # Report the first PATH node when present, even if incompatible.
  old_ifs=$IFS
  IFS=:
  for dir in ${PATH-}; do
    IFS=$old_ifs
    [ -n "$dir" ] || dir=.
    candidate=$dir/node
    if [ -x "$candidate" ]; then
      ambient_path=$(coord_node_abs "$candidate")
      ambient_ver=$(coord_node_version_label "$ambient_path")
      break
    fi
    IFS=:
  done
  IFS=$old_ifs
  nvm_root=${NVM_DIR:-${HOME}/.nvm}
  printf '%s\n' \
    "coord: Node >=${COORD_NODE_MIN_MAJOR}.0.0 is required for the coordinator runtime." \
    "  ambient node: ${ambient_path:-none} (${ambient_ver})" \
    "  searched nvm versions under: ${nvm_root}/versions/node" \
    "  Install Node ${COORD_NODE_MIN_MAJOR}+ for coord, or set COORD_NODE to an absolute path to a qualifying node binary." \
    "  The product workspace development Node is left unchanged." >&2
  exit 1
}

coord_node_compare() {
  # Return 0 if $1 (MAJOR.MINOR.PATCH) is greater than $2.
  a=$1 b=$2
  a_major=${a%%.*}; a_rest=${a#*.}; a_minor=${a_rest%%.*}; a_patch=${a_rest#*.}
  b_major=${b%%.*}; b_rest=${b#*.}; b_minor=${b_rest%%.*}; b_patch=${b_rest#*.}
  [ "$a_major" -gt "$b_major" ] && return 0
  [ "$a_major" -eq "$b_major" ] || return 1
  [ "$a_minor" -gt "$b_minor" ] && return 0
  [ "$a_minor" -eq "$b_minor" ] || return 1
  [ "$a_patch" -gt "$b_patch" ]
}

coord_node_select() {
  selected=

  if [ -n "${COORD_NODE-}" ]; then
    case $COORD_NODE in
      /*) ;;
      *)
        printf '%s\n' "coord: COORD_NODE must be an absolute path to a node executable (got: $COORD_NODE)." >&2
        exit 1
        ;;
    esac
    if ! coord_node_version_ok "$COORD_NODE"; then
      printf '%s\n' "coord: COORD_NODE=$COORD_NODE is missing, not named node, or older than >=${COORD_NODE_MIN_MAJOR}.0.0 ($(coord_node_version_label "$COORD_NODE"))." >&2
      exit 1
    fi
    selected=$(coord_node_abs "$COORD_NODE")
    printf '%s\n' "$selected"
    return 0
  fi

  old_ifs=$IFS
  IFS=:
  for dir in ${PATH-}; do
    IFS=$old_ifs
    [ -n "$dir" ] || dir=.
    candidate=$dir/node
    if coord_node_version_ok "$candidate"; then
      selected=$(coord_node_abs "$candidate")
      printf '%s\n' "$selected"
      return 0
    fi
    IFS=:
  done
  IFS=$old_ifs

  nvm_root=${NVM_DIR:-${HOME}/.nvm}
  best=
  best_ver=
  if [ -d "$nvm_root/versions/node" ]; then
    for candidate in "$nvm_root"/versions/node/v*/bin/node; do
      [ -x "$candidate" ] || continue
      coord_node_version_ok "$candidate" || continue
      ver=$("$candidate" --version 2>/dev/null) || continue
      ver=${ver#v}
      if [ -z "$best" ] || coord_node_compare "$ver" "$best_ver"; then
        best=$candidate
        best_ver=$ver
      fi
    done
  fi
  if [ -n "$best" ]; then
    selected=$(coord_node_abs "$best")
    printf '%s\n' "$selected"
    return 0
  fi

  coord_node_fail
}

selected=$(coord_node_select)
if [ "${1-}" = "--print-path" ]; then
  printf '%s\n' "$selected"
  exit 0
fi
exec "$selected" "$@"
