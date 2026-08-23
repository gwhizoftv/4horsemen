# Issue 96 implementation comparison

Compared the three bound implementation pins against baseline `509748020eeec09acbbb5fb333efdf6db4b945de` (`origin/main`).

- **codex** `4869a4b7c4a4f639c1e2915e5600198a749e438c` — `.signals/issue-96/implementation-ready-codex.json`
- **cursor** `6121c0c17f4ebc60efc424f23f3526491079ca1c` — `.signals/issue-96/implementation-ready-cursor.json`
- **claude** `e61aad3d4af48938c05092532a25c9d453c54786` — `.signals/issue-96/implementation-ready-claude.json`

All three satisfy the core issue: branch preparation unconditionally re-sets `skip-worktree`, wraps checkout in `try/finally`, narrows the dirty gate so overlay-only `AGENTS.md` dirt can heal, appends a branch-prepared note to every rendered action, bumps `package.json` to `0.0.17`, and adds a doctor finding when tracked `AGENTS.md` lacks the bit.

## Comparison

### Shared core (all three pins)

Each implementation rewrites `src/prepareAgentBranch.ts` around the same shape:

1. **Mandatory restore** — `restoreProtocol` no longer returns silently when no install root resolves; it at minimum calls `ensureAgentsMdSkipWorktree`.
2. **Failure-safe checkout** — lift/checkout runs inside `try/finally` so a failed `git checkout` cannot leave the bit cleared.
3. **Overlay-only dirty healing** — porcelain filtering ignores an `AGENTS.md` entry whose worktree content differs from `HEAD` only by the managed protocol block.
4. **Post-condition assertion** — throws before agents start if the clone is not on the issue branch or (when tracked) skip-worktree is unset.
5. **Per-action guidance** — `BRANCH_PREPARED_NOTE` is appended in `buildOrder` so every step, not just R1.join, tells agents not to create the branch or clear the bit.
6. **Doctor diagnostics** — new `agentsProtocol` class (code 21) reports tracked `AGENTS.md` without skip-worktree.
7. **Version ship gate** — `package.json` moves `0.0.16` → `0.0.17`; `test:fast` rewrites version expectations in `test/cli.test.ts` and `test/install.test.ts` at run time.

Product-code overlap among the three pins is high: the same ten paths under `src/`, `templates/product/AGENTS.protocol.md`, `package.json`, and the three test files differ mainly in helper factoring and edge-case completeness.

### Claude — strongest vendored-workspace and resume behavior

Claude's pin is the largest and most complete relative to the selected plan (`3b9a0c2df8c47e2ae5f0a7230e38423aea58b37a`).

**Distinct strengths**

- **`captureCloneAgentsProtocol` / `restoreCapturedAgentsProtocol`** (`src/agentsProtocol.ts`) — when no install root can be resolved (vendored clones), restore re-applies the overlay bytes captured before the lift instead of falling back to bit-only. This directly fixes failure mode F1 from the selected plan.
- **`agentsMdDiffersOnlyByProtocol`** — centralizes the dirty-gate predicate in `agentsProtocol.ts` rather than duplicating strip/compare logic in branch preparation.
- **Resume install-root policy** (`src/runLoop.ts:464-467`) — deliberately does *not* synthesize a coordinator checkout root on resume, with an inline rationale: defaulting the root can render a protocol overlay into clones that were never installed against it and produce untracked `AGENTS.md` that `git add -A` sweeps into implementation evidence.
- **Agent-facing templates** — updates both `templates/product/AGENTS.md` (branch scheme) and `templates/product/AGENTS.protocol.md` (pre-checkout guidance).
- **Test breadth** — eight `prepareAgentBranch` cases, including overlay restore without install root, bit-only when nothing to capture, and mixed dirty paths beside overlay dirt.

**Gap**

- No explicit `runLoop` test asserting `BRANCH_PREPARED_NOTE` appears in rendered orders (codex and cursor both add this).

### Cursor — close second; resume fallback is the main divergence

Cursor's pin matches Claude on most coordinator guarantees and adds template updates to both `AGENTS.md` files.

**Distinct strengths**

- **`hasBlockingUncommittedChanges` exported** — reusable dirty-gate helper with porcelain-path parsing that handles rename arrows and skips empty lines.
- **`restoreProtocol` tracked guard** (`src/prepareAgentBranch.ts:47`) — calls `writeCloneAgentsProtocol` only when `AGENTS.md` is tracked, reducing the risk of creating a fresh untracked protocol file during resume.
- **`runLoop` coverage** — tests that `BRANCH_PREPARED_NOTE` appears in rendered tasks for multiple steps.

**Finding — resume install-root synthesis**

