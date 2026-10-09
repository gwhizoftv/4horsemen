#!/bin/sh
# Install or update a complete Four Horsemen checkout and optionally link
# ~/.local/bin/coord.
#
# Public install: curl -fsSL <public-raw-bootstrap-url> | sh
# Or inspect a Git clone first, then run:
#   sh /path/to/clone/scripts/bootstrap.sh --source /path/to/clone
# For private forks, authenticate Git and supply the local clone as --source.
set -eu

die() {
  printf '%s\n' "coord bootstrap: $*" >&2
  exit 1
}

default_root=${COORD_INSTALL_ROOT:-"$HOME/.local/share/coordination"}
root=$default_root
source_repo=${COORD_SOURCE:-https://github.com/gwhizoftv/4horsemen.git}
install_path=true

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root)
      [ "$#" -ge 2 ] || die "--root requires a path"
      root=$2
      shift 2
      ;;
    --source)
      [ "$#" -ge 2 ] || die "--source requires a Git URL or local repository"
      source_repo=$2
      shift 2
      ;;
    --no-path)
      install_path=false
      shift
      ;;
    -h|--help)
      cat <<'EOF'
Usage: bootstrap.sh [--root <path>] [--source <git-url-or-path>] [--no-path]

Defaults:
  --root   $COORD_INSTALL_ROOT or ~/.local/share/coordination
  --source $COORD_SOURCE or https://github.com/gwhizoftv/4horsemen.git
  PATH     install ~/.local/bin/coord unless --no-path is supplied

Public install: curl -fsSL <public-raw-bootstrap-url> | sh
Inspect-first alternative: clone with Git, then pass --source <local-path>.
For private forks, authenticate Git before cloning; bootstrap itself needs no gh.
Dependencies still require registry access unless already cached locally.
EOF
      exit 0
      ;;
    *) die "unknown option $1" ;;
  esac
done

command -v git >/dev/null 2>&1 || die "Git is required; install git and rerun this command"
if ! command -v node >/dev/null 2>&1 || ! command -v pnpm >/dev/null 2>&1; then
  die "Node 26 and pnpm 11 are required; install them, then rerun this command"
fi

case "$root" in
  /*) ;;
  *) root=$(pwd)/$root ;;
esac

created=false
if [ ! -e "$root" ]; then
  mkdir -p "$(dirname "$root")"
  git clone --branch main "$source_repo" "$root"
  created=true
else
  [ -d "$root" ] || die "install root exists but is not a directory: $root"
  top=$(git -C "$root" rev-parse --show-toplevel 2>/dev/null) ||
    die "install root is not a Git worktree: $root"
  physical_root=$(cd "$root" && pwd -P)
  [ "$top" = "$physical_root" ] || die "install root must be the worktree root: $root"
  [ "$(git -C "$root" status --porcelain)" = "" ] ||
    die "install root is dirty; commit, stash, or remove local changes before updating $root"
  branch=$(git -C "$root" branch --show-current)
  [ "$branch" = "main" ] || die "install root is on '$branch', not main; switch it deliberately before updating"
  git -C "$root" fetch origin main
  git -C "$root" merge --ff-only origin/main ||
    die "install root cannot fast-forward to origin/main; reconcile it without reset or force"
fi

git_dir=$(git -C "$root" rev-parse --absolute-git-dir)
metadata=$git_dir/coord-bootstrap.json
if [ "$created" = true ]; then
  cat >"$metadata" <<'EOF'
{
  "version": 1,
  "ownsInstallRoot": true
}
EOF
fi

printf '%s\n' "coord bootstrap: installing dependencies in $root"
(cd "$root" && pnpm install --frozen-lockfile)
(cd "$root" && pnpm build)
[ -f "$root/dist/main.js" ] || die "build completed without dist/main.js; inspect the pnpm output above"

if [ "$install_path" = true ]; then
  bin_dir=$HOME/.local/bin
  launcher=$bin_dir/coord
  mkdir -p "$bin_dir"
  if [ -e "$launcher" ] || [ -L "$launcher" ]; then
    if [ -L "$launcher" ] && [ "$(readlink "$launcher")" = "$root/coord" ]; then
      :
    else
      die "$launcher already exists and is not the managed link to $root/coord; move it aside or use --no-path"
    fi
  else
    ln -s "$root/coord" "$launcher"
  fi
  case :${PATH:-}: in
    *:"$bin_dir":*) ;;
    *) printf '%s\n' "coord bootstrap: add $bin_dir to PATH" >&2 ;;
  esac
  printf '%s\n' "coord bootstrap: installed $launcher"
fi

printf '%s\n' "coord bootstrap: ready; next run: coord onboard /path/to/product"
