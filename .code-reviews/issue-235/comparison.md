# Issue 235 — implementation comparison

Bound implementation pins:

- codex `4c4dd97e1d9c54e597e725ec8f899baac010e992`
- cursor `5abfee0b150079ae6114db59a496907596639a22`
- claude `f0bd6aa4dda49e87de79992939f70a047f5f4ff7`

All three stay inside the issue: Muse is fifth in both onboard defaults, generated
with `delivery: "both"`, doctor accepts Muse automatic delivery via
`hasTerminalDeliveryAdapter` without lifecycle hooks, `remind()` stays ungated,
Muse is kept out of the Codex/Cursor mid-turn Enter bypass, pre-send recapture
includes Muse, and focused tests cover idle send, drafts, turn chrome, doctor,
onboard, and ready-driven run-loop paths. No pin invents a new product module or
falls back to pull-only delivery.

## Comparison

Shared strengths: full-prompt Muse pending checks (not bare UUID substring),
`DEFERRAL_RATIONALE` entries for the three Muse refusal codes, Escape+Enter pair
repair at least for Muse, and reuse of existing ready/complete delivery authority.

Material differences are in Muse terminal safety. Prefer **claude
`f0bd6aa4dda49e87de79992939f70a047f5f4ff7`** as the base winner (strongest Escape
policy + correct resend pending match), folding in Codex's stricter footer regex
and pending-flip recapture. Do not select cursor alone until its resend pending
bug is fixed.

### Findings

1. **cursor `5abfee0b150079ae6114db59a496907596639a22` — `src/tmux.ts:1263-1267` with `213-218`.**
   Rule: Muse submit-only recovery must recognize the full current action prompt
   whether or not this poll uses the resend prefix.
   Failure: with `resend: true`, `renderedPrompt` is only the RESEND-prefixed
   string. An original (non-prefixed) prompt still sitting in the composer fails
   `museComposerHoldsPrompt`, so `proofRefusal` treats it as a non-pending draft
   and the nudge retypes the resend text into that composer instead of Enter-only
   submit.
   Smallest illustrative test: Muse pane holding
   `❯ Read and execute coordinator action <id> digest <d> at /a` (no resend
   prefix); call `nudge(..., { resend: true })` and expect
   `detail: "pending-prompt-submitted"` with no `-l` send-keys. Claude
   (`tmux.ts:218-221`) and Codex (`tmux.ts:223-231`) already accept either form.

2. **codex `4c4dd97e1d9c54e597e725ec8f899baac010e992` — `src/tmux.ts:394-411` and cursor `5abfee0b` — `src/tmux.ts:407-415`.**
   Rule: Muse must never receive Escape (it interrupts a turn), including stale
   or hand-written config beyond the Escape+Enter pair.
   Failure: `nudgeSubmit: ["Escape"]` or Escape in `nudgePrelude` is still
   returned and sent. Only the exact two-key Escape+Enter pair is repaired.
   Smallest illustrative test: `resolveNudgeKeys({ id: "muse", nudgeSubmit: ["Escape"], ... })`
   yields Enter-only (and prelude without Escape). Claude already filters every
   Escape at `src/tmux.ts:405-408` and covers prelude Escape in
   `test/tmux.test.ts`.

3. **claude `f0bd6aa4dda49e87de79992939f70a047f5f4ff7` — `src/tmux.ts:187-192` and cursor `5abfee0b` — `src/tmux.ts:184-193`.**
   Rule: an unknown Muse tail (missing or non-status footer after the pure `─`
   rule) must fail closed as `muse-no-prompt`, not ready.
   Failure: a single unrecognized footer line after the rule still parses as a
   composer (Claude/Cursor only check footer count, not the measured
   `muse-… · …` status line). Cursor also accepts a missing footer
   (`below.length` 0 or 1). Either shape can authorize a send into an unknown
   screen.
   Smallest illustrative test: idle `❯` + rule + `unrecognized footer` →
   `harnessPromptReadiness` returns `muse-no-prompt` (Codex already asserts this
   around `test/tmux.test.ts` with footer regex at `src/tmux.ts:158`).

4. **Quality (prefer keep): Codex pending-flip on recapture — `src/tmux.ts:1296-1298`.**
   Rule: the send batch chosen from the first capture must still match the
   pending/empty decision on the final Muse recapture before keys are reserved.
   Failure if omitted: a draft or pending prompt appearing between captures can
   still send the wrong operation (type vs submit-only) even when
   `proofRefusal` would have blocked a fresh decision.
   Claude and cursor lack this guard; fold it into the winner.

### Scope and reuse

All three reuse `deliver` / `maybeLifecycleNudge`, existing test fixtures, and
the Muse launcher from #232. Doctor exemptions are adapter-based rather than a
broad unsupported-id warning. Cursor's pending coupling to `options.resend` is
the only correctness defect that can actively corrupt a quiet-minute recovery
send; Escape and footer gaps are config/chrome fail-open risks. No pin expands
into lifecycle hooks, remind gating, or a new `DoctorReport` schema.
