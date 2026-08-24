# Issue 98 — isolate completion receipts in a sibling mailbox

The completion SHA is the only agent-authored runtime input. Move that one
file out of the coordinator-owned runtime and into an absolute, workspace-bound
mailbox while leaving actions, cursors, journals, lifecycle state, and render
logs under the owner runtime. In the normal flat layout the configured mailbox
root is the sibling completes directory; an issue/agent receipt is therefore
completes/issue-N/AGENT/complete. Agents are always shown the absolute path and
never a parent-relative spelling.

The installed workspace config will carry a required absolute **completesRoot**.
Install derives the flat default as dirname(coordRoot)/completes. A nested
workspace gets a project-namespaced child of that default so two products with
the same issue and agent names cannot collide. Both onboard and advanced
install accept an explicit --completes-root override, and install rejects an
override that overlaps the product, coordinator runtime, an agent clone, or a
mailbox already claimed by another configured workspace. No compatibility
fallback to the old runtime/agents/AGENT/complete location will be retained;
old installs must be repaired by re-running install, as allowed by the issue.

## Exact File List to be changed or deleted

No files will be deleted. The following existing files will change:

- `src/paths.ts` — add the safe external mailbox root and issue mailbox paths
  to IssueRuntimePaths; keep action and render-log paths under the agent runtime
  but derive complete from completesRoot/issue-N/AGENT/complete. Validate the
  mailbox root as absolute, non-symlinked, and non-overlapping with protected
  roots. Create the mailbox root, issue directory, and one 0700 agent drop
  directory alongside the existing coordinator runtime directories.
- `src/state.ts` — make the resolved absolute completesRoot part of the strict
  workspace config. Thread it through workspace-config construction, but keep
  it out of product declarations because it is an owner filesystem decision.
  The config bytes already participate in the automation digest, so changing
  this root after install changes workflow authority rather than silently
  redirecting submissions.
- `src/hookPolicy.ts` — define the local clone identity key
  coord.completesRoot beside the existing workspace-config/install keys so
  launchers can resolve the absolute mailbox without reading or writing
  coordinator state.
- `src/setupWorkspace.ts` — compute/configure the workspace mailbox root,
  record coord.completesRoot in each clone, clear it during uninstall, and
  ensure generated launchers remain path-independent and idempotent.
- `src/install.ts` — add the optional completes-root install/onboard input,
  derive the safe flat or nested default, create the root with owner-only mode,
  reject overlap or cross-workspace reuse, pass the resolved value into config
  and clone identity, report it to the operator, and include it in
  uninstall --wipe-runtime cleanup without deleting another workspace's
  mailbox.
- `src/doctor.ts` — report a missing, symlinked, non-directory, overlapping, or
  miswired mailbox as a concrete installation finding. Check that every clone's
  coord.completesRoot is absolute and equals the workspace config.
- `src/cli.ts` — parse/document --completes-root for onboard and install; build
  start, resume, next, drop, restart-action, status, analytics, detach, and wipe
  contexts with the configured mailbox root. Startup rollback must remove both
  newly created issue trees so a failed start cannot leave a stale receipt.
- `src/agentEvent.ts` — reconstruct issue paths with the configured
  completesRoot while retaining action-path validation against the
  coordinator-owned agent runtime.
- `src/action.ts` — keep completePath only in the human action body, but make
  completion reads and clears accept the trusted mailbox root, reject symlink
  traversal, and read only a regular no-follow file before applying the
  existing exact-SHA parser.
- `src/runLoop.ts` — pass the mailbox containment boundary to every completion
  read/clear path, including accepted, rejected, reissued, dropped, and stale
  completions. The state-machine meaning of a completion SHA does not change.
- `src/wipeIssue.ts` — remove both the coordinator issue directory and the
  matching completesRoot/issue-N directory, including when only one side
  exists; expose/log both cleanup results so stale SHAs cannot affect a reused
  issue number.
- `scripts/lib/launcher.sh` — when COORD_ISSUE is a positive integer, read the
  absolute coord.completesRoot clone key, derive only the current
  issue/current-agent drop directory, verify it exists, and pass that exact
  directory as the harness's additional writable root. Claude uses add-dir;
  Codex uses workspace-write plus add-dir instead of danger-full-access;
  Cursor enables its sandbox plus add-dir; Antigravity enables its sandbox plus
  add-dir while retaining unattended approvals inside that sandbox. Manual mode
  has no issue environment and receives no mailbox grant.
- `scripts/setup_antigravity.sh` — stop installing broad non-workspace access
  that would defeat the per-drop launcher sandbox, retain trust only for the
  Antigravity clone itself, and let the launcher add the current mailbox at
  issue runtime rather than trusting the coordinator runtime or all completes.
