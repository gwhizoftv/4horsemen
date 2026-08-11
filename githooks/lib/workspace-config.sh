#!/usr/bin/env bash
# githooks/lib/workspace-config.sh — read declared verify / critical paths.
#
# Policy lives in the coord-root workspace config (coord.workspaceConfig).
# Hooks must not sniff package.json / lockfiles / script names.
#
# Functions return non-zero on hard failures. Callers must check status
# (hooks use `set -e` / `|| exit 1`) — never rely on `exit` inside
# command substitutions, which only terminate the subshell.

coord_workspace_config_path() {
  git config --local --get coord.workspaceConfig 2>/dev/null || true
}

# Prints MISSING | EMPTY | JSON-array-of-command-objects for the named hook phase.
# phase: precommit | prepush
# Returns non-zero if the workspace config path is unset/unreadable.
coord_verify_phase() {
  local phase="$1"
  local path
  path="$(coord_workspace_config_path)"
  if [[ -z "$path" || ! -f "$path" ]]; then
    echo "HOOK BLOCKED: coord.workspaceConfig is unset or missing (${path:-<unset>})." >&2
    echo "  Fix: re-run coord install for this product." >&2
    return 1
  fi
  if ! command -v node >/dev/null; then
    echo "HOOK BLOCKED: node is required to read the workspace verify config." >&2
    return 1
  fi
  node --input-type=module -e '
import { readFileSync } from "node:fs";
const phase = process.argv[1];
const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (!Object.prototype.hasOwnProperty.call(config, "verify")) {
  process.stdout.write("MISSING");
  process.exit(0);
}
const verify = config.verify ?? {};
const list = Array.isArray(verify[phase]) ? verify[phase] : [];
if (list.length === 0) {
  process.stdout.write("EMPTY");
  process.exit(0);
}
process.stdout.write(JSON.stringify(list));
' "$phase" "$path"
}

coord_run_verify_phase() {
  local phase="$1"
  local label="$2"
  local payload command_json name
  if ! payload="$(coord_verify_phase "$phase")"; then
    return 1
  fi
  if [[ "$payload" == "MISSING" ]]; then
    echo "HOOK BLOCKED ($label): workspace config has no verify declaration." >&2
    echo "  Add verify.precommit / verify.prepush argv arrays, or set an explicit empty verify object." >&2
    echo "  Human product clones without coordination hooks are unaffected." >&2
    return 1
  fi
  if [[ "$payload" == "EMPTY" ]]; then
    echo "$label hook: verify.$phase is explicitly empty; skipping project checks."
    return 0
  fi
  while IFS= read -r command_json; do
    [[ -n "$command_json" ]] || continue
    name="$(node --input-type=module -e 'const c=JSON.parse(process.argv[1]); process.stdout.write(c.name ?? c.argv[0]);' "$command_json")"
    echo "$label hook: running verify.$phase '$name'..."
    if ! node --input-type=module -e '
import { spawnSync } from "node:child_process";
const command = JSON.parse(process.argv[1]);
const argv = command.argv;
if (!Array.isArray(argv) || argv.length === 0) process.exit(1);
const result = spawnSync(argv[0], argv.slice(1), { stdio: "inherit" });
process.exit(result.status ?? 1);
' "$command_json"; then
      echo "HOOK BLOCKED: verify.$phase '$name' failed — fix before continuing." >&2
      return 1
    fi
  done < <(node --input-type=module -e '
const list = JSON.parse(process.argv[1]);
for (const item of list) process.stdout.write(`${JSON.stringify(item)}\n`);
' "$payload")
  return 0
}

# Loads workflowCriticalPrefixes / workflowCriticalFiles into namerefs.
coord_load_workflow_critical() {
  local -n prefixes_ref="$1"
  local -n files_ref="$2"
  local path
  path="$(coord_workspace_config_path)"
  if [[ -z "$path" || ! -f "$path" ]]; then
    echo "HOOK BLOCKED: coord.workspaceConfig is unset or missing (${path:-<unset>})." >&2
    return 1
  fi
  local raw
  raw="$(node --input-type=module -e '
import { readFileSync } from "node:fs";
const config = JSON.parse(readFileSync(process.argv[1], "utf8"));
const prefixes = Array.isArray(config.workflowCriticalPrefixes) ? config.workflowCriticalPrefixes : [];
const files = Array.isArray(config.workflowCriticalFiles) ? config.workflowCriticalFiles : [];
process.stdout.write(JSON.stringify({ prefixes, files }));
' "$path")"
  prefixes_ref=()
  files_ref=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && prefixes_ref+=("$line")
  done < <(node --input-type=module -e '
const data = JSON.parse(process.argv[1]);
for (const value of data.prefixes) process.stdout.write(`${value}\n`);
' "$raw")
  while IFS= read -r line; do
    [[ -n "$line" ]] && files_ref+=("$line")
  done < <(node --input-type=module -e '
const data = JSON.parse(process.argv[1]);
for (const value of data.files) process.stdout.write(`${value}\n`);
' "$raw")
  return 0
}
