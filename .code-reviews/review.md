**`githooks/pre-commit:64`**
- **Rule:** Missing `verify` on an agent-wired clone blocks with fix text.
- **Failure:** If an agent clone has `coord.installRoot` set but the `workspace.json` file is deleted or missing from the coordination root, the condition `if [[ -n "$install_root" && -f "$install_root/workspace.json" ]];` evaluates to false. The script silently falls through to `exit 0` and allows the commit, completely bypassing the required blocks.
- **Fix sketch:**
  ```bash
  install_root="$(git config --get coord.installRoot 2>/dev/null || true)"
  if [[ -n "$install_root" ]]; then
    if [[ ! -f "$install_root/workspace.json" ]]; then
      echo "HOOK BLOCKED: workspace.json is missing at $install_root." >&2
      exit 1
    fi
    # ... python verification parsing ...
  fi
  ```

**`githooks/pre-push:148`**
- **Rule:** No hook body branches on `package.json`/lockfiles/script-name greps. Finalization `checks` must come from the product-declared argv (via workspace config).
- **Failure:** The `pre-push` hook was not updated during the hooks rewrite. It continues to sniff for `pnpm-lock.yaml` and hardcoded scripts like `"test:e2e"`, meaning an agent push will run legacy hardcoded commands rather than the tier-3 checks defined by the product.

**`src/install.ts:47`**
- **Rule:** `coord install` must write a functional `start-<agent>.sh` launcher (incorporating `coord start` / `coord run` / `coord next` commands) that enables the agent to run.
- **Failure:** The install command writes an empty bash stub (`#!/bin/bash\n# Launcher for ${agent}\n`) instead of an actual startup command for the agent. When the operator runs `./start-claude.sh` using the instructions provided, nothing happens and the agent never starts.
