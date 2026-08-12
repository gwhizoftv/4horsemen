#!/bin/sh
# Install or update a complete coordination checkout and optionally link ~/.local/bin/coord.
# POSIX sh — intended for: curl -fsSL …/scripts/bootstrap.sh | sh
set -eu

REPO_URL="${COORD_REPO_URL:-https://github.com/gwhizoftv/coordination.git}"
INSTALL_ROOT="${COORD_INSTALL_ROOT:-${HOME}/.local/share/coordination}"
LINK_PATH="${HOME}/.local/bin/coord"
NO_PATH=0
EXPLICIT_ROOT=0

usage() {
  cat <<'EOF'
Usage: bootstrap.sh [--root <dir>] [--no-path]

  --root <dir>   Install checkout (overrides COORD_INSTALL_ROOT)
  --no-path      Do not create or update ~/.local/bin/coord

Environment:
  COORD_INSTALL_ROOT   Default install directory
  COORD_REPO_URL       Override clone URL (forks / hermetic tests)
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root)
      [ "$#" -ge 2 ] || { echo "bootstrap: --root requires a directory" >&2; exit 2; }
      INSTALL_ROOT=$2
      EXPLICIT_ROOT=1
      shift 2
      ;;
    --no-path)
      NO_PATH=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "bootstrap: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# --root wins over a previously expanded COORD_INSTALL_ROOT when both appear in
# the environment and argv; argv was applied above. Re-read env only when argv
# did not set an explicit root.
if [ "$EXPLICIT_ROOT" -eq 0 ] && [ -n "${COORD_INSTALL_ROOT:-}" ]; then
  INSTALL_ROOT=$COORD_INSTALL_ROOT
fi

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "bootstrap: missing '$1'. Install Node 26+ and pnpm 11+, then re-run." >&2
    exit 1
  fi
}

need_cmd git
need_cmd node
need_cmd pnpm

CREATED=0
if [ ! -e "$INSTALL_ROOT" ]; then
  mkdir -p "$(dirname "$INSTALL_ROOT")"
  echo "bootstrap: cloning $REPO_URL into $INSTALL_ROOT"
  git clone --branch main --single-branch "$REPO_URL" "$INSTALL_ROOT"
  CREATED=1
elif [ ! -d "$INSTALL_ROOT" ]; then
  echo "bootstrap: refusing $INSTALL_ROOT: not a directory" >&2
  exit 1
else
  if ! git -C "$INSTALL_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "bootstrap: refusing $INSTALL_ROOT: not a git worktree" >&2
    exit 1
  fi
  if [ -n "$(git -C "$INSTALL_ROOT" status --porcelain)" ]; then
    echo "bootstrap: refusing to update dirty checkout at $INSTALL_ROOT" >&2
    echo "bootstrap: commit or stash local changes, then re-run." >&2
    exit 1
  fi
  echo "bootstrap: fetching origin in $INSTALL_ROOT"
  git -C "$INSTALL_ROOT" fetch --quiet origin
  if ! git -C "$INSTALL_ROOT" merge --ff-only --quiet origin/main; then
    echo "bootstrap: cannot fast-forward to origin/main at $INSTALL_ROOT" >&2
    exit 1
  fi
fi

if [ "$CREATED" -eq 1 ]; then
  # Ownership metadata stays under .git/ so `git status` remains clean.
  printf 'version=1\ncreated_by=bootstrap.sh\n' >"$INSTALL_ROOT/.git/coord-bootstrap-owner"
fi

echo "bootstrap: pnpm install --frozen-lockfile"
pnpm -C "$INSTALL_ROOT" install --frozen-lockfile
echo "bootstrap: pnpm build"
pnpm -C "$INSTALL_ROOT" build

WRAPPER="$INSTALL_ROOT/coord"
if [ ! -x "$WRAPPER" ]; then
  echo "bootstrap: expected executable launcher at $WRAPPER" >&2
  exit 1
fi

if [ "$NO_PATH" -eq 0 ]; then
  mkdir -p "$(dirname "$LINK_PATH")"
  if [ -e "$LINK_PATH" ] || [ -L "$LINK_PATH" ]; then
    if [ -L "$LINK_PATH" ]; then
      target=$(readlink "$LINK_PATH")
      case "$target" in
        */coord)
          ;;
        *)
          # Only replace a symlink that already points at a coord wrapper.
          if [ "$target" != "$WRAPPER" ] && [ "$(basename "$target")" != "coord" ]; then
            echo "bootstrap: refusing to overwrite unrelated file at $LINK_PATH" >&2
            exit 1
          fi
          ;;
      esac
    else
      echo "bootstrap: refusing to overwrite unrelated file at $LINK_PATH" >&2
      exit 1
    fi
  fi
  ln -sfn "$WRAPPER" "$LINK_PATH"
  echo "bootstrap: linked $LINK_PATH -> $WRAPPER"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *)
      echo "bootstrap: add \$HOME/.local/bin to PATH if 'coord' is not found"
      ;;
  esac
else
  echo "bootstrap: skipped PATH link (--no-path); run $WRAPPER directly"
fi

echo "bootstrap: ready. Next: coord onboard /path/to/app"
