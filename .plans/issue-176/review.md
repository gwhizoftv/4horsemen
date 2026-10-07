# Plan review — issue 176, including issue 174

Reviewed the exact bound plans:

- Claude: `7fa11abb8c9f49ae44bf9891bd9e9933024bb612`.
- Codex: `d039ad6d99dded4c7188eb3558d64f8889683046`.
- Cursor: `d1bf5b904a25b5372904fbec43faac67df8c0220`.

## Findings

### 1. [P1] Cursor: accepting an artifact does not end the agent's turn

**Plan claim:** “Approach,” the `src/agentLifecycle.ts` file-map entry, and “False idle after complete” prescribe changing inherited working/queued to idle, clearing the turn ID, and incrementing the idle epoch when a successor is ordered after workflow completion.

**Rule:** Workflow completion proves the artifact or response was accepted; it must not erase a real working observation or authorize typing into a turn that has not ended. The protocol expressly requires the agent to reread the action after writing completion and immediately execute a successor if present.

**Concrete failure:** The coordinator accepts A while the agent is still performing that required reread. It orders B and the proposed change sets execution to idle. Initial delivery now proceeds even though A's turn is active. The unchanged Codex readiness branch (`src/tmux.ts:180`) accepts even a Working/esc-to-interrupt pane, so B is typed into an active turn. This does not require an agent to violate the protocol; the risk section's claim that publishing completion before the turn ends is already a protocol violation is incorrect. The generic lifecycle change also exposes other vendors to the same fabricated transition.

Keep actual execution/turn/epoch evidence intact. Test the completion-to-reread interval with visible busy chrome, not just an unfinished artifact. Any recovery must separately establish current readiness and must not create duplicate-delivery authority.

### 2. [P1] Claude: the allowed composer line includes the owner's unsent draft

**Plan claim:** The `src/tmux.ts` file-map entry allows any one line starting with `›` below the idle sentinel, and the risk mitigation says the existing injection gate vetoes owner typing.

**Rule:** Recovery must not append a coordinator command to an existing owner draft or submit that draft. A prompt prefix alone does not prove an empty composer.

**Concrete failure:** The pane contains the previous idle sentinel followed by `› Please inspect my uncommitted changes` and the allowed footer. No new transcript item or turn chrome appears because the owner has not submitted the draft. The proposed allowlist accepts this as idle-sentinel evidence and the stale-working override sends the coordinator text into that existing draft, then submits it. `inspectPane` maps `ownerTyping` from tmux `pane_in_mode` (`src/tmux.ts:810–819`); ordinary text entry has that flag clear, so the cited gate does not protect this case.

Require a positively empty composer or an exact supported placeholder before typing. Add the draft case to the proposed tmux tests and assert zero text and submit keys.

### 3. [P1] Claude: the recovery proof can become stale before any key is sent

**Plan claim:** “Reuse and Scope” says using the capture already taken by `nudge` means there is no race window; the file map adds the sentinel requirement only to that initial readiness check.

**Rule:** An exception to a working veto must be revoked when fresh pane or lifecycle evidence shows a new active turn before injection. Foreground-process and tmux-mode checks do not substitute for that evidence.

**Concrete failure:** The first capture passes the sentinel rule. Before the first key, an owner submits a new prompt; Codex remains the foreground process with copy mode and input-off both clear. The new prompt hook updates lifecycle, but the supplied `assertAuthority` callback checks cursor authority, not lifecycle revision. `nudge` does not recapture Codex at its send boundaries (`src/tmux.ts:903–915`). All later gates therefore pass, and the coordinator types into the new turn. A similar transition during the existing 300 ms delay permits an unsafe submit. The new busy-pattern check is never called on the changed pane.

Add a scripted runner/lifecycle race case in which the pane becomes busy after initial capture. Revalidate before sending; if uncertainty arises after keys have begun, retain the existing reservation/hold behavior. The readiness checks must distinguish the coordinator's own draft from new owner input, as finding 4 explains.

### 4. [P1] Codex: the empty-prompt rule rejects the coordinator's own nudge before submission

**Plan claim:** “Implementation sequence,” item 4, requires a recognizable empty Codex prompt and rechecks Codex readiness before the first keystroke and subsequent sends.

**Rule:** Readiness must distinguish a pre-existing owner draft from the exact text the coordinator just typed. A valid delivery must be able to reach its submit key without treating its own expected state changes as interference.

**Concrete failure:** The initial empty prompt passes. The literal-send step types the action command. After the prescribed delay, the composer is now nonempty because it contains that command. Applying the same empty-prompt readiness check before C-j/C-m rejects the coordinator's own draft. Since a send was already reserved, the proposed uncertainty handling can turn a normal delivery into a delivery-uncertain hold every time. Rechecking an unqualified zero-send eligibility predicate after taking the reservation creates the same problem for the coordinator's own send-count change.

Specify checks by send stage: require an empty/placeholder composer before the first write; before submission validate the exact owned nudge buffer and unchanged external safety evidence, allowing the reservation and text changes made by this attempt. Cover a successful full text-and-submit sequence as well as external edits and active-turn transitions. This corrects the Codex plan itself; it is not permission to weaken the draft protection in finding 2.

### 5. [P2] Cursor: the proposed lost-delivery branch cannot actually retry a working entry

**Plan claim:** The `src/runLoop.ts` file-map entry adds working to lost-delivery eligibility, reuses `markInjectedActionAbsent`, and explicitly leaves the hard working veto in `deliver` unchanged.

**Rule:** If a recovery is included in the plan, its specified state transition and send path must produce the promised behavior; a test that merely observes entry into a branch is insufficient.

**Concrete failure:** For the proposed case—an injected, uncorrelated, unfinished working action—`markInjectedActionAbsent` changes only the action record to ordered (`src/agentLifecycle.ts:354–388`). It preserves execution as working. `maybeLifecycleNudge` then calls `deliver`, whose unchanged working guard immediately returns (`src/runLoop.ts:1089`). The action is not resent and remains stuck. The order-time completion reset does not apply because this action is unfinished. The suggested assertion that the “retry path runs” can pass while no prompt is delivered.

Remove this optional extension from the missing-Stop-after-completion fix, or specify a separately justified safe end-to-end behavior and assert actual delivery. Do not simply relax the working gate: the existing Codex scraper does not prove a turn is idle, as finding 1 demonstrates.

## Conclusion

**Revise all three bound plans before implementation.** Claude needs draft protection and freshness checks around the new override; Codex needs an explicit distinction between pre-write readiness and validation of its own in-progress send; Cursor must stop treating accepted completion as idle and remove or repair its ineffective lost-delivery extension.

All three reuse existing modules and test support and propose no new product files or dependencies. Claude has the smallest file map and focused cases, but its positive readiness proof is incomplete. Cursor's smaller scope is reasonable, but its tests encode a false idle transition and permit a no-op recovery assertion; also list the two intended test files explicitly in its changed-file list. Codex's wider map includes the owner-requested issue-174 launch/reread concerns and relevant negative cases, but it must retain an executable successful-send path. No separate blocker arises from keeping Stop observational or declining to restart a shared vendor server automatically.

Validation performed for this review: read all three materialized plans and the existing lifecycle, run-loop, tmux, and protocol paths. Ran one read-only in-memory diagnostic using the existing built tmux helpers and a fake runner; it confirmed that baseline Codex busy chrome is treated as ready and that a nudge makes only one Codex capture before sending. No real tmux commands were executed by that diagnostic. This is evidence for the identified dependencies, not verification of any future implementation. No product suite was run for this evidence-only review.
