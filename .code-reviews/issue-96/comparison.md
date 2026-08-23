## Comparison

The exact implementations compared were Codex
`4869a4b7c4a4f639c1e2915e5600198a749e438c`, Cursor
`6121c0c17f4ebc60efc424f23f3526491079ca1c`, and Claude
`e61aad3d4af48938c05092532a25c9d453c54786`. All three diffs pass
`git diff --check`, bump the package to `0.0.17`, put branch preparation ahead
of launch, restore in a `finally`, narrow recovery to protocol-only dirt, add a
doctor diagnostic, and place the already-prepared-branch warning in every
action. None changes the product hook tree.

### Findings

1. **Cursor — high severity:** `src/prepareAgentBranch.ts:79-80` at
   `6121c0c17f4ebc60efc424f23f3526491079ca1c`. The dirty-clone exception must
   accept `AGENTS.md` only when removing the managed block leaves bytes exactly
   equal to `HEAD`; every human-owned byte outside the block must remain
   checkout-blocking. Comparing both values with `trimEnd()` instead accepts a
   human edit that changes only trailing whitespace outside the managed block,
   after which `liftCloneAgentsProtocol` checks out the `HEAD` copy and silently
   destroys that edit. The smallest regression is to clear skip-worktree, add
   or remove trailing whitespace outside the managed block, and assert that
   preparation throws and preserves the file byte-for-byte.

2. **Codex — moderate resilience gap:** `src/prepareAgentBranch.ts:40-55` at
   `4869a4b7c4a4f639c1e2915e5600198a749e438c`. A mandatory restore should
   preserve an already-installed managed protocol whenever those bytes were
   readable before the lift, even if neither the caller nor clone can resolve
   an install root. In a vendored resume with a missing or unreadable workspace
   stamp, this implementation lifts the tracked overlay and returns
   `"bit-only"`; the clone has the required index bit but the agent starts
   without the coordination protocol that was present immediately before
   preparation. A focused test should seed an overlay, remove all install-root
   resolution, prepare the branch, and assert both `protocol === "overlay"` and
   that the managed block survives.

### Implementation comparison

- **Claude `e61aad3d4af48938c05092532a25c9d453c54786` is the strongest candidate.**
  `src/agentsProtocol.ts:59-86` captures only the delimited managed block and
  reapplies it to the new branch's own `AGENTS.md`; `src/prepareAgentBranch.ts:59-80`
  prefers an authoritative template, falls back to that captured block, and
  uses bit-only restoration only when neither exists. Its dirty-overlay test is
  byte-exact (`src/agentsProtocol.ts:94-104`), so it avoids Cursor's data-loss
  case. Its tests cover captured-overlay restoration with no install root,
  bit-only restoration when no overlay exists, checkout failure, stranded
  overlay healing, real adjacent dirt, the doctor finding, and the warning on
  every action. It also updates both installed instruction surfaces.

- **Codex `4869a4b7c4a4f639c1e2915e5600198a749e438c` is safe on human dirt and is a
  close second.** `src/prepareAgentBranch.ts:58-74` uses NUL-delimited status
  and exact byte equality, while `src/prepareAgentBranch.ts:81-93` additionally
  asserts that an advertised overlay is actually present. Its finally,
  recovery, doctor, and all-action-note tests are sound. The material difference
  is the no-root path described above; it meets the selected plan's minimum
  bit-only fallback but needlessly discards a recoverable installed overlay.
  It also leaves the general product `AGENTS.md` template unchanged, relying on
  the protocol overlay and per-action note for the branch guidance.

- **Cursor `6121c0c17f4ebc60efc424f23f3526491079ca1c` has broad surface coverage but
  should not be selected without revision.** It updates both templates, adds
  the launch-order note and diagnostics, and supplies tests for no-root,
  exception, and dirty-recovery paths. However, those tests do not exercise a
  human-owned trailing-whitespace edit, allowing the destructive `trimEnd()`
  recovery rule above. Its `src/prepareAgentBranch.ts:45-56` also renders the
  overlay only when `AGENTS.md` is already tracked, so a known valid install
  root cannot repair a missing ignored/untracked clone overlay; the readiness
  assertion checks only the branch and bit and therefore does not catch that
  absence.

### Recommendation

Select Claude `e61aad3d4af48938c05092532a25c9d453c54786`. It preserves the
coordinator's overlay across the exact no-root failure mode, retains exact
human-byte protection, has the broadest relevant regression coverage, and
fully addresses both the pre-launch state and the agent-facing instruction
surfaces. Codex `4869a4b7c4a4f639c1e2915e5600198a749e438c` is a viable second
choice if the approved bit-only minimum is preferred over capture-based
recovery. Cursor `6121c0c17f4ebc60efc424f23f3526491079ca1c` requires the exact-byte
dirty check fix before it is safe to merge.
