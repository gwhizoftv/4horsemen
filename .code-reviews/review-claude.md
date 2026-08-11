**`githooks/lib/identity.sh:22`**
- **Rule:** Agent clones still fail closed on missing/malformed id when hooks are present by design of `.git/hooks` install.
- **Failure:** When `consensus.agentId` is missing, the modified `identity.sh` sets `CONSENSUS_AGENT_CLONE=false` and returns successfully. The hook bodies (e.g. `githooks/pre-commit:11`) then check `[[ "$CONSENSUS_AGENT_CLONE" == true ]] || exit 0`, which makes the hook silently pass through and exit 0. Because coordination hooks are only present via shims in agent clones, an agent clone missing its ID will now silently commit ungated instead of failing closed as required.
- **Fix sketch:**
  ```bash
  if [[ -z "$id" ]]; then
    # Since these canonical bodies are only executed via shims in .git/hooks, 
    # their execution implies this IS an agent clone. Missing ID must fail closed.
    consensus_identity_failed "this clone has no local $consensus_agent_id_key; agent identity is unresolved."
  fi
  ```
