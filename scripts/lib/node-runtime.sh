#!/bin/sh
# Select Node for coordination only; never change PATH for product subprocesses.
# Keep this floor aligned with package.json engines.node (covered by wrapper tests).
set -eu
coord_min_major=26

coord_node_error() {
  printf '%s\n' "coord: $*" >&2
  printf '%s\n' "Install Node >= $coord_min_major or set COORD_NODE to an absolute path to a compatible bin/node; the product's Node selection can stay unchanged." >&2
  exit 1
}

coord_probe_node() {
  coord_probe_version=unavailable
  [ -x "$1" ] && [ ! -d "$1" ] || return 1
  coord_probe_version=$("$1" --version 2>/dev/null) || return 1
  case "$coord_probe_version" in v*) ;; *) return 1 ;; esac
  coord_numbers=${coord_probe_version#v}
  case "$coord_numbers" in *[!0-9.]*|*.*.*.*) return 1 ;; esac
  case "$coord_numbers" in *.*.*) ;; *) return 1 ;; esac
  coord_major=${coord_numbers%%.*}
  coord_tail=${coord_numbers#*.}
  coord_minor=${coord_tail%%.*}
  coord_patch=${coord_tail#*.}
  for coord_part in "$coord_major" "$coord_minor" "$coord_patch"; do
    case "$coord_part" in ''|0?*) return 1 ;; esac
    [ "${#coord_part}" -le 9 ] || return 1
  done
  [ "$coord_major" -ge "$coord_min_major" ]
}

coord_selected=
coord_found=none
if [ "${COORD_NODE+x}" = x ]; then
  case "$COORD_NODE" in /*/node) ;; *) coord_node_error "COORD_NODE must name an absolute executable bin/node: $COORD_NODE" ;; esac
  if ! coord_probe_node "$COORD_NODE"; then
    coord_node_error "COORD_NODE is not a supported Node >= $coord_min_major: $COORD_NODE ($coord_probe_version)"
  fi
  coord_selected=$COORD_NODE
else
  # Split PATH without word splitting or glob expansion; empty entries mean cwd.
  coord_remaining=${PATH-}
  while :; do
    case "$coord_remaining" in
      *:*) coord_dir=${coord_remaining%%:*}; coord_remaining=${coord_remaining#*:}; coord_more=yes ;;
      *) coord_dir=$coord_remaining; coord_more=no ;;
    esac
    coord_candidate=${coord_dir:-.}/node
    if coord_probe_node "$coord_candidate"; then
      coord_selected=$coord_candidate
      break
    fi
    if [ "$coord_found" = none ] && [ -x "$coord_candidate" ]; then
      coord_found="$coord_candidate ($coord_probe_version)"
    fi
    [ "$coord_more" = yes ] || break
  done

  if [ -z "$coord_selected" ]; then
    coord_nvm_root=${NVM_DIR:-${HOME:-}/.nvm}
    coord_best_major=0 coord_best_minor=0 coord_best_patch=0
    for coord_candidate in "$coord_nvm_root"/versions/node/v*/bin/node; do
      if coord_probe_node "$coord_candidate" && {
        [ "$coord_major" -gt "$coord_best_major" ] ||
        { [ "$coord_major" -eq "$coord_best_major" ] && [ "$coord_minor" -gt "$coord_best_minor" ]; } ||
        { [ "$coord_major" -eq "$coord_best_major" ] && [ "$coord_minor" -eq "$coord_best_minor" ] && [ "$coord_patch" -gt "$coord_best_patch" ]; }
      }; then
        coord_selected=$coord_candidate
        coord_best_major=$coord_major coord_best_minor=$coord_minor coord_best_patch=$coord_patch
      fi
    done
  fi
fi

[ -n "$coord_selected" ] || coord_node_error "Node >= $coord_min_major is required; PATH node: $coord_found; no compatible installed Node found."
# Resolution must not change cwd: relative product arguments belong to the caller.
case "$coord_selected" in /*) ;; *) coord_selected=$PWD/$coord_selected ;; esac
coord_node_dir=$(CDPATH= cd -P "$(dirname "$coord_selected")" && pwd)
coord_selected=$coord_node_dir/node
if [ "${1:-}" = --resolve ]; then
  [ "$#" -eq 1 ] || coord_node_error '--resolve takes no arguments'
  printf '%s\n' "$coord_selected"
  exit 0
fi
exec "$coord_selected" "$@"
