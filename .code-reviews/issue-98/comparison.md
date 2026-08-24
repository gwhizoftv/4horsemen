## Comparison

**Ranking:** (1) Codex `5055366c3484916b92b4a688d6707bc282c56c96`,
(2) Claude `9794eafd52a3e5a9f768c4bfe7aed0d46d1e84fc`, and (3) Cursor
`6b2ede95cd915d1e3f7a4a4ca0b8d078df234c5c`.

The Codex pin is the recommended revision base. It implements the specified
flat `completes/issue-N/AGENT/complete` layout and project-scoped nested
default, exposes an absolute override through both install and onboard,
rejects protected-root overlap and another workspace's claim, persists the
root, and reconstructs it for start/resume/wipe. Its static launchers grant
only the validated current issue/current agent drop: Claude receives add-dir,
Codex uses workspace-write plus add-dir, Cursor explicitly enables its sandbox,
and Antigravity explicitly enables its sandbox. It also repairs existing broad
Antigravity settings on the normal install path and scopes wipe/uninstall
cleanup. Argument-capture tests cover all four vendors, spaces, automated mode,
and the grant-free manual path. `pnpm check` passed at the bound implementation
(450 fast tests and 2 end-to-end tests).

The Claude pin is substantially complete on coordinator path plumbing. It
persists the mailbox in config, clone identity, and start state; derives the
exact issue/agent drop at launcher execution; independently rolls back and
wipes the two issue trees; and has broad focused coverage. Its direct
build/lint/typecheck/fast/e2e equivalent passed (456 fast tests and 2
end-to-end tests). It nevertheless leaves two security requirements and the
owner override contract incomplete:

- **`scripts/setup_antigravity.sh:94-102` (Claude pin):** The Antigravity
  installation must disable broad non-workspace access and trust only its own
  clone, with the current mailbox drop supplied by the launcher. The bound code
  still initializes `allowNonWorkspaceAccess: true` and derives peer clone
  paths for trust; an Antigravity install can therefore retain writable reach
  outside the exact drop, including coordinator state, despite the new add-dir
  argument. The smallest regression test is to reinstall over settings with
  the value `true` and assert the installed value is `false` and only the
  Antigravity clone remains newly trusted.
- **`scripts/lib/launcher.sh:41-59` (Claude pin):** Cursor and Antigravity must
  explicitly enter their sandboxes before receiving the exact drop as an
  additional directory. These commands append add-dir but never pass Cursor's
  sandbox-enabling flag or Antigravity's sandbox flag; a machine whose vendor
  default is unsandboxed continues to expose paths beyond the mailbox. An argv
  capture test should require `agent --sandbox enabled --add-dir <drop>` and
  `agy ... --sandbox --add-dir <drop>`.
- **`src/cli.ts:857-919` (Claude pin):** Both `coord onboard` and `coord install`
  must accept a typed `--completes-root` owner input and persist its resolved
  absolute value. Neither allowed-flag list accepts that option, so the
  `InstallOptions.completesRoot` field cannot be selected from either public
  installation command and operators needing an explicit root receive an
  unknown-flag failure.
- **`src/paths.ts:136-140` (Claude pin):** The normal flat default must be the
  sibling `completes` root itself, producing
  `completes/issue-N/AGENT/complete`; only nested workspaces need a project
  namespace. This implementation always inserts the coord-root basename, so a
  flat runtime at `.../coord-runtime` publishes under
  `.../completes/coord-runtime/issue-N/...`, contradicting the required default
  topology and operator contract.

The Cursor pin moves the coordinator's completion path into an issue-first
mailbox and gives start enough configured state to use it, but its integration
stops before agents can reliably publish there. Its build/lint/typecheck/fast
checks passed (448 fast tests), and its end-to-end suite passed on rerun after
one unrelated lifecycle-canary failure; those tests do not exercise installed
mailbox grants. The decisive implementation failures are:

- **`src/install.ts:361-368` (Cursor pin):** Every installed launcher must
  receive a persistent mailbox authority from which it can grant the current
  issue/current agent drop. The installer omits `completesDir` when calling
  `writeAgentLauncher`, so that function uses its empty default and emits a
  launcher with no completion grant; a normally installed agent cannot write
  the new external `complete` file while sandboxed.
- **`scripts/lib/launcher.sh:46-71` (Cursor pin):** Every standard harness must
  use the exact-drop grant without widening access. Codex still launches with
  `danger-full-access`, while Antigravity and Cursor compute a grant block but
  never pass add-dir (or sandbox-enabling flags) to their vendor commands; the
  former can still write coordinator state and the latter two cannot publish
  through a narrow sandbox.
- **`src/wipeIssue.ts:216` (Cursor pin):** Wipe must reconstruct the configured
  mailbox and delete that issue subtree even when it is outside the default.
  This call omits `options.config.completesRoot`, so a configured override is
  left behind; reusing the issue can then consume a stale completion SHA.

Codex is therefore the only bound pin that satisfies the complete topology,
public configuration, per-vendor sandbox, upgrade repair, and cleanup contract.
Claude is the strongest alternative after adding the missing CLI option and
tightening both vendor launch/security settings. Cursor requires launcher and
cleanup integration rather than a small correction.
