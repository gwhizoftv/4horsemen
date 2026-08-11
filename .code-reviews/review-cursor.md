**`githooks/pre-push:21`**
- **Rule:** On an agent-wired clone, a missing or unreadable `coord.workspaceConfig` must fail closed for `pre-push` (non-zero exit with remediation).
- **Failure:** The `coord_load_workflow_critical` function returns 1 when the config is unset, but `pre-push` deliberately omits `set -e` and does not check the return value of this call. The hook continues with empty critical-path lists, eventually deciding that `verify.prepush` can be skipped, prints that the checks passed, and exits 0. An agent can thus successfully push even after `coord.workspaceConfig` is deleted or never set.
- **Fix sketch:**
  ```bash
  coord_load_workflow_critical workflow_critical_prefixes workflow_critical_files || exit 1
  ```
