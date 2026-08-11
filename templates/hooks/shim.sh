#!/usr/bin/env bash
# Fail-closed shim delegating to the coordination runtime.
install_root="$(git config --get coord.installRoot 2>/dev/null || true)"
if [[ -z "$install_root" ]]; then
  echo "HOOK BLOCKED: coord.installRoot is not set in this clone's git config." >&2
  echo "  Fix: coord doctor, or coord install from the product root." >&2
  exit 1
fi
if [[ ! -x "$install_root/githooks/$(basename "$0")" ]]; then
  echo "HOOK BLOCKED: cannot execute $install_root/githooks/$(basename "$0")" >&2
  exit 1
fi
exec "$install_root/githooks/$(basename "$0")" "$@"
