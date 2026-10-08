# Issue 161 plan review

This review covers the bound plans:

| Agent | Plan commit |
| --- | --- |
| cursor | `87653072adc2b4f5e944cc093c2fa73337745813` |
| claude | `e635fae7af6dd6d07b3f3bd7c4ff6e2867149ae3` |
| antigravity | `84dc2d37e099af6d8d58d069f33cc694c3f9f28d` |
| codex | `b35d439ec356cee0158a59b8154b1c893ee2aa16` |

Each plan was read from its bound input file. Claims about current behaviour were checked against the baseline source in this clone, for example `src/runLoop.ts` `deliver`/`maybeLifecycleNudge`, `src/agentLifecycle.ts` `orderAgentAction`, `src/ownerControls.ts` `clearAgentLocalWork`, `src/cli.ts` `existingContext`, and `vitest*.config.ts`. No product tests were run, because this review is coordination evidence only.

All four plans agree on the shape of the work:

- Plain-language status with a `----` frame.
- Progress logs for acceptance, checks and pushes.
- A start-up hook check and a missing-Stop warning.
- `n` for re-nudging, Return liveness, and unknown-key help.
- Confirmed nudge-loop release under `r`.
- No "force-advance" command, with the same justification each time.
- "Repository" wording, with the `--product` flag kept for compatibility.

They differ in how `n` works, how `--coord-root` is resolved, and how much new machinery they add.

## Findings

### F1 — cursor and antigravity: `n` resets send/deferral counters ("re-arm a send" / "resetting deferral delays")

**Rule.** The `n` control exists for the case named in issue item 6: codex drafted a plan, did not commit it, and "coord thought it was still working". `n` must cause a delivery attempt in that state, or say plainly that it cannot.

**Failure.** Suppose an earlier send was injected and the lifecycle `execution` is `working`. Then `deliver` returns at `runLoop.ts:1120`:

```ts
if ((entry?.execution === "working" && !staleWorking) || …) return cursors;
```

- `staleWorking` requires `safety.sends === 0`, `delivery === "ordered"` and `injectedAt === null`. After an injection the last two can never be true again, so resetting `sends` or the deferral list changes nothing.
- `maybeLifecycleNudge` also allows another send only after a lifecycle idle transition (comment at `runLoop.ts:1748`).

So the planned `n` silently does nothing in exactly the motivating case.

Antigravity's `nudge()` also takes no agent argument. Its plan does not say how a key callback reaches the `CoordinatorRunLoop` instance: `runIssue` only calls `makeRunLoop(paths).run(...)` and keeps no reference.

**Smallest correction.** Name the gate `n` relaxes and the proof it still requires. Codex's plan does this: an owner-requested send on the same action may use fresh positive idle proof against a stale `working` record. Alternatively, re-issue the action (claude's plan, with F6's caveat). Either way, print the deferral reason when the send is refused.

### F2 — cursor: rejects `restart-action` for `n` because it "clears agent work and would delete the uncommitted draft"

**Rule.** A rejected alternative must be rejected for a true reason.

**Failure.** The claim is false for Git-mode actions. `restart-action` calls `clearAgentLocalWork` (`ownerControls.ts:30–35`), which removes only the runtime `complete`, `action.md` and the private response file. It never touches the agent clone, so an uncommitted draft survives.

Because of this false premise, cursor chose the re-arm design that F1 shows to be inert. The real costs of `restart-action` are different (see F6).

### F3 — cursor: item 4d is answered by printing `--coord-root <start.coordRoot>` and explicitly rejecting defaulting

**Rule.** Issue item 4d asks: "Can coord-root be defaulted to the one for the current worktree if it is omitted?"

**Failure.** With cursor's plan, an owner who types `coord resume --issue 158 --agent codex` or `coord status --issue 158` from the onboarded repository still gets `--coord-root is required`. `existingContext` falls through to `context` and calls `requireFlag(parsed, "coord-root")` (`cli.ts:202, 432`).

Only copy-pasted recovery lines work. Cursor's Tests section has no case for omitted `--coord-root`.

**Smallest correction.** When neither `--product` nor `--coord-root` is given, resolve the runtime through `resolveStart` from `io.cwd`, as `coord N` already does. Claude and antigravity plan this; codex plans it with extra agent-clone resolution. Printing the root in recovery lines can stay as an addition.

### F4 — cursor: the start-up preflight warns when hooks are "missing/untrusted/wrong issue", reusing only `inspectAgentLifecycleHooks`/doctor

**Rule.** Every condition a plan promises to detect must have a named source of evidence.

**Failure.** `inspectAgentLifecycleHooks` compares hook files with the planned document. It returns `missing`, `modified`, `current` or `unsupported` (`agentHookSync.ts:270–297`). It cannot see vendor trust, and it cannot see which issue a hook run reports: that comes from `COORD_ISSUE` in the tmux environment at run time.

An implementer following the plan must either invent "untrusted"/"wrong issue" checks or quietly drop them, and the plan's tests would then assert a warning that has no evidence behind it. The "N correlated send/observe cycles" for the Stop warning is also left undefined.

**Smallest correction.** Limit the start-up check to installed/current hook files. Say that trust and issue binding stay with the existing R1.join containment warning and the run-time missing-Stop warning, and fix N.

### F5 — antigravity: interactive `r` on a nudge-loop hold

**Plan claim.** Alternatives #4 rejects "Requiring `--reset-nudge-budget` in interactive hold release". The plan never says that `releaseHold` must receive `resetBudget: true`, and it never mentions a confirmation step.

**Rule.**

- `releaseHold` throws `Nudge-loop release requires --reset-nudge-budget.` unless `resetBudget` is passed (`state.ts:1434`).
- A budget reset authorizes 4 more sends, so it should need an explicit owner confirmation. The current menu title says "Inspect the agent before releasing its hold".

