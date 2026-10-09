## Comparison

This review compares the four bound implementation pins for issue 172:
- **cursor**: `abb2cf2b4afdcf38c67bec77a556385c282410e3` (`.signals/issue-172/implementation-ready-cursor.json`)
- **claude**: `38d0460c436ade9a8fb7bdba6070ae923e2d1d80` (`.signals/issue-172/implementation-ready-claude.json`)
- **codex**: `e62ba296c26b0602dbefb300604e83a057e200d6` (`.signals/issue-172/implementation-ready-codex.json`)
- **antigravity**: `7427ebfca2a4969916aabf54d698146a49d4b2c9` (`.signals/issue-172/implementation-ready-antigravity.json`)

All four agents implemented the architecture approved from Claude's plan (`3e67191cefbc89b732f7cf8c412b3b30e214bc5e`), keeping changes strictly within the approved path list. However, significant differences in correctness, topology handling, and lifecycle failure ordering distinguish the candidates.

---

### Implementation Review Findings

#### 1. Cursor (`abb2cf2b4afdcf38c67bec77a556385c282410e3`): Git shim incorrectly disarms in nested workspace layouts
- **File path and line number**: `scripts/lib/launcher.sh:202-217`
- **Rule**: In nested workspace configurations (`<coordRoot>/workspaces/<project>`), issue state resides at `<coordRoot>/issue-<N>`, not inside the project subfolder. The git shim must resolve the true coordinator root when checking whether an automated issue runtime exists before delegating commands.
- **Concrete failure**: `coord_runtime_root()` sets `dir="$(dirname "$config")"` and returns it directly without checking whether `basename "$parent" == "workspaces"`. In a nested layout, `root` is assigned `<coordRoot>/workspaces/<project>`, so `issue_dir="$root/issue-$COORD_ISSUE"` looks for `<coordRoot>/workspaces/<project>/issue-$COORD_ISSUE`. Because that path never exists, `[[ ! -d "$issue_dir" ]]` evaluates to true on line 215, causing the shim to execute `delegate "$@"` and completely disarm automated git protections during active issues in nested workspaces.
- **Illustrative test**:
  ```bash
  # Inside a nested workspace with active issue 1 located at /root/coord/issue-1:
  export COORD_ISSUE=1
  # Execute git status inside agent clone:
  git status --porcelain
  # Expected: Exit code 2 (coord refuse: git status is blocked during automated issue 1)
  # Actual: Exit code 0 (delegated because /root/coord/workspaces/proj/issue-1 was absent)
  ```

#### 2. Cursor (`abb2cf2b4afdcf38c67bec77a556385c282410e3`): Detached HEAD at base target rejected during manual detach
- **File path and line number**: `src/prepareAgentBranch.ts:708-713`
- **Rule**: Manual mode clone readiness must permit returning to base when HEAD is in detached state, provided the commit is identical to or already contained in the target base commit.
- **Concrete failure**: Cursor unconditionally rejects detached HEAD:
  ```ts
  if (headSha === "" || snapshot.head === "HEAD") {
    const reason = `HEAD is detached in ${snapshot.clone}; check out a branch and publish it before detach.`;
    return { snapshot, kind: "refuse", reason };
  }
  ```
  If a clone was placed in detached HEAD at the exact base target commit (e.g. by inspection or external tooling), `coord detach manual` refuses to restore or clean the clone batch, blocking manual mode exit.
- **Illustrative test**:
  ```ts
  // Clone on detached HEAD at origin/main:
  git(clone, "checkout", "--detach", "origin/main");
  const results = makeManualClonesBaseReady({ agents, baseBranch: "main" });
  expect(results[0].action).toBe("already-base"); // Actual: action is "refused"
  ```

#### 3. Codex (`e62ba296c26b0602dbefb300604e83a057e200d6`): Git shim misclassifies nested runtime and breaks completed/abandoned staleness detection
- **File path and line number**: `scripts/lib/launcher.sh:197-224`
- **Rule**: Positive evidence of a completed or abandoned issue must disarm the git shim in both flat and nested workspace layouts.
- **Concrete failure**: Codex assumes nested workspaces store issue state beside their config (`$dir/issue-$COORD_ISSUE`) and treats the true coordinator root as legacy. On line 208, `coord_runtime_root()` returns 1 when called without arguments if the outer issue exists: `[[ "${1:-}" == bound-files ]] || return 1`. Consequently, when the shim checks for staleness, `coord_root="$(coord_runtime_root)"` evaluates to empty string, completely skipping lines 216–222. Even if `cursors.json` in the outer directory specifies `"completed": true`, the shim fails to delegate and continues to block git commands.
- **Illustrative test**:
  ```bash
  # Nested workspace with completed issue at /root/coord/issue-1/cursors.json ("completed": true):
  export COORD_ISSUE=1
  git status --porcelain
  # Expected: Exit code 0 (delegated due to completed cursors state)
  # Actual: Exit code 2 (refused because coord_runtime_root returned 1)
  ```

