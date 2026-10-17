# Issue 235 plan review

Reviewed the exact exported plans and verified their bytes against the bound manifest:

- Cursor: `f372678b802f7b8cba21e5d325ee15f7132244bf`, `.plans/issue-235/plan.md`.
- Claude: `4aefc91e7638ee270c8b4d86da4db867f899dc1b`, `.plans/issue-235/plan.md`.
- Codex: `ae92f75414b10cc9863c28688ba7336b741fb2da`, `.plans/issue-235/plan.md`.

## Findings

1. **[P2] Cursor and Claude: pending-prompt reuse can submit an owner draft or stale action text.**

   **Plan claim:** Cursor's `src/tmux.ts` file-map entry and Tests item 4 exempt a pending action ID from draft refusal. Claude's `src/tmux.ts` entry and Reuse and Scope explicitly preserve `pendingPromptInComposer` unchanged and use it to exempt a nonempty Muse composer.

   **Rule:** Issue 235 requires preventing submission of owner drafts and preserving duplicate-send protection. Submit-only recovery must establish that the active composer contains the current coordinator prompt, including its current digest/path, rather than merely mentioning its UUID.

   **Concrete failure:** The reused helper at `src/tmux.ts:195` searches for an action-ID substring in the composer tail. With the current UUID, `❯ Please investigate action <UUID>, but do not send this draft yet` returns true. The proposed draft exception therefore permits the automatic Enter to submit that owner draft. Likewise, a pending prompt with the same UUID but an obsolete digest remains eligible after a same-action reissue, so the coordinator submits stale instructions while recording delivery of the current digest. Read-only probes against the existing helper confirmed both inputs return true; an unrelated draft returns false. Adding Muse's measured glyph and empty-composer parser does not fix this identity check.

   **Smallest correction:** Restrict Muse's submit-only exception to the parsed active composer containing the full rendered current prompt, allowing its known resend prefix and measured line wrapping. Add focused cases for an owner draft mentioning the UUID and a same-UUID/wrong-digest prompt; neither should send keys. Keep other vendors' behavior outside this change.

2. **[P2] Cursor: the planned draft gate is checked too early to protect the send batch.**

   **Plan claim:** Cursor's terminal file-map entry adds Muse to `nudge()`'s `proofRefusal` but does not extend the pre-send recapture in `send`; its reuse section leaves the existing send path in place.

   **Rule:** The issue's owner-draft and running-turn protections must apply at the last available pane observation before automatic injection, as the existing Codex/Claude path already does. The initial capture cannot serve as evidence that the composer is still empty after the next asynchronous pane inspection.

   **Concrete failure:** An initial Muse capture shows an empty composer; before the key batch, the owner starts a draft or Muse starts a turn. `injectionGate` only checks process, pane life, copy mode and input enablement. The existing recapture branch at `src/tmux.ts:1244` covers Claude and Codex, so Muse is not recaptured. The planned initial `proofRefusal` succeeds and the batch appends/submits the owner's text or steers the newly running turn. A read-only stub-transport probe confirmed the current Muse path makes one capture and sends one batch even when the next capture would contain a draft.

   **Smallest correction:** Include Muse in the final recapture protection and choose the empty-versus-pending send operation from the latest validated composer. Add one transition test where the first capture is empty and the pre-send capture contains a draft, plus the busy variant; both must refuse before reservation. Claude's plan already explicitly includes Muse in this recapture branch.

3. **[P3] Cursor and Claude: the focused test command omits the onboarding and installer suites it names.**

   **Plan claim:** Both Tests sections prescribe `pnpm vitest run` with `test/onboard.test.ts`, `test/install.test.ts`, `test/doctor.test.ts`, `test/tmux.test.ts` and `test/runLoop.test.ts` under the default configuration.

   **Rule:** Named verification commands must actually select the suites they claim to exercise. This repository separates filesystem-heavy tests into `vitest.system.config.ts`.

   **Concrete failure:** `vitest.config.ts` explicitly excludes `test/onboard.test.ts` and `test/install.test.ts`. Listing the five proposed paths with the default configuration selects only doctor, run-loop and tmux tests. The command can succeed without exercising default onboarding or generated Muse installation. The mandatory commit hook still runs the system tier later, so this is a focused-validation gap rather than a claim that final verification omits it.

   **Smallest correction:** Split the focused command by configuration:

   ```sh
   pnpm exec vitest run --config vitest.config.ts test/doctor.test.ts test/tmux.test.ts test/runLoop.test.ts
   pnpm exec vitest run --config vitest.system.config.ts test/onboard.test.ts test/install.test.ts
   ```

All three plans otherwise stay within the issue: they append Muse to both onboarding defaults, generate `both`, preserve explicit selections/frozen rosters, separate terminal delivery from lifecycle hooks, retain the existing launcher policy and require live verification. They reuse the existing terminal, installation and ready/complete machinery and existing test files. No new product file is proposed. Claude justifies its shared default-roster constant, terminal-capability predicate and two Muse parsing helpers; these are small additions tied to the required behavior. Its recorded live 1.4.10 observations are useful input, though the two trivial prompts do not establish publication or multi-action acceptance.

Cursor's narrower tests defer most recovery/publication evidence to its required live run; those results must actually be recorded, not inferred from the one follow-on stub case. Claude provides focused recovery parameterizations. Codex's broader file map adds explicit frozen-roster and publication integration coverage, and justifies its Muse reminder protection and nonfatal doctor information through the draft-safety and capability-reporting requirements. No blocking finding was identified in the bound Codex plan. Its live acceptance remains outstanding just as for the peers.

Verification for this review comprised bound-file SHA-256 validation, source/configuration inspection, two read-only terminal-helper probes with an in-memory transport, and `pnpm exec vitest list ... --filesOnly` for test selection. No product suite or live Muse session was run for this review; no coordinator-owned check is claimed.

## Conclusion

Request revisions to Cursor for findings 1 and 2, and to Claude for finding 1. Correct the focused commands in both plans as described in finding 3. The bound Codex plan is acceptable for implementation. Reuse Claude's measured Muse terminal facts where applicable, and retain the live Git/private-response publication and successive ready-driven handoff requirements regardless of which plan is selected.
