# Issue 142: Detect and fail loud when `.coord/bin/git` is inert

## Exact File List to be changed or deleted

- `src/hookPolicy.ts` — make `inheritRunner` hermetic: strip `COORD_GIT_DELEGATE` from the child env so declared verify commands never inherit the shim's nested-git flag; export a small `buildVerifyChildEnv` helper for the strip so it is unit-testable without mocking `spawnSync`
- `src/setupWorkspace.ts` — add `inspectGitShim(clone)` next to `GIT_WRAPPER_RELATIVE_PATH` / `GIT_WRAPPER_MARKER` that reports missing / non-executable / missing-marker; no change to `writeGitWrapper` behavior
- `src/doctor.ts` — add `gitShim: 23` to `DOCTOR_CODES`; in `checkClone`, emit findings via `inspectGitShim` (same style as the existing launcher executable check)
- `src/prepareAgentBranch.ts` — extend `readinessProblems` to refuse when `inspectGitShim` reports any problem, so `prepareAgentIssueBranches` / `assertClonesReady` fail before any harness starts (file-level, same pattern as AGENTS overlay readiness)
- `src/tmux.ts` — add a bounded post-ready pane probe that sends a one-line `command -v git` into each agent pane and parses `capturePane` output for a path ending in `/.coord/bin/git`
- `src/cli.ts` — after `startEffects` / session launch (and on the equivalent resume path that already waits for prompt readiness), run the pane probe per agent; on inert PATH, refuse further automated work for that agent with an error that names the agent and the resolved `git` path, and journal a new event (do not continue silently)
- `src/state.ts` — add journal event type `git-shim-inert` (details: agent id, resolved git path)
- `src/runLoop.ts` — if action delivery / nudge runs before a successful probe for the session, gate the first delivery on the same probe helper so a resume that skipped start still cannot proceed silently with an inert shim
- `templates/product/AGENTS.protocol.md` — rewrite the git-status/diff paragraph so refusals are agent obligations (do not run them; report if the shim blocks unexpectedly), not a guaranteed property of PATH containment
- `scripts/setup_codex.sh` — align the soft Codex instructions copy with the same obligation wording
- `scripts/setup_claude.sh` — soften the PreToolUse comment that claims `.coord/bin/git` is hard enforcement; keep the soft deny itself unchanged
- `docs/setup-workspace.md` — document doctor class `gitShim` (code 23) in the exit-code table
- `test/verify-config.test.ts` — assert `buildVerifyChildEnv` drops `COORD_GIT_DELEGATE` and preserves unrelated keys
- `test/doctor.test.ts` — missing / non-executable / unmarked shim produces `gitShim` findings; healthy install stays clean
- `test/prepareAgentBranch.test.ts` — preparation throws with "Agents were not started" when the shim file is absent or unmarked
- `test/tmux.test.ts` — pane probe accepts `…/.coord/bin/git` and rejects `/usr/bin/git` (mocked `TmuxRunner` / capture)
- `test/cli.test.ts` — start/resume path journals `git-shim-inert` and exits non-zero / refuses delivery when the probe reports demotion

## Exact file list to be created

- `.plans/issue-142/plan.md` — this plan

No new product modules. Shared file-level inspection lives beside the existing shim constants in `setupWorkspace.ts`. Live PATH probing stays in `tmux.ts` next to `capturePane` / nudge helpers. Hermetic env helper stays in `hookPolicy.ts`.

## Reuse and Scope

**Reuse (do not reimplement):**

- `GIT_WRAPPER_RELATIVE_PATH`, `GIT_WRAPPER_MARKER`, `writeGitWrapper`, `resolveRealGit` — `src/setupWorkspace.ts`
- `write_git_wrapper` / launcher `PATH` prepend — `scripts/lib/launcher.sh` (leave refusal rules and prepend as-is; this issue verifies and fails loud, it does not redesign interception)
- `finding`, `DOCTOR_CODES`, `checkClone`, `isExecutable` — `src/doctor.ts`
- `readinessProblems`, `assertClonesReady`, `prepareAgentIssueBranches` — `src/prepareAgentBranch.ts`
- `capturePane`, `harnessPromptReadiness` / `harnessPromptReady`, nudge/`send-keys` patterns — `src/tmux.ts`
- `inheritRunner`, `runVerifyPhase`, `VerifyRunner` — `src/hookPolicy.ts`
- `renderAgentsProtocolBlock` / `writeCloneAgentsProtocol` — `src/agentsProtocol.ts` (protocol text refresh on next overlay write; no separate writer)
- Journal append patterns and `journalEventTypeSchema` — `src/state.ts` (same shape as `clone-readiness-refused`)
- Install/shim fixtures and `runGit` / shim env helpers — `test/install.test.ts` (extend only if a file-level case fits better there; prefer `doctor` / `prepareAgentBranch` tests for new findings)
- Workspace fixtures — `test/support/workspaceFixture.ts`

**New surface justified:**