#### 4. Codex (`e62ba296c26b0602dbefb300604e83a057e200d6`): Inversion of control and async callback coupling in clone readiness
- **File path and line number**: `src/prepareAgentBranch.ts:638-645` and `src/cli.ts:721-728`
- **Rule**: Worktree branch readiness inspection (`makeManualClonesBaseReady`) should remain a pure synchronous domain operation separate from UI/process orchestration.
- **Concrete failure**: Codex turns `makeManualClonesBaseReady` into an `async` function accepting an optional `beforeCheckout?: () => Promise<void>` callback, inside which `detachIssue` (tmux and terminal teardown) is executed midway between readiness checking and branch checkout. This inverts the architectural boundary between `cli.ts` (orchestrating user interaction and process teardown) and `prepareAgentBranch.ts` (managing git refs and working trees).

#### 5. Antigravity (`7427ebfca2a4969916aabf54d698146a49d4b2c9`): Session teardown occurs before clone readiness check in direct detach
- **File path and line number**: `src/cli.ts:724-754`
- **Rule**: Manual mode termination (`detachManual`) must preflight clone readiness across all agents before terminating tmux sessions or closing terminal windows, ensuring that agent terminals remain available if dirty or unpushed work prevents switching to base.
- **Concrete failure**: When invoked via `coord detach manual`, Antigravity calls `detachIssue` on line 724 before calling `makeManualClonesBaseReady` on line 748. If an agent has uncommitted changes or unpushed work, the tmux session and terminals have already been killed, leaving the owner without active terminal sessions to inspect and resolve the dirty working tree.
- **Illustrative test**:
  ```ts
  // Manual session with dirty file in agent clone:
  writeFileSync(join(agentRoot, "scratch.txt"), "uncommitted");
  await runCli(["detach", "manual"]);
  // Expected: Tmux session left intact; returns exit code 1 with error report.
  // Actual: Tmux session killed before readiness check reported refusal.
  ```

---

### Comparative Evaluation

| Evaluation Criteria | cursor (`abb2cf2b`) | claude (`38d0460c`) | codex (`e62ba296`) | antigravity (`7427ebfc`) |
| :--- | :---: | :---: | :---: | :---: |
| **Approved Scope Adherence** | 15 files (exact) | 15 files (exact) | 15 files (exact) | 15 files (exact) |
| **Nested Workspace Topology** | ❌ Broken (fails open) | ✅ Correct | ❌ Broken (fails closed) | ✅ Correct |
| **Detached Base Handling** | ❌ Unconditionally refused | ✅ Allowed if at base | ✅ Allowed if at base | ✅ Allowed if at base |
| **Manual Teardown Preflight** | ✅ Preflight first | ✅ Preflight first | ⚠️ Inverted via callback | ⚠️ Direct detach teardown first |
| **Git Shim Side-Effect Safety** | ⚠️ Spawns real git | ⚠️ Spawns real git | ⚠️ Spawns real git | ✅ Safe regex/sed on config |
| **Interactive "All" Reminders** | ✅ Supported | ✅ Supported | ✅ Supported | ✅ Supported |
| **Diagnostic & Report Formatting** | ✅ Compliant | ✅ Compliant | ✅ Compliant | ✅ Compliant |

#### Architectural Summary:
- **claude (`38d0460c436ade9a8fb7bdba6070ae923e2d1d80`)**: Produced the cleanest and most robust overall design. Its `detachManual` enforces a strict preflight phase before terminal teardown, its `makeManualClonesBaseReady` evaluates all clones in a single transactional pass refusing the whole batch if any clone is dirty or divergent, and its nested workspace detection accurately handles both layouts.
- **antigravity (`7427ebfca2a4969916aabf54d698146a49d4b2c9`)**: Excelled in eliminating external subprocess dependencies within the launcher shim (reading `.git/config` directly to prevent shim test interference) and robust JSON parsing for `cursors.json`. However, its direct `detachManual` routine teardown ordering should adopt Claude's preflight-first pattern.
- **codex (`e62ba296c26b0602dbefb300604e83a057e200d6`)**: Introduced unnecessary architectural coupling with `beforeCheckout` callbacks and flawed nested workspace assumptions in `launcher.sh`.
- **cursor (`abb2cf2b4afdcf38c67bec77a556385c282410e3`)**: Has a critical security gap in nested workspaces where git protections fail open and run `delegate "$@"` during active issues, along with rigid rejection of detached HEAD at base.

### Verdict
**claude (`38d0460c436ade9a8fb7bdba6070ae923e2d1d80`)** is the superior implementation, demonstrating complete topology awareness, safe transactional preflight verification, and clean architectural separation.