**Failure.**

- If `resetBudget` is not passed, `r` keeps failing with the exact error quoted in the issue.
- If it is passed with no confirmation, `r`, `1`, Enter re-arms 4 sends from a single keystroke sequence.

The plan has no test for either case.

**Smallest correction.** Pass `resetBudget: hold.reason === "nudge-loop"` only after a `[y/N]` confirmation. Test that Enter alone does not release the hold and that `y` does. Cursor, claude and codex all specify this.

### F6 — claude (self-review): `n` reuses `restart-action`

**Rule.** A "remind" control must not discard agent output or other agents' pending state, and the plan must state what happens when delivery is still refused.

**Failures.**

1. **A written ballot response is deleted.** For a response-mode action, `clearAgentLocalWork` calls `clearAgentResponse`, which unlinks the private response JSON. Take an agent that wrote its ballot response but not `complete`, the response-mode analogue of "drafted but not committed". Pressing `n` deletes that response.
2. **Shared ballot batches are invalidated.** `restart-action` invalidates every unpublished ballot batch (`invalidateUnpublishedBatches`) even when only one agent is selected.
3. **`n` can still defer forever with no explanation.** The new action keeps the old lifecycle `execution` (`orderAgentAction` copies `...current`). A stale `working` record therefore makes the new action `staleWorking`, and delivery still needs `COORD-IDLE` or ready-file proof in the pane. The motivating codex pane may show neither. In that case `n` defers with `no-idle-sentinel`, and the plan does not tell the owner that typing into the pane is the remaining remedy.

**Smallest correction.** Either:

- restrict `n` to Git-mode steps and print the resulting deferral sentence, or
- adopt codex's same-action owner reminder: no new action ID, no cleared response, and fresh idle proof replacing the stale `working` record.

### F7 — claude (self-review): Tests command `pnpm vitest run --config vitest.config.ts … test/cli.test.ts …`

**Rule.** Named verification commands must actually run the named files.

**Failure.** `vitest.config.ts` excludes `test/cli.test.ts`, which lives in `vitest.system.config.ts`. The planned CLI cases (coord-root default, `--repository` alias, `Policy` wording) would silently not run during development.

**Smallest correction.** Run `test/cli.test.ts` with `--config vitest.system.config.ts`, as codex's plan does.

### F8 — codex: file map and mechanisms beyond the issue

**Plan claim.** The file map has 19 files. It includes `agentLifecycle.ts` (new persisted Stop-observation fields), `tmux.ts` (a session-environment diagnostic and an owner idle override), `verificationRunner.ts` (a progress callback), `doctor.ts` (an extraction), `workspace.ts` (agent-clone locator resolution for owner commands) and a new per-command `coord <command> --help` / `coord help <command>` surface.

**Rule.** AGENTS.md "Implementation discipline": keep the work within the issue, make the smallest change that fully solves it, and avoid speculative flexibility.

**Failure.** Several parts go past what the issue asks.

1. **Agent-clone runtime resolution.** Item 4d asks only for the owner's current worktree. Resolving owner commands from agent clones too adds new locator-crossing rules and new rejection tests.
2. **Persisted lifecycle fields.** The issue asks for a warning after N turns. New persisted fields with migration defaults are not needed for that: an in-memory count per runner is enough.
3. **Reading `COORD_ISSUE` from the tmux session.** This overlaps the separately tracked misrouted-Codex-Stop defect (issue 176).
4. **A second help subsystem.** Item 11 asks for verbose help for the interactive controls. Per-command help on every CLI command is extra.

Each extra mechanism brings its own tests: the plan's Tests section lists six regression groups across 9 test files. The 4-attempt send limit and the idle checks in `tmux.ts` guard every keystroke typed into an agent's pane, so they need extra care. The plan changes that code for a usability issue, which raises the review and regression risk compared with the narrower plans.

Codex's same-action owner reminder in `runLoop.ts`/`tmux.ts` is the one addition that fixes a real gap (F1/F6), and it should stay.

**Smallest correction.** Drop the agent-clone locator path, the persisted Stop counters (keep an in-memory count), the tmux environment probe and per-command help. Keep the owner reminder, the progress lines, the `----`/severity report and confirmed `r`.

### F9 — antigravity: reuse and test citations

These two points are minor and not blocking.

1. **Status markers.** The plan uses Unicode `✓`/`⚠`. `interactive.ts` already counts non-ASCII characters as width 2 when it trims the prompt, so this works. But the issue asks for "a color or a leading character", and the ASCII words that codex and claude use (`[OK]`/`[ACTION]`, `OK`/`NEEDS YOU`) also survive piped logs. Either choice is acceptable.
2. **Fixture.** `test/support/workspaceFixture.ts` exists, so that reuse claim holds.

## Conclusion

No plan is acceptable unchanged for the `n` control. The re-arm designs (cursor and antigravity) are inert in the issue's own scenario (F1). Cursor's rejection of `restart-action` rests on a false premise (F2). Claude's re-issue design deletes written ballot responses and invalidates other agents' unpublished batches (F6). Codex's same-action owner reminder that still requires positive idle proof is the correct mechanism for this point.

On everything else:

- Cursor misses the `--coord-root` default the issue asks for (F3) and promises trust and issue-binding detection it cannot perform (F4).
- Antigravity leaves nudge-loop release under `r` unspecified (F5).
- Codex is correct on the hard points but much larger than the issue needs (F8).
- Claude's plan is the narrowest complete map. It needs F6 and F7 corrected.

Recommended basis: claude's file map and scope, with codex's owner-reminder mechanism replacing the `restart-action` reuse for `n`, and codex's vitest system-config command for `test/cli.test.ts`.