- `config.example.json` — show the required absolute completesRoot in a full
  workspace configuration.
- `config.product.example.json` — show the installed absolute completesRoot in
  the stamped workspace example.
- `README.md` — show the sibling mailbox in the default onboard topology and
  document the advanced override and reinstall requirement.
- `docs/coord-driver.md` — update the runtime diagram and completion contract:
  action stays in coord-root, the absolute completion path is under the sibling
  mailbox, and the coordinator safely reads/clears only that receipt.
- `docs/repo-map.md` — correct the invariant that currently places complete
  beside coordinator state and identify paths/launcher as the owners of the
  mailbox boundary.
- `docs/setup-workspace.md` — document default and nested layouts, config/clone
  identity, vendor-specific per-issue grants, doctor behavior, wipe behavior,
  and the explicit completes-root option.
- `test/support/workspaceFixture.ts` — give every product fixture a unique
  mailbox root so parallel tests never share the host's generic sibling
  completes directory.
- `test/action.test.ts` — cover an absolute external completePath in the action
  body, unchanged three-field front matter, strict SHA parsing, and refusal to
  follow a completion symlink.
- `test/agentEvent.test.ts` — update configs/path construction and prove
  lifecycle action validation still targets coord-root rather than the
  mailbox.
- `test/agentLanguage.test.ts` — update path/config fixtures while preserving
  all agent-facing language checks.
- `test/cli.test.ts` — cover option parsing, configured path resolution for
  explicit and product-derived issue commands, startup rollback of both trees,
  and clear-on-drop/restart behavior at the new receipt path.
- `test/doctor.test.ts` — cover missing/mismatched/symlinked/overlapping mailbox
  findings and the healthy exact clone-key case.
- `test/install.test.ts` — cover default and explicit config values, nested
  project isolation, overlap/reuse refusal, clone identity, reinstall
  idempotence, wipe-runtime behavior, and generated launcher arguments for all
  four harnesses. Stub harnesses will assert the current issue/agent drop is
  granted, coord-root and peer drops are not, paths with spaces remain one
  argument, and manual launch receives no external grant.
- `test/integration.test.ts` — move end-to-end completion writes to the sibling
  mailbox and prove the driver still accepts the exact pushed SHA and advances
  the workflow.
- `test/onboard.test.ts` — assert the flat sibling default, nested
  project-namespaced roots, clone key, and explicit override from the simple
  onboarding command.
- `test/runLoop.test.ts` — move all completion fixtures to the mailbox and
  retain coverage for malformed, transient, accepted, reissued, and dropped
  receipts plus symlink rejection.
- `test/state.test.ts` — verify completesRoot is required and absolute in the
  strict config and survives write/read construction.
- `test/verify-config.test.ts` — update strict workspace fixtures for the new
  required owner path without changing verification semantics.
- `test/wipeIssue.test.ts` — verify normal and dry-run wipe behavior removes or
  reports the exact issue mailbox, preserves other issues/projects, and removes
  a mailbox even if the coordinator issue tree is already absent.
- `test/workspace.test.ts` — update hand-written configs and prove flat/nested
  workspace resolution retains the correct absolute mailbox for each product.

The already-correct PR-only version gate, manifest-derived CLI version test,
and plain fast-test script are not part of this implementation. The baseline
already contains those carry-forward fixes, so no version or test-wrapper file
is added to the approved map.

## Exact file list to be created

- `test/paths.test.ts` — focused path-boundary tests for the flat/nested mailbox
  layout, per-issue/per-agent isolation, invalid agent/issue inputs, protected
  root overlap, containment, modes, and symlink rejection.

No other product or test files will be created.

## Tests

Implementation acceptance will cover these behaviors:

1. A flat workspace resolves its mailbox to the absolute sibling completes
   directory; a nested workspace receives a project namespace; explicit roots
   remain exact; unsafe roots fail before any clone/config/runtime write.
2. Actions and render logs remain under coord-root, while each complete path is
   absolute and unique by workspace, issue, and agent. No action front-matter
   field is added.
3. The coordinator creates both trees, accepts the existing one-line SHA
   formats from the new location, never follows a symlink, and clears only the
   addressed agent receipt for acceptance, rejection, reissue, restart, or
   drop.
4. Startup failure, wipe-issue, and uninstall --wipe-runtime remove the
   appropriate mailbox scope without touching peer agents, other issues, other
   products, agent clones, or coordinator state outside the requested scope.
