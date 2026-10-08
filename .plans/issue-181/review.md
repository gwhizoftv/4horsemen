# Plan Review — Issue 181

## Findings

### 1. Cursor: Footer prefix omitted from `CODEX_FOOTER` causing persistent scrape stall
- **Plan claim or section:** `## Exact File List to be changed or deleted` and `## Tests`, which claim the cause of `codex-composer-not-ready` is "a wrapped dim placeholder across two composer lines" and propose treating a wrapped dim placeholder as empty.
- **Rule that must hold:** The pane tail parser must recognize the actual structural footer layout rendered by Codex CLI (`← for agents · ? for shortcuts ⚠ 1 warning · f2 to view`), so that `codexTail` correctly separates the composer from the footer and recognizes an empty composer.
- **Concrete failure:** The actual cause of `codex-composer-not-ready` in Issue 161/181 is that `CODEX_FOOTER` (`src/tmux.ts:130`) only matches lines beginning with `? for shortcuts` or `Context ... left`. Because Codex's second footer line begins with `← for agents ·`, `codexTail` (`src/tmux.ts:188`) fails `footer.every((line) => CODEX_FOOTER.test(line.plain))` and returns `null`. `codexSentinelAtTail(paneText, false)` evaluates to `false` even for a single-line empty composer, deferring delivery with `codex-composer-not-ready`. If Cursor's plan is implemented as written without updating `CODEX_FOOTER`, every ready-file delivery to Codex will continue to be rejected with `codex-composer-not-ready`, leaving Codex completely stalled.
- **Smallest correction:** Update `CODEX_FOOTER` in `src/tmux.ts` to match the optional `← for agents ·` (or `[·•]`) prefix before `? for shortcuts`.

### 2. Cursor: Unnecessary modification to `runLoop.ts` lifecycle gate for `unknown`
- **Plan claim or section:** `## Exact File List to be changed or deleted` and `## Scope and Reuse`, proposing to change `src/runLoop.ts` to "treat lifecycle `unknown` like stale `working`: do not lifecycle-defer a never-sent ordered action when file or terminal idle proof can still be attempted in `deliver()`".
- **Rule that must hold:** Modifications must address the actual point of failure rather than widening lifecycle delivery gates unnecessarily. File-backed readiness already bypasses lifecycle wait states (`src/runLoop.ts:1819`) when a valid `ready` receipt exists.
- **Concrete failure:** In the Issue 161 journal (e.g. sequence 446, 700, 3044), delivery to Codex was never deferred at the lifecycle layer; `maybeLifecycleNudge` recognized `fileReady === true` and invoked `deliver()`, where the attempt was rejected at the scrape layer with `codex-composer-not-ready`. Modifying `maybeLifecycleNudge` in `src/runLoop.ts` does nothing to fix the scrape failure and risks triggering duplicate injection attempts for agents with unobservable hooks when no valid file or terminal proof exists.
- **Smallest correction:** Leave `src/runLoop.ts`'s lifecycle gate unchanged and restrict the fix to the terminal scrape predicates in `src/tmux.ts`.

### 3. Claude: Footer middle dot delimiter character class
- **Plan claim or section:** `## Exact File List to be changed or deleted`, proposing `CODEX_FOOTER = /^(?:(?:←\s+for agents\s+·\s+)?\?\s+for shortcuts|Context \d+% left|\d+% context left)/`.
- **Rule that must hold:** Terminal regex patterns must tolerate minor punctuation variations across terminal emulators, UTF-8 decoders, and Codex versions.
- **Concrete failure:** Claude's regex strictly matches only the middle dot character `·` (`\u00B7`). If a terminal capture or font rendering represents the separator as a bullet `•` (`\u2022`) or a bullet preceded/followed by flexible whitespace, the footer line will fail to match `CODEX_FOOTER`, causing `codexTail` to return `null` and triggering `codex-composer-not-ready`.
- **Smallest correction:** Use `[·•]` instead of literal `·` in the separator: `/^(?:(?:←\s+for agents\s+[·•]\s+)?\?\s+for shortcuts|Context \d+% left|\d+% context left)/`.

### 4. Claude and Codex: Helper placement for completed turn summary
- **Plan claim or section:** Both Claude and Codex propose skipping the completed turn timing summary (`Worked for ...`) between the idle sentinel and the composer.
- **Rule that must hold:** The turn summary line must be removed from `linesAfterCodexSentinel` so that all downstream consumers (`codexTail`, `codexSentinelAtTail`, and `codexNudgeSubmitted`) receive a clean slice starting with the composer.
- **Concrete failure:** If the summary line is skipped only inside `codexTail`, `codexNudgeSubmitted` (`src/tmux.ts:212-230`) will still receive `Worked for ...` as `transcript[0]`, failing `transcript[0]?.plain.startsWith("›") === true`. This would cause post-submit acceptance verification to fail, resulting in an unneeded fallback `C-m` key being sent into an already running turn.
- **Smallest correction:** Filter the leading turn summary line directly in `linesAfterCodexSentinel`, as proposed by Claude, ensuring `codexNudgeSubmitted` and `codexTail` share the fix.

## Conclusion

Both Claude's plan (`e5799ab1db49b0bb61d8d333b1c515c4d378a50a`) and Codex's plan (`ea32c444439647a453ad05ebd45ea135a5237dce`) correctly identify the true root causes of the Codex stall: the missing `← for agents ·` footer prefix in `CODEX_FOOTER` and the intermediate `Worked for ...` timing line breaking sentinel detection in `linesAfterCodexSentinel`. Claude's plan provides the cleanest architecture by filtering the turn summary directly in `linesAfterCodexSentinel`, fixing both idle detection and post-submit confirmation with minimal churn.

Cursor's plan (`849745d7cee1911d5ce7f0d5d12d87a2de3e39c8`) completely misses the `CODEX_FOOTER` prefix mismatch—the primary cause of the `codex-composer-not-ready` stall—and unnecessarily alters `runLoop.ts` lifecycle logic that was not the failure point.

Claude's plan is recommended, with the minor enhancement of using `[·•]` for the footer delimiter.
