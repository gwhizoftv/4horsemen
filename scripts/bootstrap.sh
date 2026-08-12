#!/bin/sh
# bootstrap.sh — install the coordination control plane on this machine.
#
# Documented invocation is `curl -fsSL … | sh`, so this is POSIX sh: no
# bashisms, no $BASH_SOURCE, and no assumption that the script sits in a
# checkout. It installs a COMPLETE git checkout, because the agent hook shims
# exec canonical hook bodies out of it — a PATH-only binary would leave every
# agent commit unable to resolve its own hooks.
#
# It never touches a product repository and never onboards anything.
set -eu

DEFAULT_SOURCE="https://github.com/gwhizoftv/coordination.git"
DEFAULT_ROOT="${HOME}/.local/share/coordination"
BIN_DIR="${HOME}/.local/bin"

root="${COORD_INSTALL_ROOT:-$DEFAULT_ROOT}"
source_url="${COORD_INSTALL_SOURCE:-$DEFAULT_SOURCE}"
ref="main"
install_path=1
build=1

usage() {
  cat <<'USAGE'
bootstrap.sh — install coordination

  --root <dir>       install root (default ~/.local/share/coordination,
                     or $COORD_INSTALL_ROOT); --root wins over the environment
  --source <url|dir> repository to clone (default the public repository,
                     or $COORD_INSTALL_SOURCE)
  --ref <branch>     branch to track (default main)
  --no-path          do not install ~/.local/bin/coord
  --no-build         skip pnpm install/build (the CLI will not be runnable)
  --help             this text

Re-running is safe: a clean checkout is fast-forwarded, a dirty one is refused
without being rewritten.
USAGE
}

die() {
  printf 'bootstrap: %s\n' "$1" >&2
  exit "${2:-1}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --root) [ $# -ge 2 ] || die "--root requires a value." 2; root="$2"; shift 2 ;;
    --source) [ $# -ge 2 ] || die "--source requires a value." 2; source_url="$2"; shift 2 ;;
    --ref) [ $# -ge 2 ] || die "--ref requires a value." 2; ref="$2"; shift 2 ;;
    --no-path) install_path=0; shift ;;
    --no-build) build=0; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option '$1'. Try --help." 2 ;;
  esac
done

case "$root" in
  /*) ;;
  *) root="$(pwd)/$root" ;;
esac

# ---- preflight: one concise hint per missing tool, before any effect -------
command -v git >/dev/null 2>&1 || die "git is required but not on PATH. Install git, then re-run." 3
if [ "$build" -eq 1 ]; then
  command -v node >/dev/null 2>&1 ||
    die "node is required but not on PATH. Install Node 26 (https://nodejs.org, or 'nvm install 26'), then re-run." 3
  command -v pnpm >/dev/null 2>&1 ||
    die "pnpm is required but not on PATH. Install it with 'corepack enable pnpm', then re-run." 3
fi

# ---- clone, or update in place without ever rewriting local work ----------
if [ ! -e "$root" ]; then
  printf 'bootstrap: cloning %s into %s\n' "$source_url" "$root"
  mkdir -p "$(dirname "$root")"
  git clone --quiet --branch "$ref" "$source_url" "$root" ||
    die "could not clone $source_url at branch $ref into $root." 4
  # Ownership is recorded inside .git/ so `git status` stays clean. It says only
  # that bootstrap created this checkout; it deliberately does NOT authorize
  # `uninstall --delete-coordination`, because one install root serves every
  # onboarded product.
  printf '%s\n' "created-by-bootstrap $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$root/.git/coord-bootstrap"
else
  [ -d "$root" ] || die "$root exists but is not a directory." 4
  git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
    die "$root exists but is not a git worktree. Move it aside, or choose another --root." 4
  if [ -n "$(git -C "$root" status --porcelain 2>/dev/null)" ]; then
    printf 'bootstrap: %s has uncommitted changes; refusing to update it.\n' "$root" >&2
    git -C "$root" status --short >&2
    die "commit, stash, or discard them yourself, then re-run. Nothing has been changed." 4
  fi
  git -C "$root" fetch --quiet origin "$ref" || die "could not fetch $ref from origin in $root." 4
  if ! git -C "$root" merge --ff-only --quiet FETCH_HEAD 2>/dev/null; then
    die "$root has diverged from origin/$ref. Integrate it yourself; bootstrap never resets a checkout." 4
  fi
  printf 'bootstrap: %s is up to date at %s\n' "$root" "$(git -C "$root" rev-parse --short HEAD)"
fi

# ---- build ----------------------------------------------------------------
if [ "$build" -eq 1 ]; then
  printf 'bootstrap: building in %s\n' "$root"
  ( cd "$root" && pnpm install --frozen-lockfile && pnpm build ) ||
    die "the build failed in $root. Fix the error above and re-run." 5
fi

# ---- PATH entry -----------------------------------------------------------
if [ "$install_path" -eq 1 ]; then
  launcher="$BIN_DIR/coord"
  if [ -e "$launcher" ] && [ ! -L "$launcher" ] && ! grep -q 'coord bootstrap-managed' "$launcher" 2>/dev/null; then
    die "$launcher already exists and was not installed by bootstrap. Remove it, or re-run with --no-path." 6
  fi
  mkdir -p "$BIN_DIR"
  # A wrapper rather than a symlink to the repository's own ./coord: that one
  # rebuilds stale sources, which is right for a developer checkout and wrong
  # for an installed root, where pnpm must not be a runtime dependency.
  cat > "$launcher" <<EOF
#!/bin/sh
# coord bootstrap-managed — generated by scripts/bootstrap.sh; edits are overwritten.
set -eu
COORD_ROOT="$root"
if [ ! -f "\$COORD_ROOT/dist/main.js" ]; then
  printf 'coord: %s is not built. Re-run scripts/bootstrap.sh.\n' "\$COORD_ROOT" >&2
  exit 1
fi
exec node "\$COORD_ROOT/dist/main.js" "\$@"
EOF
  chmod 755 "$launcher"
  printf 'bootstrap: installed %s\n' "$launcher"
  case ":${PATH}:" in
    *":$BIN_DIR:"*) ;;
    *) printf 'bootstrap: %s is not on PATH. Add it:\n  export PATH="%s:$PATH"\n' "$BIN_DIR" "$BIN_DIR" ;;
  esac
fi

printf '\nbootstrap: coordination is installed at %s\n\nNext:\n  coord onboard /path/to/app\n' "$root"