5. Generated Claude, Codex, Cursor, and Antigravity launchers receive only the
   current agent drop as an additional root in automated mode. Codex no longer
   launches danger-full-access, Cursor/Antigravity explicitly enable their
   sandboxes, Antigravity has no broad non-workspace setting, and manual mode
   receives no completion grant.
6. The end-to-end workflow still publishes an action, consumes the exact pushed
   commit SHA, verifies evidence, journals the result, and advances normally.

Run the focused fast tests while iterating:

    pnpm vitest run --config vitest.config.ts test/paths.test.ts test/action.test.ts test/agentEvent.test.ts test/agentLanguage.test.ts test/cli.test.ts test/doctor.test.ts test/install.test.ts test/onboard.test.ts test/runLoop.test.ts test/state.test.ts test/verify-config.test.ts test/wipeIssue.test.ts test/workspace.test.ts

Run the integration suite after the mailbox flow is wired:

    pnpm test:e2e

Run the repository-required checks before publication:

    pnpm check:fast
    pnpm check

No version bump is part of ordinary issue-branch verification; the PR-only
merge gate remains separate.

## Alternatives Rejected

1. **Keep complete beside action and grant agents coord-root.** Rejected because
   it gives an agent writable reach toward cursors, journal, lifecycle state,
   and other agents' coordinator-owned files—the failure this issue exists to
   remove.
2. **Use one global receipt or one AGENT-complete filename.** Rejected because
   agents, issues, and nested products can overwrite or replay one another.
   Workspace, issue, and agent must all be represented by containment.
3. **Tell agents to write a parent-relative path.** Rejected because sandbox
   path resolvers commonly treat parent traversal as escape. The action and
   launcher both use a normalized absolute path.
4. **Grant the entire completes root to every harness.** Rejected because a
   peer could erase or replace another agent's intent. COORD_ISSUE is already
   set before each automated harness starts, so the launcher can grant the
   exact current drop; manual sessions need none.
5. **Treat the completion file as repository evidence.** Rejected because it is
   transient intent, not a committed artifact or an approved-plan path. Git
   evidence and completion intent retain their existing separate trust
   boundaries.
6. **Silently poll both old and new locations.** Rejected because dual
   authority permits stale receipts and makes cleanup ambiguous. The issue
   explicitly requires no backward compatibility; reinstallation is the one
   migration boundary.
7. **Rework the version gate or fast-test wrapper again.** Rejected because the
   baseline already makes the version gate PR-only, reads the CLI version from
   the manifest, and runs the plain fast test. Reopening those files would add
   unrelated scope without fixing completion isolation.

## Risks and Mitigations

- **A configured external path could escape into protected data.** Resolve it
  absolutely, reject overlap with coord-root/product/agent clones and other
  workspace mailboxes, reject symlink components, and repeat validation at
  install, doctor, start, read, clear, and destructive cleanup boundaries.
- **An agent could replace complete with a symlink between polling ticks.**
  Confine the candidate to its bound mailbox, reject symlink components on
  every observation, open the receipt with no-follow semantics, require a
  regular file, and preserve the existing exact one-line SHA parser.
- **Shared/nested products can reuse issue and agent names.** Store an absolute
  workspace-specific root; namespace the derived nested default by project;
  reject an explicitly reused root; then add issue and agent segments beneath
  it.
- **A static install-time launcher does not know the future issue.** Resolve
  the persisted clone key at launch and combine it only with validated
  COORD_ISSUE and the fixed installed agent identity. Post-merge launcher
  regeneration remains deterministic because no issue-specific path is baked
  into the generated file.
- **Narrow sandboxing can reintroduce owner prompts or break manual mode.** Keep
  each vendor's unattended approval behavior inside its sandbox, add only the
  automated drop directory, run generated launchers against stub harnesses,
  and explicitly test the no-issue manual path.
- **Destructive commands could orphan or over-delete mailboxes.** Model the
  coordinator issue root and completion issue root separately, make cleanup
  idempotent when either is absent, scope nested roots per project, and test
  peer issue/product preservation for wipe and uninstall.
- **A missing required field breaks existing installs.** This is intentional
  per the issue's no-compatibility direction. Strict parsing and doctor provide
  a fail-closed diagnostic whose remediation is to rerun onboard/install; no
  old completion is silently accepted.

## Conclusion

This plan creates a narrow, absolute completion mailbox between the agent
clone and coordinator runtime. Coordinator authority remains under coord-root,
repository evidence remains on agent branches, and each harness receives only
the one current issue/agent directory needed to publish its SHA. Strict config,
path, launcher, lifecycle, cleanup, and end-to-end tests make the new location
the sole completion authority without reopening already-resolved version-gate
work.
