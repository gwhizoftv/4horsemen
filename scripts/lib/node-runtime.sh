#!/bin/sh
# Resolve or exec a Node.js runtime satisfying coord's engine floor (>=26.0.0)
# without mutating the caller's PATH, working directory, or NVM shell state.
set -eu

MIN_MAJOR=26
MIN_MINOR=0
MIN_PATCH=0

nl='
'

strip_leading_zeros() {
  val=$1
  while [ "${#val}" -gt 1 ] && [ "${val#0}" != "$val" ]; do
    val=${val#0}
  done
  printf '%s' "$val"
}

parse_node_version() {
  candidate_bin=$1
  raw_version=$("$candidate_bin" --version 2>/dev/null) || {
    raw_version=""
    return 1
  }
  case "$raw_version" in
    *"$nl"*)
      return 1
      ;;
    v*.*.*)
      ver_rest=${raw_version#v}
      ver_major=${ver_rest%%.*}
      ver_rem=${ver_rest#*.}
      ver_minor=${ver_rem%%.*}
      ver_patch=${ver_rem#*.}
      case "$ver_major.$ver_minor.$ver_patch" in
        "$ver_rest") ;;
        *) return 1 ;;
      esac
      if [ -z "$ver_major" ] || [ -z "$ver_minor" ] || [ -z "$ver_patch" ]; then
        return 1
      fi
      case "$ver_major$ver_minor$ver_patch" in
        *[!0-9]*) return 1 ;;
      esac
      ver_major=$(strip_leading_zeros "$ver_major")
      ver_minor=$(strip_leading_zeros "$ver_minor")
      ver_patch=$(strip_leading_zeros "$ver_patch")
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

version_ge() {
  if [ "$1" -gt "$4" ]; then return 0; fi
  if [ "$1" -lt "$4" ]; then return 1; fi
  if [ "$2" -gt "$5" ]; then return 0; fi
  if [ "$2" -lt "$5" ]; then return 1; fi
  [ "$3" -ge "$6" ]
}

version_gt() {
  if [ "$1" -gt "$4" ]; then return 0; fi
  if [ "$1" -lt "$4" ]; then return 1; fi
  if [ "$2" -gt "$5" ]; then return 0; fi
  if [ "$2" -lt "$5" ]; then return 1; fi
  [ "$3" -gt "$6" ]
}

selected_node=""
detected_incompatible=""

if [ -n "${COORD_NODE:-}" ]; then
  case "$COORD_NODE" in
    /*) ;;
    *)
      printf '%s\n' "coord node-runtime: COORD_NODE must be an absolute path to a node executable (got '$COORD_NODE'); Node >=26.0.0 is required." >&2
      exit 1
      ;;
  esac
  if [ "$(basename "$COORD_NODE")" != "node" ]; then
    printf '%s\n' "coord node-runtime: COORD_NODE must point to an executable named 'node' (got '$COORD_NODE'); Node >=26.0.0 is required." >&2
    exit 1
  fi
  if [ ! -f "$COORD_NODE" ] || [ ! -x "$COORD_NODE" ]; then
    printf '%s\n' "coord node-runtime: COORD_NODE '$COORD_NODE' does not exist or is not executable; Node >=26.0.0 is required." >&2
    exit 1
  fi
  if ! parse_node_version "$COORD_NODE"; then
    printf '%s\n' "coord node-runtime: COORD_NODE '$COORD_NODE' did not report a stable Node version (got '${raw_version:-unreadable}'); Node >=26.0.0 is required." >&2
    exit 1
  fi
  if ! version_ge "$ver_major" "$ver_minor" "$ver_patch" "$MIN_MAJOR" "$MIN_MINOR" "$MIN_PATCH"; then
    printf '%s\n' "coord node-runtime: COORD_NODE '$COORD_NODE' is $raw_version, but coord requires Node >=26.0.0." >&2
    exit 1
  fi
  selected_node="$COORD_NODE"
fi

if [ -z "$selected_node" ] && [ -n "${PATH:-}" ]; then
  remaining="${PATH}:"
  while [ -n "$remaining" ]; do
    entry=${remaining%%:*}
    remaining=${remaining#*:}
    if [ -z "$entry" ]; then
      entry="."
    fi
    case "$entry" in
      /*) abs_dir="$entry" ;;
      *) abs_dir=$(cd -- "$entry" 2>/dev/null && pwd) || abs_dir="" ;;
    esac
    if [ -n "$abs_dir" ]; then
      candidate="${abs_dir%/}/node"
      if [ -f "$candidate" ] && [ -x "$candidate" ]; then
        if parse_node_version "$candidate"; then
          if version_ge "$ver_major" "$ver_minor" "$ver_patch" "$MIN_MAJOR" "$MIN_MINOR" "$MIN_PATCH"; then
            selected_node="$candidate"
            break
          elif [ -z "$detected_incompatible" ]; then
            detected_incompatible="$raw_version at $candidate"
          fi
        elif [ -z "$detected_incompatible" ]; then
          detected_incompatible="invalid version '${raw_version:-probe failed}' at $candidate"
        fi
      fi
    fi
  done
fi

if [ -z "$selected_node" ]; then
  nvm_root="${NVM_DIR:-${HOME:-}/.nvm}"
  nvm_versions="$nvm_root/versions/node"
  if [ -n "$nvm_root" ] && [ -d "$nvm_versions" ]; then
    case "$nvm_versions" in
      /*) abs_nvm_versions="$nvm_versions" ;;
      *) abs_nvm_versions=$(cd -- "$nvm_versions" 2>/dev/null && pwd) || abs_nvm_versions="" ;;
    esac
    if [ -n "$abs_nvm_versions" ]; then
      best_major=0
      best_minor=0
      best_patch=0
      for candidate in "$abs_nvm_versions"/*/bin/node; do
        if [ -f "$candidate" ] && [ -x "$candidate" ]; then
          if parse_node_version "$candidate"; then
            if version_ge "$ver_major" "$ver_minor" "$ver_patch" "$MIN_MAJOR" "$MIN_MINOR" "$MIN_PATCH"; then
              if [ -z "$selected_node" ] || version_gt "$ver_major" "$ver_minor" "$ver_patch" "$best_major" "$best_minor" "$best_patch"; then
                selected_node="$candidate"
                best_major="$ver_major"
                best_minor="$ver_minor"
                best_patch="$ver_patch"
              fi
            elif [ -z "$detected_incompatible" ]; then
              detected_incompatible="$raw_version at $candidate"
            fi
          elif [ -z "$detected_incompatible" ]; then
            detected_incompatible="invalid version '${raw_version:-probe failed}' at $candidate"
          fi
        fi
      done
    fi
  fi
fi

if [ -z "$selected_node" ]; then
  if [ -n "$detected_incompatible" ]; then
    printf '%s\n' "coord node-runtime: coord requires Node >=26.0.0 (detected $detected_incompatible). Install Node 26 (for example via 'nvm install 26') or set COORD_NODE=/absolute/path/to/node." >&2
  else
    printf '%s\n' "coord node-runtime: coord requires Node >=26.0.0, but no compatible node executable was found on PATH or under ${NVM_DIR:-${HOME:-}/.nvm}/versions/node. Install Node 26 or set COORD_NODE=/absolute/path/to/node." >&2
  fi
  exit 1
fi

if [ "${1:-}" = "--print-path" ]; then
  printf '%s\n' "$selected_node"
  exit 0
fi

exec "$selected_node" "$@"
