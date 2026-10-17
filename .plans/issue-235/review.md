# Issue 235 plan review

Reviewed pins:
- cursor `f372678b802f7b8cba21e5d325ee15f7132244bf`
- codex `ae92f75414b10cc9863c28688ba7336b741fb2da`
- claude `4aefc91e7638ee270c8b4d86da4db867f899dc1b` (this agent's own plan, reviewed with the same rules)

All three agree on the core design: Muse is fifth in both onboarding defaults,
it is generated with `delivery: "both"`, doctor no longer fails Muse for its
missing lifecycle vendor mapping, and the Muse terminal adapter stays inside
`src/tmux.ts`. Each plan reuses the existing ready/complete authority, and none
adds hooks, a registry or a new module. The findings below concern the
differences.

Baseline facts the findings rely on (checked at baseline):
- `src/tmux.ts:1239`: the pre-send recapture in `nudge()`'s `send` runs only for `claude || codex`.
- `src/runLoop.ts:918–936`: `DEFERRAL_RATIONALE` is a plain `Record<string,string>`. An absent
  code falls back to "the terminal refused delivery" and counts as unknown
  toward `UNKNOWN_DEFERRAL_LIMIT` (`src/runLoop.ts:1939–1942`).
- `src/cli.ts:405` documents that owner "reminders bypass readiness, spacing and
  send limits", and `test/tmux.test.ts:1520` pins that contract for every vendor.
- `src/doctor.ts:408–412` checks that the launcher file exists and is executable.
  Doctor never checks that the agent executable is on PATH.
- In a live Muse 1.4.10 pane measured for the claude plan, a running turn keeps the
  empty `❯` composer painted and adds `◈ Thinking (0s · esc to interrupt)` above it.
  A composer-visible check therefore reads a running turn as ready.

## Findings

### F1 — cursor: `src/runLoop.ts` is missing from the file map, though the plan adds new refusal codes (blocking)

- **Plan claim:** the Exact File List says `src/tmux.ts` will "add any new Muse-specific `PromptBlockedReason` union members". `src/runLoop.ts` is not in either file list.
- **Rule:** every refusal code needs an operator rationale in `DEFERRAL_RATIONALE`. The code's own comment says "Every code in `GateReason` and `PromptBlockedReason` has an entry". Every path the implementation changes must be in the file map.
- **Failure if followed:** Muse turn-chrome, no-prompt and draft refusals are journaled and printed as "the terminal refused delivery" and counted as unrecognized codes. An ordinary running Muse turn then looks like a delivery fault. Fixing that requires a plan amendment because `runLoop.ts` is outside the map.
- **Correction:** add `src/runLoop.ts` to the file list, limited to rationale entries for the new codes.

### F2 — cursor: no recapture immediately before the Muse key batch

- **Plan claim:** the `src/tmux.ts` adapter section adds a Muse readiness case and a draft refusal in `proofRefusal`. It does not change the `send` recapture, which today runs only for Claude and Codex.
- **Rule:** for a vendor where Enter steers an active turn, the busy and draft checks must be re-proven right before the keys are reserved and sent. The initial capture alone is not enough.
- **Failure if followed:** the first capture shows an idle composer. The owner then submits a prompt or types a draft, or a queued turn starts, before the batch runs. `send` sends the action text and Enter without a recapture. Either the action is steered into the running turn or it is appended to the owner's draft and submitted with it, which is exactly what the issue forbids.
- **Correction:** include `muse` in the `send` recapture condition (both the codex and claude plans do this), and add one test where the final capture shows a draft or turn chrome.

### F3 — cursor: the issue's recovery requirements have no test

- **Plan claim:** Tests §5 in the cursor plan covers JOIN and one ready-authorized send, plus pull non-degradation.
- **Rule:** issue requirement 4 says to "check watchdog, bounded resend, delivery uncertainty, and owner recovery behavior with no Muse lifecycle hooks or transcript reader". The existing vendor-parameterized tests are the cheap way to show this (`test/runLoop.test.ts:1286`, `:2793`, `:4549`).
- **Failure if followed:** a Muse-specific regression would pass the plan's tests. One example is a watchdog resend that keeps firing because the Muse pane digest is static mid-turn, or a mid-send failure that never charges `delivery-uncertain`. That leaves requirement 4 asserted only by the live run.
- **Correction:** add `"muse"` to the existing quiet-minute resend, owner-hold-release and partial-send cases, with no `working()` hook simulation.

### F4 — cursor: the composer glyph is left unmeasured, and "extend `COMPOSER_LINE`" may change other vendors

- **Plan claim:** "Extend `COMPOSER_LINE` and/or Muse-specific composer parsing with the **measured** idle composer glyph."
- **Rule:** shared pane predicates must not change for other vendors unless the change is needed. Muse's measured composer is `❯`, which `COMPOSER_LINE` already contains.
- **Failure if followed:** an implementer who widens the shared `COMPOSER_LINE` for a guessed Muse glyph changes which line `pendingPromptInComposer` and `paneActivityDigest` treat as the composer for Claude, Antigravity and Cursor. That moves their watchdog digest boundary and their pending-prompt detection.
- **Correction:** state that `COMPOSER_LINE` is unchanged and put Muse-specific tail parsing in a private helper.

### F5 — cursor: the mitigation for a missing Muse executable rests on a check doctor does not do

- **Plan claim:** Risks says "doctor continues to report a missing Muse executable/launcher".
- **Rule:** a risk's mitigation must name a check that exists. Doctor checks only the launcher file (`src/doctor.ts:408–412`).
- **Failure if followed:** a user without Muse runs default onboarding, and doctor is clean. `coord <issue>` launches `start-muse.sh`, `exec muse` fails, and the pane dies into a `harness-gone` hold. The plan's stated safeguard never fires. This is the same failure the default four-agent roster already has for a missing `agy`, so it does not block the plan. The claim is simply wrong.
- **Correction:** drop or correct the claim. The explicit `--agents` list and `coord start`'s version-collection warning are the existing signals.

### F6 — codex: explicit Muse reminders would break the documented owner-reminder contract

- **Plan claim:** Reuse §2 in the codex plan: "Explicit Muse reminders reuse the composer/busy guard and submit-only recognition."
- **Rule:** `src/cli.ts:405` says owner reminders "bypass readiness, spacing and send limits", and `test/tmux.test.ts:1520` asserts it per vendor. The issue's draft protection is about automatic delivery. It does not ask for owner-authorized sends to be refused.
- **Failure if followed:** an owner sees Muse stuck behind stale `(… esc to interrupt)` chrome after a crash, or with a leftover partial prompt that has a wrong digest, and presses remind. Muse alone refuses the send. The owner's documented terminal recovery route is then gone for exactly the stuck states it exists for. The help text and the cross-vendor reminder test become false for Muse.
- **Correction:** leave `remind()` unchanged. If a Muse-specific owner-reminder rule is truly wanted, it needs its own issue and a help-text change.

### F7 — codex: the new integration "publication canary" covers no Muse-specific code

- **Plan claim:** the file map and Tests in the codex plan add a Muse lane to `test/integration.test.ts` that reaches a response-mode ballot. The plan concedes that "its fake terminal is explicitly not the live transport proof".
- **Rule:** add the fewest focused tests that fail before and pass after. Git-mode and private-response acceptance (`consumeCompletion`, `writeAgentResponse`, `consumeReady`) has no agent-id branch, and the existing private-response test (`test/runLoop.test.ts` around line 3020) already covers it.
- **Failure if followed:** the e2e suite grows a multi-agent lane, and with it the cost of the coordinator-owned `pnpm check`. The new lane can fail only through the same terminal-adapter paths the unit tests already cover. It cannot fail because of anything Muse-specific in publication, so it adds maintenance cost and no new guarantee. The issue's Git/private-response demonstration is a live requirement, and a fake terminal cannot meet it.
- **Correction:** drop the `test/integration.test.ts` lane and prove publication live, as all three plans already require.

### F8 — codex: the `DoctorReport` informational field is a schema addition the issue does not require

- **Plan claim:** the codex plan says to "add a small informational field to `DoctorReport` and render it without contributing to `exitCode`".
- **Rule:** avoid speculative flexibility. Requirement 3 asks doctor to stop blocking Muse and to report unavailable hook/containment evidence accurately. `coord status` already reports Muse hook coverage as `unverified` through `containmentCoverage` (`src/issueReport.ts:233`).
- **Failure if followed:** every caller and renderer of `DoctorReport` (onboard, `coord doctor`, and their tests asserting "no findings") must handle a new output class. The containment state then lives in two places. Doctor's version is install-time and unprobed, while status uses probe-based evidence. The two can disagree after a probe.
- **Correction:** this is not blocking. A one-line static note in the Muse docs, with status as the live source, gives the same accuracy without the schema change. If the field stays, its text must not claim anything a probe can contradict.

### F9 — codex: the run-loop test list re-tests agent-neutral paths under a Muse label

- **Plan claim:** in the codex Tests, Run loop asks to "cover both receipt/order arrival orders and completion by rereading a replacement", and to parameterize "static-busy, idle-stalled, changing-pane, blank-capture, draft and pending-prompt states".
- **Rule:** prefer extending the existing parameterized cases and add only cases that exercise Muse-specific behavior.
- **Failure if followed:** receipt ordering, reread pickup and blank-capture bounding are already vendor-neutral and covered (`test/runLoop.test.ts:1679`, `:4604`). Re-running them for Muse fails before the change only because of the foreground mismatch. That is one cause, and one case already covers it. The test change becomes large and duplicative without catching a different defect.
- **Correction:** this is not blocking. Keep the Muse cases to JOIN plus successive ready handoffs, quiet-minute resend, owner hold release, partial-send uncertainty, and pane draft/busy refusal.

### F10 — claude (self-review): `museComposer` ignores lines below the footer

- **Plan claim:** in the claude `src/tmux.ts` section, `museComposer` returns `null` only "when there is no composer or no rule". Lines after the rule are not inspected.
- **Rule:** an unknown screen fails closed.
- **Failure if followed:** if Muse paints a popup or menu below the status footer (a slash-command list, for example, which was not measured), the parser still sees "composer, then rule" and reports the pane ready. The batch's text then goes into the popup.
- **Correction:** require that everything after the rule is at most the single measured status-footer line. Anything else gives `muse-no-prompt`.

### F11 — claude (self-review): the frozen-roster requirement relies on reading the code, with no test

- **Plan claim:** Reuse and Scope says snapshots keep their roster because `coord start` copies agents into `start.json` (`src/cli.ts:1234`).
- **Rule:** the issue lists "existing issue snapshots must retain their frozen roster" as acceptance.
- **Failure if followed:** nothing fails today. But nothing pins this either: a later change that makes resume re-read config agents would silently add Muse to an in-flight four-agent issue, and no test would notice.
- **Correction:** this is not blocking. Add one assertion where an issue started before default re-onboarding still resumes with its original four agents. The codex plan proposes this.

## Conclusion

- **claude** (`4aefc91e`): implementable as written, with F10 and F11 folded in.
  Its pane measurements (`muse-bin-1.4.10`, the `❯` composer, and
  `(… esc to interrupt)` chrome during a turn) are what the readiness rule
  depends on.
- **codex** (`ae92f754`): implementable once F6 is fixed, because it reverses a
  documented owner contract. F7–F9 are scope and test-volume expansions to cut.
  Its stricter full-prompt pending check and its frozen-roster test are sound
  additions.
- **cursor** (`f372678b`): the design is right but under-specified. F1 (missing
  file-map entry) and F2 (no pre-send recapture) must be fixed before
  implementation. F3 leaves requirement 4 without tests.

No plan adds new product files, hooks or dependencies, and none falls back to
pull delivery. All three keep live Muse verification mandatory.
