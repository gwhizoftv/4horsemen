# Issue 102 implementation comparison

## Comparison

Bound implementation pins:

- claude `62ed5b44096ddd622e9b8c1263faa6c21f429e5b`
- codex `176321636ce7660142c5a77f8be75701911c817a`
- cursor `ecc899ee10d92e7324106e056fd1f5ed34373013`
- antigravity `24106c134ae82a23917900374f300693c677774c`

All four pins implement the selected Claude plan’s spine: structured busy/gate reasons, `nudge-deferred` / `agent-observability-recovered` journal types, degrade-cause split with restart advice only for `hooks-never-seen`, workflow-complete health clearing, scrape-veto / hooks-duplicate-suppression policy docs, `COORD-IDLE` protocol line, and broadened lost-injection recovery still gated on `actionAbsentAtReadyPrompt`. They diverge on Cursor chrome anchoring, idle-sentinel freshness, and whether degrade cause is durable on the lifecycle entry.

### Cursor chrome false-busy (`\W` prefix) — cursor, antigravity

- **cursor** `src/tmux.ts:81-82` / `:101-102`: `CURSOR_TURN_CHROME_LINE` is `/^\s*\W{0,3}\s*(?:Thinking|Generating|Working|Running)(?:…)/im` and is applied per scrollback line.
- **antigravity** `src/tmux.ts:111-112`: the same `\W{0,3}` pattern is applied with the `m` flag across the whole pane text.
- **Rule:** Cursor in-flight chrome must not match plan/review prose such as a markdown bullet `- Thinking…` or `` `Thinking...` `` (selected plan A1; claude pin documents this at `src/tmux.ts:84-91` and uses spinner-only prefixes).
- **Failure:** An idle Cursor pane whose 40-line capture still contains a prior plan bullet starting with `- Thinking…` returns `cursor-turn-chrome`, so `nudge` stays `busy` forever while hooks report idle — the original issue-102 false-positive class returns under a different regex.
- **Test:** `expect(harnessPromptReady("- Thinking… about alternatives\nAuto · 1%\nRun Everything", "cursor")).toBe(true)` (claude’s pin already covers the quoted/bulleted case; cursor/antigravity do not).
- **Contrast:** claude `src/tmux.ts:92-93` (`inFlightStatusLine`) and codex `src/tmux.ts:96-100` (`cursorTurnChrome`) reject non-spinner prefixes; prefer either.

### Stale idle sentinel authorizes ready without action correlation — cursor, antigravity, codex

- **cursor** `src/tmux.ts:93`: if the last non-empty line equals `COORD_IDLE_SENTINEL`, readiness returns `{ ready: true, reason: "idle-sentinel" }` before any chrome check and without consulting `actionId`. `idleSentinelAfterAction` (`:131-136`) exists but is unused by `nudge` / `harnessPromptReadiness` (`:812`, `:819`).
- **antigravity** `src/tmux.ts:100-101`: same last-line short-circuit; `idleSentinelAfterAction` is only consulted inside `actionAbsentAtReadyPrompt` (`:802-803`), not on the ordinary send path (`:826`, `:835`).
- **codex** `src/tmux.ts:115` / `:132`: sentinel can return ready for Claude/Antigravity branches without correlating to the current action UUID; `idleSentinelAfterAction` (`:149-154`) is never called from `nudge` (`:824`, `:831`) or `actionAbsentAtReadyPrompt` (`:805`).
- **Rule:** The sentinel is additive positive evidence only when it is newer than the current action UUID; blockers and chrome still veto (selected plan; claude `src/tmux.ts:125-133`, `:867`).
- **Failure:** After action A completes and prints the sentinel, action B is injected; the 40-line capture still ends with A’s sentinel while B’s UUID sits above it. `nudge` for B treats the pane as idle-sentinel-ready and can type into a turn that has not finished accepting B — or, for cursor/antigravity, skip chrome that still sits above the stale tail line.
- **Test:** pane text `${actionB}\n…\n${COORD_IDLE_SENTINEL}` with `harnessPromptReadiness(text, "cursor", actionB)` must not report `idle-sentinel` when the sentinel precedes a fresher UUID (claude’s `idleSentinelAfterAction` contract).
- **Contrast:** claude threads `actionId` through `harnessPromptReadiness` / `harnessPromptReady` / `nudge` (`src/tmux.ts:125-133`, `:170`, `:867`).

### Degrade cause not durable on the lifecycle entry — cursor, antigravity

- **cursor** `src/agentLifecycle.ts:587`: `markObservabilityDegraded` sets `health: "degraded"` but does not store `degradedCause` on the entry; `src/issueReport.ts:61-76` reconstructs the alert by scanning the journal for the newest `agent-observability-degraded` event.
- **antigravity**: no `src/issueReport.ts` change at all (diff vs baseline empty); lifecycle likewise stores only `health` (`src/agentLifecycle.ts` degrade path returns `{ ...entry, health: "degraded" }` without a cause field).
- **Rule:** Selected plan requires operator-visible `alert=<cause>` on issue report agent lines, and classifies cause as `hooks-never-seen` | `correlation-lagged` as part of lifecycle truth, not only a one-shot log line.
- **Failure:** After a later `agent-observability-recovered` or journal rotation, cursor’s report can lose the cause; antigravity never shows `alert=` even while `health=degraded`, so operators still cannot tell “restart CLI” from “correlation lag” from status alone.
- **Contrast:** claude `src/agentLifecycle.ts:41`, `:608` and `src/issueReport.ts:67`; codex `src/agentLifecycle.ts:42`, `:592` and `src/issueReport.ts:65` persist `degradedCause` on the entry.

### Codex: `idleSentinelAfterAction` requires the UUID to still be in the capture

- **codex** `src/tmux.ts:149-154`: returns true only when both sentinel and `actionId` appear and sentinel is after the UUID (`actionAt !== -1`).
- **Rule:** A ready prompt whose viewport no longer contains the action UUID is the positive proof for lost-injection recovery (`actionAbsentAtReadyPrompt`); the sentinel helper must not demand the UUID still be visible.
- **Failure:** If this helper is ever wired into recovery (or used as the plan intended), a pane that correctly dropped the UUID and printed a fresh sentinel would fail the check, blocking the B4/B5 retry the selected plan added.
- **Test:** `idleSentinelAfterAction("…\nCOORD-IDLE: …", actionId)` with no UUID in the buffer should be usable as “sentinel present and UUID absent” when composed with `!pane.includes(actionId)`, matching antigravity/claude’s `actionIndex === -1 || …` shape — or keep UUID absence solely in `actionAbsentAtReadyPrompt` and delete the dead helper.
- **Note:** On this pin the helper is unused; the live bug is the dead API shape plus the missing `actionId` thread in finding 2.

### Preference

Prefer **claude** `62ed5b44096ddd622e9b8c1263faa6c21f429e5b`: spinner-anchored Cursor chrome (no `\W`), action-correlated sentinel on the send path, persisted `degradedCause`, stage-tagged `NudgeOutcome`, and the broadest focused tests. **Codex** `176321636ce7660142c5a77f8be75701911c817a` is the closest peer (good chrome matcher, durable degrade cause) once sentinel freshness is threaded like Claude. **Cursor** and **antigravity** regress A1 via `\W` and treat a stale last-line sentinel as authoritative; antigravity additionally omits the issue-report alert surface.
