# Issue 96 plan review

Reviewed bound plans at:

- cursor `c322ff755f9ad9ba2587db71e02917807a9e9266` (`.plans/issue-96/plan.md`)
- codex `8987f621e47515b123deea4be471487bf05a724d` (`.plans/issue-96/plan.md`)
- claude `3b9a0c2df8c47e2ae5f0a7230e38423aea58b37a` (`.plans/issue-96/plan.md`)

## Findings

### Cursor plan — `restoreProtocol` left unchanged

**Plan claim:** Conclusion keeps “the existing lift/checkout/restore machinery in `prepareAgentBranch.ts`” and only adds wiring plus agent-facing copy.

**Rule:** After branch preparation, every agent clone with a tracked `AGENTS.md` must finish with `skip-worktree` set before any harness starts (`src/prepareAgentBranch.ts` doc comment; issue #96 item 1).

**Failure:** `restoreProtocol` still returns without re-setting the bit when `installRoot` and `localConfigGet(clone, coord.installRoot)` both resolve empty (`src/prepareAgentBranch.ts:32-34`), which is the vendored-clone case (`src/install.ts:372`). Following the plan as written leaves F1 live: lift runs, restore no-ops, the agent starts on the correct branch with a cleared bit and a visible `AGENTS.md` diff, and the next preparation dead-ends on the dirty gate.

**Correction:** Port the unconditional `ensureAgentsMdSkipWorktree` / `finally`-wrapped restore from the Claude plan before treating branch prep as done.

### Cursor plan — setup-script coverage

**Plan claim:** Exact File List changes `scripts/setup_cursor.sh` only for session-start guidance.

**Rule:** Every installed vendor identity surface must tell automated agents not to checkout the base branch or create the issue branch (issue #96 item 2; checkout-first text still exists in `scripts/setup_codex.sh:75-78`, `scripts/setup_claude.sh:48-54`, and `scripts/setup_antigravity.sh:62-66`).

**Failure:** Codex, Claude, and Antigravity clones regenerated from this plan still emit “`git checkout $SHARED_BRANCH && git pull …`” before the automated/manual discriminator. Models with prior-session memory will run that checkout first and can undo the coordinator-prepared issue branch even though Cursor’s own rule file was fixed.

**Correction:** Extend the file list to all four `scripts/setup_*.sh` generators (as Codex lists) or add an equivalent table-driven `test/setupInstructions.test.ts`.

### Codex plan — coordinator restore defects untreated

**Plan claim:** “The coordinator already owns automated issue-branch preparation” and the remaining defect is generated vendor identities ordering a base-branch checkout first.

**Rule:** Coordination must re-set `skip-worktree` after lifting it, even when overlay rendering cannot run; instruction-only fixes cannot satisfy issue #96 item 1 on their own.

**Failure:** Implementing only the Codex file list leaves `restoreProtocol`’s silent return and the unguarded lift/checkout path untouched. Vendored workspaces and resume paths where `installRoot` is dropped still hand agents a clone with the bit cleared; updated setup copy then tells the agent not to fix it, producing a non-recoverable “uncommitted changes” refusal on the next start.

**Correction:** Add the `src/prepareAgentBranch.ts` / `src/agentsProtocol.ts` restore hardening from the Claude plan, then keep Codex’s setup-script and integration-test work as the instruction layer.

### Codex plan — no per-action branch note

**Plan claim:** The cross-vendor invariant lives in `templates/product/AGENTS.protocol.md` and the four setup scripts; `src/action.ts` / `src/runLoop.ts` `buildOrder` are not changed.

**Rule:** An agent that compacts, restarts, or reads only the current `action.md` must still see that its issue branch is already checked out and must not be recreated (issue #96 item 2; today only `R1.join` carries that sentence in `src/steps.ts:65`).

**Failure:** When the protocol overlay is missing because of the restore bug above, or the agent never re-reads clone-local rules, R2–R7 actions rendered under this plan still show only the step task plus scaffold. The agent sees branch naming rules in `templates/product/AGENTS.md` but no statement that coordination already created the branch, so branch creation remains the default fix.

**Correction:** Append a shared branch-prepared note in `buildOrder` or `renderAction` (Claude/Cursor approach), in addition to the protocol template edit.

### Claude plan — protocol template omitted from file map

**Plan claim:** Alternatives and Conclusion require the “branch already exists” note in both every rendered action and `templates/product/AGENTS.protocol.md`; Risks discusses editing that template.

**Rule:** A mechanically complete plan must list every tracked file it will change under “Exact File List to be changed or deleted” (`AGENTS.md` plan schema).

**Failure:** `templates/product/AGENTS.protocol.md` appears only in the “Exact file list to be created” prose (as a non-new edit) and is absent from the changed-file list. An implementer following the map literally updates five source files and tests but ships actions with a new note while leaving the installed overlay template unchanged, so `coord install` and overlay regeneration never pick up the template copy of the rule.

**Correction:** Add `templates/product/AGENTS.protocol.md` explicitly to the changed-file list.

### Claude plan — vendor setup scripts not updated

**Plan claim:** Scope fixes restore hardening and moves the branch-prepared note into every action via `BRANCH_PREPARED_NOTE`; setup generators are out of scope (“Not changed, deliberately: `AGENTS.md` in this clone” refers to the working clone, not the generators).

**Rule:** Stale vendor identity files are a root cause called out in issue #96 (“if they have any memory of the process, they may try to do the wrong thing”); fixing only runtime `action.md` text leaves always-on clone-local instructions contradicting it.

**Failure:** Codex global identity, Claude `CLAUDE.md` checklist, Cursor `.cursor/rules/coordination.mdc` (when regenerated from an old `setup_cursor.sh`), and Antigravity identity copies still teach checkout-first session starts. An agent that reads those before `action.md` checks out `main`, conflicting with the new note in the action body.

**Correction:** Include all four `scripts/setup_*.sh` files (Codex plan) or document an enforced `coord install` rerun that regenerates them, with a regression test.

### Claude plan — `runLoop` install-root fallback

**Plan claim:** `initializeEffects` should stop swallowing `readConfig` errors and pass the install stamp’s `coordination.installRoot` through (F2 fix).

**Rule:** Resume must supply the same install root `coord start` uses (`src/cli.ts:713` falls back to `coordinatorSourceRoot`; `src/runLoop.ts:458-465` currently does not).

**Failure:** If `readConfig(start.configPath)` throws, the plan only logs and passes whatever was resolved — it never adds the `coordinatorSourceRoot` fallback the start path has. A transient or corrupt config read on resume still passes `null`, reproducing the silent restore skip even after the bit-only restore fix unless the clone still carries a local `coord.installRoot` (non-vendored only).

**Correction:** Mirror `installRoot: resolved ?? coordinatorSourceRoot` on the resume path, not only improved error logging.

## Conclusion

All three plans correctly identify the user-visible failure mode (agents fight `skip-worktree` and recreate issue branches), but they split the real fix unevenly.

The **Claude** plan is strongest on coordinator mechanics: unconditional bit restore, `finally` around lift/checkout, dirty-gate healing, post-condition assertion before launch, doctor visibility, and a per-action branch note. It is weakened by an incomplete file map (missing `AGENTS.protocol.md` in the changed list) and by leaving vendor setup scripts untouched.

The **Codex** plan is strongest on instruction drift: all four setup generators, a table-driven instruction test, and start/resume integration assertions at the launch boundary. It does not fix the silent restore path, so it cannot fully satisfy issue #96 item 1.

The **Cursor** plan combines good coverage of `renderAction` preamble, per-action branch re-preparation before `writeAction`, launcher/docs updates, and explicit version bump, but it inherits the unchanged `restoreProtocol` bug and updates only `setup_cursor.sh`.

**Verdict:** No plan is sufficient alone. The implementer should merge Claude’s restore/post-condition/doctor/`buildOrder` note work, Codex’s four-script instruction regression plus launch-boundary tests, and Cursor’s universal `action.md` preamble and pre-`writeAction` branch re-preparation — with Claude’s file-map correction and a shared `coordinatorSourceRoot` fallback on resume. That merged scope matches both issue #96 requirements without leaving vendored clones or mid-issue resumes in a brick state.
