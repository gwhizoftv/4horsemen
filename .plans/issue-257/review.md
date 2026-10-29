# Issue 257 plan review — claude

Reviewed pins:

- claude plan `200ca23013a8a94bf29759b68b9595d91547c24b` (`.plans/issue-257/plan.md`)
- codex plan `1db91964c3920092fd1a74bd081a0ad6f4e7dc15` (`.plans/issue-257/plan.md`)

Both were read from the bound input files. Source claims were checked against
baseline `ac57c3a543ff2c6f3f16e5bc3f46c61efb1c4d52` in this clone. No product
tests were run; this is a plan review.

Both plans agree on the core:

- opt-in, not in `DEFAULT_AGENTS`;
- pull delivery;
- no terminal adapter or lifecycle mapping;
- `~/.opencode/bin` lookup;
- `OPENCODE_DISABLE_AUTOUPDATE`;
- a version-only `agentExecutables` row;
- OpenRouter configured inside OpenCode.

They differ on four points:

- the issue's config.json `model` route: codex implements it, claude defers it;
- owner-reminder key handling: codex handles it, claude omits it;
- external-directory permissions: claude grants them, codex leaves them interactive;
- the `.opencode/` clone ignore: claude adds it, codex does not.

## Findings

### F1 — claude plan, "Exact File List" (`src/tmux.ts` listed as unchanged) and Scope ("does not promise unattended nudging")

**Rule.** Every key sequence coordination can send to a roster agent must be correct for that harness. That includes owner reminders, not just automatic nudges. Owner reminders are offered for every agent in the start state (`src/runLoop.ts:1016`, `reminders()`). `sendOwnerReminder` calls `TmuxController.remind` (`src/tmux.ts:1242`) whatever the agent's `delivery` is. `remind` resolves keys with `resolveNudgeKeys` and has no readiness gate.

**Failure as written.** The claude plan does not add `opencode` to `agentOwnerUiDefaults`. So `buildWorkspaceConfig` writes the generic default, `nudgePrelude: []` and `nudgeSubmit: ["Escape", "Enter"]` (`src/setupWorkspace.ts:83`). The plan also leaves `vimInsertPrelude` (`src/tmux.ts:357`) unchanged. When the owner presses `n` for the OpenCode pane:

- `resolveNudgeKeys` turns the empty prelude into the vim fallback `["a"]`;
- the submit keys stay `Escape, Enter`;
- OpenCode receives `a<action text>`, then Escape, which is its documented interrupt key, then Enter.

During a running turn this interrupts the agent's work. At an idle prompt it submits a corrupted message. The claude plan's own operator flow relies on owner delivery in pull mode, so this is the main path, not an edge case.

**Smallest correction.** Adopt the codex plan's handling:

- add an `opencode` case to `agentOwnerUiDefaults`: `nudgePrelude: []`, `nudgeSubmit: ["Enter"]`, profile `Basic`;
- exclude `opencode` from the `vimInsertPrelude` fallback;
- add `src/tmux.ts` and `test/tmux.test.ts` to the file map. The test is one `remind` case asserting the exact action text and a single Enter, with no `a` and no Escape.

### F2 — codex plan, `scripts/lib/launcher.sh` ("Keep OpenCode's owner permission policy intact; external-file and command prompts remain interactive")

**Rule.** The generated launcher grants each harness exactly the per-issue directories it must use (`write_launcher`, `scripts/lib/launcher.sh`, "Grant this harness … narrow writable directories"):

- the completion drop;
- its own `responses` directory;
- `inputs` and `worktrees`.

A harness without `--add-dir` still needs an equivalent grant. Otherwise the protocol's mandatory writes and bound-input reads depend on an owner answering prompts.

**Failure as written.** OpenCode's `external_directory` permission defaults to `ask` (OpenCode permissions docs). Under the codex plan, every Git-mode action stops at an approval prompt when OpenCode writes `<completesRoot>/issue-<n>/opencode/complete`. It stops again for `ready`. A ballot stops for its response JSON, and a review stops for each bound `inputs/…` or `worktrees/…` read.

The coordinator does not see a prompt as a stall it can explain; the action just never completes. An "always" approval does not survive a pane restart or dead-pane recovery, which the codex plan routes through `launchAgent`. So each relaunch re-arms every prompt. Pull mode makes the owner responsible for delivery, but it should not make the owner approve each receipt.

**Smallest correction.** Translate the launcher's existing `coord_grant` directory list into `OPENCODE_PERMISSION={"external_directory":{"<dir>/**":"allow",…}}` for `opencode` only, as the claude plan specifies. Escape `\` and `"`, and leave the variable unset when there is no issue. Extend the codex plan's launcher-execution test in `test/install.test.ts` to assert the parsed JSON for spaced paths.

### F3 — codex plan, `src/state.ts` ("validate provider/model syntax while allowing further slashes in the model identifier")

**Rule.** The model validator must accept every identifier OpenCode's `opencode models openrouter` can print. Otherwise the documented route of copying that id into config fails at `coord start`.