- `inspectGitShim` — one shared file-level check for doctor + start readiness (avoids duplicating marker/executable logic)
- `buildVerifyChildEnv` — one place to prove hermetic strip without spawning
- Pane `command -v git` probe — only way to observe harness PATH demotion; launcher-time checks cannot see post-`exec` reorder
- Journal type `git-shim-inert` — makes inert containment visible in `coord status` / analytics the same way readiness refusals already are

**Out of scope (issue "Not in scope" + rejected alternatives):** fixing Cursor/claude harness PATH construction; containers or custom shells; changing shim subcommand policy; revisiting PR #141; rewriting product `templates/product/AGENTS.md` (no PATH claim today).

## Tests

Run `pnpm check:fast` before commit (lint, typecheck, fast tests). Full `pnpm check` is the coordinator gate on the approved commit.

Focused cases (fewest that fail before / pass after):

1. **`test/verify-config.test.ts`** — with `COORD_GIT_DELEGATE=1` in `process.env`, `buildVerifyChildEnv()` returns an env object without that key; unrelated keys (e.g. `PATH`, `HOME`) remain. Fails today because no sanitizer exists.
2. **`test/doctor.test.ts`** — after a healthy fixture install, delete or chmod the shim / strip the marker → doctor report includes `class: "gitShim"` code 23; healthy install has no such finding.
3. **`test/prepareAgentBranch.test.ts`** — clone with missing `.coord/bin/git` → `prepareAgentIssueBranches` throws naming the clone and "Agents were not started."
4. **`test/tmux.test.ts`** — mocked capture containing `<clone>/.coord/bin/git` → probe ok; capture containing `/usr/bin/git` → probe inert.
5. **`test/cli.test.ts`** — start/resume with inert probe result → non-zero / refused delivery, journal contains `git-shim-inert` with agent id.

No new test files. Protocol template change is covered indirectly by existing agents-protocol / install tests if they snapshot overlay text; if a snapshot asserts the old "puts on your PATH" sentence, update that assertion in the same existing file rather than adding a dedicated suite.

## Alternatives Rejected

- **Only re-prepend `.coord/bin` in the launcher / a wrapper shell** — issue shows harnesses and login shells demote PATH after the fact; prepend-only keeps failing silently when the next harness changes env construction.
- **Containers or a custom bash/zsh that intercepts git** — listed in the issue as possible approaches but heavier than verify + fail-loud + hermetic hooks; out of scope for this smallest fix.
- **Doctor-only reporting without start refusal** — leaves automated issues running unconstrained while the UI looks healthy; contradicts "Fail loudly."
- **File-level shim check alone** — catches missing/broken wrappers but cannot see Cursor's measured PATH reorder; live pane probe is required for "inert."
- **Soft warning only (journal, continue)** — allowed as a minimum by the issue text, but silent-continue is the bug; refuse delivery / fail the start path when the probe says inert.
- **Changing shim refusal rules or forcing `COORD_GIT_DELEGATE` into every tool** — does not restore containment when `/usr/bin/git` wins; hermetic verify is the complementary fix for asymmetric hook leakage when the shim *is* active.
- **Fixing individual agent harnesses** — explicitly not in scope.

## Risks and Mitigations

- **Pane probe flakiness / interference with harness startup** — bound the wait with existing `harnessPromptReadiness` timeouts; send a single non-interactive `command -v git` line; parse only the probe result; do not loop forever. If the pane never becomes ready, keep existing readiness failure behavior rather than inventing a second hang.
- **False inert on agents that print banners before the probe line** — match any capture line that equals or ends with `/.coord/bin/git`, not only the last line; document the match rule next to the helper.
- **Hermetic env strip breaks a declared check that intentionally needs `COORD_GIT_DELEGATE`** — none should: that variable exists only so the shim can re-enter real git during hooks. Stripping it from verify children is the point. Keep the rest of `process.env` intact so `PATH` / toolchain still resolve.
- **Protocol text softens wording before live enforcement lands in the same change** — ship text + probe + refusal together in one implementation so AGENTS.md does not claim enforcement that start then ignores.
- **Doctor code 23 / new journal type** — docs table and `journalEventTypeSchema` must update together; analytics already treats unknown types as opaque, but writers validate against the enum.
- **Clones installed before this change** — missing shim is already regenerable via install / `writeGitWrapper` / post-merge; doctor remediation should say re-run `coord install` (same as launcher findings).

## Conclusion

Issue 142 makes git-shim containment observable and binding: `hook-verify` no longer leaks `COORD_GIT_DELEGATE` into declared checks; `coord doctor` and pre-start readiness require a real marked `.coord/bin/git`; a post-ready pane probe asserts `command -v git` still resolves to that shim and refuses automated work with a journaled `git-shim-inert` event when a harness demotes PATH; and the AGENTS protocol (plus Codex/Claude soft copies) describes the refusals as rules agents must follow rather than an always-on environment guarantee. Harness internals, containers, and shim policy changes stay out of scope.
