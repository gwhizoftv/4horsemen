#!/bin/sh
# scripts/lib/node-runtime.sh — run coordination's own JavaScript on a Node it
# supports, whatever Node the product workspace has selected.
#
#   node-runtime.sh <node arguments...>   exec the selected Node with them
#   node-runtime.sh --print-path          print the selected Node's path only
#
# Every shell entry point that starts the driver comes through here before any
# driver module loads: a too-old Node fails while linking ES modules (issue 234
# saw ERR_UNKNOWN_BUILTIN_MODULE for node:readline/promises under Node 16), so
# no check inside the driver could ever run.
#
# Selection never changes the environment. PATH is passed through untouched, so
# product commands the driver starts still find the workspace's own Node; only
# the executable that runs the driver differs. Probes read /dev/null, so stdin
# reaches the selected Node intact (pre-push refs, credential requests).
#
# Order: COORD_NODE when set (never silently ignored), then each node on PATH in
# order, then the newest install under $NVM_DIR/versions/node (nvm itself is not
# sourced). Any other version manager can supply its executable via COORD_NODE.
#
# POSIX sh on purpose: scripts/bootstrap.sh is run as `curl ... | sh`.
set -eu

# Keep in step with package.json engines.node (test/wrapper.test.ts checks).
COORD_NODE_MIN_MAJOR=26

# Prints MAJOR.MINOR.PATCH for a stable release, or fails for a missing,
# failing, malformed or prerelease probe. The binary is asked itself; a
# directory named v26 proves nothing.
node_version() {
  probe=$("$1" --version </dev/null 2>/dev/null) || return 1
  case "$probe" in
    v*) probe=${probe#v} ;;
    *) return 1 ;;
  esac
  probe_major=${probe%%.*}
  probe_rest=${probe#*.}
  probe_minor=${probe_rest%%.*}
  probe_patch=${probe_rest#*.}
  for probe_part in "$probe_major" "$probe_minor" "$probe_patch"; do
    case "$probe_part" in
      '' | *[!0-9]*) return 1 ;;
    esac
  done
  printf '%s\n' "$probe_major.$probe_minor.$probe_patch"
}

supported() {
  [ "${1%%.*}" -ge "$COORD_NODE_MIN_MAJOR" ]
}

# Succeeds when version $1 is newer than version $2 (both MAJOR.MINOR.PATCH).
# Numeric fields, so v26.10.0 beats v26.9.0 without GNU `sort -V`.
newer() {
  a_major=${1%%.*} a_rest=${1#*.}
  b_major=${2%%.*} b_rest=${2#*.}
  a_minor=${a_rest%%.*} a_patch=${a_rest#*.}
  b_minor=${b_rest%%.*} b_patch=${b_rest#*.}
  [ "$a_major" -ne "$b_major" ] && { [ "$a_major" -gt "$b_major" ]; return; }
  [ "$a_minor" -ne "$b_minor" ] && { [ "$a_minor" -gt "$b_minor" ]; return; }
  [ "$a_patch" -gt "$b_patch" ]
}

refuse() {
  printf '%s\n' "coord: $1" >&2
  printf '%s\n' "  The product's own Node is left as it is. Install Node $COORD_NODE_MIN_MAJOR for coordination" >&2
  printf '%s\n' "  (for example: nvm install $COORD_NODE_MIN_MAJOR), or point COORD_NODE at one:" >&2
  printf '%s\n' "  export COORD_NODE=/absolute/path/to/node" >&2
  exit 1
}

select_node() {
  if [ -n "${COORD_NODE:-}" ]; then
    case "$COORD_NODE" in
      /*/node | /node) ;;
      *) refuse "COORD_NODE=$COORD_NODE must be an absolute path to an executable named node." ;;
    esac
    [ -f "$COORD_NODE" ] && [ -x "$COORD_NODE" ] ||
      refuse "COORD_NODE=$COORD_NODE is not an executable file."
    found=$(node_version "$COORD_NODE") ||
      refuse "COORD_NODE=$COORD_NODE did not report a stable Node version."
    supported "$found" ||
      refuse "COORD_NODE=$COORD_NODE is Node v$found; coordination needs Node >= $COORD_NODE_MIN_MAJOR."
    selected=$COORD_NODE
    return 0
  fi

  ambient=""
  # Empty and relative PATH entries name the caller's cwd — the product
  # workspace — which is no place to pick coordination's runtime from.
  saved_ifs=$IFS
  IFS=:
  set -f
  for dir in ${PATH:-}; do
    case "$dir" in
      /*) ;;
      *) continue ;;
    esac
    candidate=$dir/node
    [ -f "$candidate" ] && [ -x "$candidate" ] || continue
    if found=$(node_version "$candidate"); then
      [ -n "$ambient" ] || ambient="v$found at $candidate"
      if supported "$found"; then
        selected=$candidate
        break
      fi
    else
      [ -n "$ambient" ] || ambient="an unrecognized version at $candidate"
    fi
  done
  IFS=$saved_ifs
  set +f
  [ -z "$selected" ] || return 0

  nvm_versions=${NVM_DIR:-$HOME/.nvm}/versions/node
  best_version=""
  case "$nvm_versions" in
    /*)
      for candidate in "$nvm_versions"/v*/bin/node; do
        [ -f "$candidate" ] && [ -x "$candidate" ] || continue
        found=$(node_version "$candidate") || continue
        supported "$found" || continue
        if [ -z "$best_version" ] || newer "$found" "$best_version"; then
          selected=$candidate
          best_version=$found
        fi
      done
      ;;
  esac
  [ -z "$selected" ] || return 0

  refuse "Node >= $COORD_NODE_MIN_MAJOR is required to run coordination, but none was found.
  node on PATH: ${ambient:-none}
  searched: PATH, then $nvm_versions"
}

selected=""
select_node
if [ "$#" -eq 1 ] && [ "$1" = --print-path ]; then
  printf '%s\n' "$selected"
  exit 0
fi
exec "$selected" "$@"
