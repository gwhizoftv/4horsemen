# Issue 181 — plan review (cursor)

Reviewed bound pins:
- claude `e5799ab1db49b0bb61d8d333b1c515c4d378a50a`
- cursor `849745d7cee1911d5ce7f0d5d12d87a2de3e39c8`
- codex `ea32c444439647a453ad05ebd45ea135a5237dce`
- antigravity `9fa11cb87b296c072d853f13b218897c25231b55`

## Findings

1. **Cursor plan — Exact File List / Goal (Codex ready-file stall).** The plan
   attributes `codex-composer-not-ready` to a wrapped dim placeholder and
   post-turn `Worked for …` chrome, and never names the live footer line
   `← for agents · ? for shortcuts`. Rule: a ready-file Codex send must pass
   `codexTail(..., false)`, which requires every post-composer footer line to
   match `CODEX_FOOTER` (`src/tmux.ts:130`, `/^(?:\?\s+for shortcuts|…)/`).
   Failure if followed as written: the observed footer still fails
   `footer.every(...)`, `codexSentinelAtTail` stays false, and file-backed
   delivery keeps deferring with `codex-composer-not-ready` even after wrapped-
   placeholder and `Worked for` work. Smallest correction: adopt Claude/Codex’s
   anchored optional `← for agents ·` prefix on the shortcuts footer (and keep
   the single allowlisted turn-summary skip).

2. **Cursor plan — Reuse and Scope / Tests (Antigravity + `unknown`).** The plan
   widens scope to Antigravity sentinel-above-prompt and never-sent lifecycle
   `unknown` parity with stale `working`. Rule: the issue’s stall must be fixed
   from correlated evidence; peer journal/analysis shows Antigravity’s review was
   already injected and later accepted/idle, while Codex alone remained blocked
   on pane predicates. Failure if followed as written: product work expands into
   `runLoop.ts` lifecycle policy and non-Codex sentinel rules that do not unblock
   the reported ready-file Codex stall, increasing regress risk without fixing
   the footer mismatch. Smallest correction: keep Antigravity/`unknown` out of
   the change map unless a plan amendment cites a failing never-sent case after
   the Codex parser fix.

3. **Antigravity plan — Exact File List (`src/agentEvent.ts`) / Scope item 3.**
   The plan defaults omitted Antigravity `fullyIdle` to true so Stop yields
   `backgroundActive: false`. Rule: missing evidence must fail closed for
   background work; today’s `boolField(...) ?? false` treats an omitted flag as
   not-idle (`src/agentEvent.ts:224-230`). Failure if followed as written: a Stop
   payload that omits `fullyIdle` while background tasks still exist would be
   marked idle/allowInjectedIdle and could authorize a nudge into unfinished
   work. Smallest correction: drop the `agentEvent.ts` change unless a captured
   Stop payload proves the field is absent on a truly idle harness.

4. **Antigravity plan — Exact File List (`src/runLoop.ts`) / Tests item 3.**
   The plan suppresses `nudge-deferred` / “waiting to send” for already-injected
   `working` actions. Rule: issue 181 requires automatic delivery of the next
   action past a false scrape refusal, not quieter journals. Failure if followed
   as written: Codex still fails `codexTail` on the agents-prefixed footer, so
   the owner still has to type `continue`; only the noise around healthy
   mid-turn waits changes. Smallest correction: omit the logging change from
   this issue; fix `CODEX_FOOTER` + turn-summary parsing (and their tests) only.

5. **Claude and Codex plans — scope and evidence (positive).** Both keep the
   change map to `src/tmux.ts`, `test/tmux.test.ts`, and (Claude) policy docs /
   (Codex) focused `runLoop` regression fixtures without altering lifecycle
   override selection. Rule: reuse existing Codex parser helpers and fail closed
   on unknown chrome. No concrete failure found in their footer-prefix + single
   `Worked for …` allowlist approach; Codex’s insistence on exercising the same
   layout through per-key hold/submit paths matches `nudge`’s shared `codexTail`
   usage. Prefer that narrow map over Cursor/Antigravity expansions.

## Conclusion

**revise** Cursor and Antigravity; **accept** Claude and Codex as implementation
candidates. The actionable root cause is Codex chrome drift: shortcuts footer
now begins `← for agents · ? for shortcuts`, which breaks `CODEX_FOOTER`, and a
`Worked for …` turn-summary sits between COORD-IDLE and `›`. Plans that do not
fix that footer predicate cannot clear the ready-file stall; Antigravity
`fullyIdle` default flipping and deferral-log suppression are out of issue scope
and weaken fail-closed behavior. Implement from Claude/Codex’s tmux-parser map
(optional agents prefix, one anchored turn-summary skip, fixtures/near-misses,
readiness-policy note), and do not expand into lifecycle `unknown` or
Antigravity Stop defaults without a separate evidenced amendment.