**Failure as written.** The plan names slashes as the only extra character it allows. OpenRouter identifiers routinely carry a variant suffix after a colon, for example `openrouter/deepseek/deepseek-chat-v3-0324:free` and `…:nitro`. A validator built as provider `/` segments of `[A-Za-z0-9._-]` would reject these. `coordinatorConfigSchema.parse` would then refuse the whole config, and with it the issue start, for a correct model id.

**Smallest correction.** Validate only what the plan's safety argument needs: a non-empty provider segment, `/`, then a non-empty remainder with no whitespace or control characters. Add a `:free` id to the table-driven accept cases in `test/state.test.ts`.

### F4 — codex plan, Tests item 5 (`test/runLoop.test.ts`)

**Rule.** The action asks for the fewest focused tests that fail before the change and pass after it.

**Failure as written.** The plan itself says the run-loop cases "preserve existing behavior … they are not evidence of a new readiness adapter."

- Pull delivery already skips automatic sends (`src/runLoop.ts:2036`).
- Owner reminders already reach pull agents (`src/runLoop.ts:1016`).
- The only new behaviour on that path is the key choice, which item 3 already covers in `test/tmux.test.ts`.

An OpenCode-specific run-loop fixture therefore passes on the baseline once `opencode` is configured. It adds a sixth test file and an eleventh changed path without detecting this change.

**Smallest correction.** Drop item 5 and `test/runLoop.test.ts` from the file map.

### F5 — claude plan, Risks ("An owner-exported `OPENCODE_PERMISSION` is replaced… The owner's config-file permissions still apply")

**Rule.** A plan must not state vendor precedence it has not verified.

**Failure as written.** The OpenCode docs list `OPENCODE_PERMISSION` as "inline JSON permissions config" and do not say whether it merges with or replaces the config file's `permission` block. If it replaces that block, the launch silently drops an owner's `deny` rules, for example `bash: {"git push --force*": "deny"}`, for every automated issue. The documentation the plan proposes would tell the owner those rules still apply.

**Smallest correction.** Either verify merge behaviour in the live smoke check and document the observed result, or state in `docs/setup-workspace.md` that precedence is unverified and that owners should keep required denies in `OPENCODE_CONFIG_CONTENT` or the config file and confirm them after launch.

### F6 — claude plan, `src/productIgnore.ts`, `.gitignore`, `templates/product/gitignore.coordination.block` (`.opencode/`)

**Rule.** Justify every changed file with an observed need; avoid speculative scope.

**Failure as written.** The justification is "anything OpenCode or the owner places there". Neither plan verified that OpenCode writes into a project `.opencode/` directory unprompted. Muse's `.muse/` entry was added because its integration generated `.muse/hooks.json`. Here the plan adds three changed files and test assertions for a directory nothing in the plan creates.

This is low severity: the rule is harmless if unused. It is still unproven scope.

**Smallest correction.** Keep it only if the live smoke check shows OpenCode creating clone-local state there. Otherwise drop it and record the check in the docs.

### Scope and reuse assessment

- **Issue coverage.** The issue names two routes. The codex plan implements both: an optional frozen `model` in the agent record, passed as one shell-quoted `--model` argument at `launchAgent`, plus in-pane `/connect`/`/models`. The claude plan implements only the second and rejects the first. Its stated reason (`write_launcher` cannot take a fifth argument) does not apply to the codex design, which passes the model at the tmux launch boundary and leaves the launcher template's arguments unchanged. The codex scope is therefore the more faithful reading of the issue.
- **Reuse.** Both plans reuse `launcher_environment`/`launcher_command`/`write_launcher`, the `agentExecutables` maintenance path, `buildWorkspaceConfig`, the doctor's unsupported-vendor + pull acceptance, and existing fixtures. Neither creates a file or a dependency.
- **Schema restriction.** The codex plan's schema-level restriction of `opencode` to pull duplicates the doctor rule (`src/doctor.ts:358`) at a stricter layer. It is acceptable, and it fails earlier, but a future adapter must relax it in `src/state.ts`.

## Conclusion

Neither plan is ready to implement exactly as written.

- **claude plan.** It has a blocking defect (F1): owner reminders, the delivery path the plan depends on, would send a vim `a` and OpenCode's interrupt key. It also covers only one of the issue's two routes.
- **codex plan.** It is the better base: it covers both routes and handles reminder keys. It needs these corrections:
  - F2: grant the four per-issue directories through `OPENCODE_PERMISSION`, so receipts and bound inputs do not wait on prompts after every relaunch;
  - F3: accept `:` variant suffixes in model ids;
  - F4: drop the run-loop test, which does not fail on the baseline.

**Recommendation.** Proceed with the codex plan amended by F2–F4. Carry over from the claude plan:

- the scoped `OPENCODE_PERMISSION` grant and its test;
- the F5 caveat about permission precedence in the documentation.

Add the `.opencode/` ignore (F6) only on observed evidence.