- **File:** `src/runLoop.ts:462-479` (pin `6121c0c17f4ebc60efc424f23f3526491079ca1c`)
- **Rule:** Resume branch preparation must not invent an install root that was never stamped into the workspace config, because overlay rendering can mutate clone state in ways pin validation rejects.
- **Concrete failure:** When `readConfig(start.configPath)` fails or returns no `coordination.installRoot`, cursor passes `installRoot ?? defaultInstallRoot` where `defaultInstallRoot` is the coordinator source checkout. For a tracked clone whose local `coord.installRoot` is unset (vendored) but whose workspace stamp is unreadable, branch preparation may re-render the protocol from the coordinator tree instead of the clone's prior overlay. That diverges from Claude's capture/restore path and reintroduces the resume hazard Claude documents at `src/runLoop.ts:464-467`.
- **Smallest test:** Resume fixture with unreadable config and a vendored clone that already carries an overlay; assert `prepareAgentIssueBranches` restores the captured bytes and does not read templates from the coordinator checkout.

Cursor also omits Claude's capture/restore helpers, so vendored clones with no resolvable root get bit-only restore even when a pre-lift overlay was present.

### Codex — minimal viable hardening with two coverage gaps

Codex implements the same mandatory restore, finally block, dirty healing, action note, and doctor finding with the smallest product diff.

**Distinct strength**

- **Strictest post-condition** (`src/prepareAgentBranch.ts:85`) — when `protocol === "overlay"`, `assertReady` also requires `overlayPresent`, catching a restore that set the bit but failed to re-render the block.

**Finding — narrow dirty healing predicate**

- **File:** `src/prepareAgentBranch.ts:59-63` (pin `4869a4b7c4a4f639c1e2915e5600198a749e438c`)
- **Rule:** Overlay-only dirt must not block checkout even when porcelain contains more than one entry, as long as every blocking entry is healable overlay dirt on `AGENTS.md`.
- **Concrete failure:** `hasOnlyRecoverableProtocolDirt` returns false unless porcelain has exactly one entry and it is `AGENTS.md`. A clone with overlay dirt plus any second porcelain line (another modified path, or an untracked file) is refused even when the only *blocking* problem is the lifted overlay. Claude and cursor iterate lines and skip only healable `AGENTS.md` entries.
- **Smallest test:** Seed overlay-only dirt on `AGENTS.md` plus an untracked `notes.txt`; assert branch preparation proceeds when only `AGENTS.md` is healable and still refuses when `notes.txt` represents real work.

**Finding — missing product template surface**

- **File:** `templates/product/AGENTS.md` (absent from codex pin `4869a4b7c4a4f639c1e2915e5600198a749e438c` changed-path set)
- **Rule:** Issue 96 item 2 requires telling agents they do not need to create the issue branch; every agent-facing surface named in the selected plan must carry that guidance, not only the protocol overlay and per-action note.
- **Concrete failure:** Agents reading the branch-scheme section in a freshly installed clone's tracked `AGENTS.md` still see the pre-issue wording with no statement that coordination already checked out `issue-<n>/<agent>`. Only `AGENTS.protocol.md` and the runtime action note carry the rule.
- **Smallest correction:** Add the branch-scheme bullet Claude and cursor both ship.

**Resume gap (no finding block — behavioral note):** Like baseline resume, codex passes `installRoot` through unchanged with no coordinator-source fallback. That avoids Claude's synthesis hazard but leaves failure mode F2 (resume discarding a knowable install root on config read error) only partially addressed — it logs the error but still passes `null`.

### Relative ranking

| Criterion | Claude | Cursor | Codex |
|-----------|--------|--------|-------|
| Vendored overlay restore (F1) | capture/restore | bit-only | bit-only |
| Resume install-root policy | safest (no synthesis) | synthesizes coordinator root | no synthesis, no fallback |
| Dirty-gate completeness | line-wise filter | line-wise filter | single-entry only |
| Agent template coverage | both files | both files | protocol only |
| Post-checkout assertion | branch + bit | branch + bit | branch + bit + overlay when claimed |
| Test depth | 8 branch-prep cases | 7 branch-prep cases | 6 branch-prep cases |

**Claude** (`e61aad3d4af48938c05092532a25c9d453c54786`) is the most complete implementation of the selected plan: it alone restores overlay bytes on vendored clones, documents and avoids the resume root-synthesis trap, and has the broadest regression tests.

**Cursor** (`6121c0c17f4ebc60efc424f23f3526491079ca1c`) is functionally close and already ships both template updates, but the resume `defaultInstallRoot` fallback and lack of capture/restore leave two edge cases Claude closes.

**Codex** (`4869a4b7c4a4f639c1e2915e5600198a749e438c`) delivers the critical coordinator guarantees with the smallest diff, but its single-entry dirty heuristic and missing `AGENTS.md` template update make it the thinnest of the three for issue 96's full acceptance criteria.

For comparison-ballot purposes: if the goal is the smallest correct merge base, start from Claude; cursor's exported dirty helper and `BRANCH_PREPARED_NOTE` runLoop tests are worth cherry-picking; codex's overlay-presence assertion is worth considering as an additional post-condition when `protocol === "overlay"`.
