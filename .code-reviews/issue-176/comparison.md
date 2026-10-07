# Implementation comparison — issue 176

Bound pins:

- claude `5461bac8a5165f2a7fc1c0deee3e7739de52fb98`
- cursor `174754e30bd40cb6fd98e6fa12a8fc71374f3eff`
- codex `5aa03e9cdd09627a81b41e9f4baa8ee61cce8dbc`

## Comparison

All three pins implement the selected plan’s core: a first-send `staleWorking` exception that requires a Codex-aware `COORD-IDLE` sentinel (`requireIdleSentinel`), a `codex-turn-chrome` veto, `lifecycleOverride: "working"` journaling, docs updates, and focused `tmux`/`runLoop` tests. None fabricates lifecycle `idle`. Product changes stay inside the approved map (`src/tmux.ts`, `src/runLoop.ts`, `docs/readiness-policy.md`, matching tests).

They diverge on safety around that exception.

### 1. Cursor: owner draft accepted as idle proof (blocking)

- **Where:** `src/tmux.ts` lines 112–145 (`codexTrailingAllowlisted` / `sentinelAtTail`) in pin `174754e30bd40cb6fd98e6fa12a8fc71374f3eff`.
- **Rule:** A recovery that overrules lifecycle `working` must not append into or submit an unsent owner composer draft; a `›` prefix alone is not an empty prompt (`injectionGate` does not see ordinary typing).
- **Failure:** Pane shows `• COORD-IDLE: …` then `› Please inspect my uncommitted changes` plus allowlisted footers. Cursor treats that as `idle-sentinel`, `deliver` sets `requireIdleSentinel`, and the nudge is typed after the draft then submitted with it.
- **Test:** Assert `harnessPromptReadiness` returns non-`idle-sentinel` for a non-dim / non-placeholder composer after the sentinel (claude pin already covers this around `test/tmux.test.ts` ~758).

Claude (`5461bac8…`) requires `codexComposerEmpty` via SGR dim detection (`src/tmux.ts` 130–167). Codex (`5aa03e9c…`) requires an empty composer or the exact placeholder via `codexIdlePane` (`src/tmux.ts` 115–133). Both close this hole.

### 2. Cursor: no mid-send freshness check for the override (blocking)

- **Where:** `src/tmux.ts` `nudge` ~912–949 in pin `174754e30bd40cb6fd98e6fa12a8fc71374f3eff` — `requireIdleSentinel` is checked once after the initial capture; the per-key `send` path does not recapture for Codex/override.
- **Rule:** An exception to a `working` veto must be revoked if the pane (or correlated lifecycle) becomes active before keys are reserved or between keys.
- **Failure:** Initial capture passes with a fresh sentinel; before the first key the owner submits a new turn (Codex stays foreground, copy mode clear). Cursor still types into that turn.
- **Test:** Scripted runner where the second `capture-pane` shows `Working (… esc to interrupt)` before reservation; expect zero literal sends / busy `codex-turn-chrome`.

Claude rechecks at every key when `requireIdleSentinel` (`src/tmux.ts` 977–985). Codex rechecks pane plus a `deliveryState` lifecycle snapshot (`src/tmux.ts` 954–974; `src/runLoop.ts` ~1108–1126).

### 3. Claude vs Codex scope and coupling

- **Claude** (`5461bac8…`): Closest to the selected plan plus the two necessary safety closures above. `staleWorking` applies to any agent with `safety.sends === 0` and never-sent action identity (`src/runLoop.ts` 1094–1096). Mid-send recheck after typing only refuses live chrome (composer may hold this nudge’s text). Focused tests in existing files. Operator log names missing `COORD_ISSUE` without expanding into launcher/routing product changes.
- **Codex** (`5aa03e9c…`): Same recovery plus empty-composer and race handling, but Codex-only `staleWorking` (`src/runLoop.ts` 1092), placeholder-string empty detection (weaker than Claude’s dim-SGR empty if the placeholder copy changes), `lifecycle-changed` busy reason, and vim-insert prelude skipping. Larger behavioral surface than the selected plan; still within approved paths. The pin also carries a plan-amendment-request signal (routing/`--no-daemon`) that is out of this comparison’s product map.

### 4. Reuse, files, tests

All three reuse `harnessPromptReadiness`, `deliver` / `maybeLifecycleNudge`, and existing test fixtures; create no new product modules. Cursor’s tests miss draft and mid-send cases. Claude and Codex add them. Cursor’s literal plan match is under-specified for safe recovery; Claude is the smallest complete safe pin; Codex is safe but heavier.

### Verdict

Prefer **claude `5461bac8a5165f2a7fc1c0deee3e7739de52fb98`**: implements the selected first-send override, closes owner-draft and mid-send races, stays focused. Reject cursor `174754e30bd40cb6fd98e6fa12a8fc71374f3eff` for the draft and freshness failures above. Codex `5aa03e9cdd09627a81b41e9f4baa8ee61cce8dbc` is an acceptable alternate if reviewers want Codex-only gating and lifecycle snapshots, but it is not smaller.

Checks for this comparison: read the three bound worktrees’ `src/tmux.ts`, `src/runLoop.ts`, and the related test regions cited above. No product suite was run (evidence-only artifact).
