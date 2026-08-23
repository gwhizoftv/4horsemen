# Issue 102 implementation comparison

## Comparison

Compared the four bound product commits:

- Claude: `62ed5b44096ddd622e9b8c1263faa6c21f429e5b`
- Codex: `176321636ce7660142c5a77f8be75701911c817a`
- Cursor: `ecc899ee10d92e7324106e056fd1f5ed34373013`
- Antigravity: `24106c134ae82a23917900374f300693c677774c`

All four pass ESLint, both TypeScript checks, and the five directly affected test suites (`tmux`, `agentLifecycle`, `runLoop`, `agentLanguage`, and `issueReport`) from their own trees. I also ran the same four cross-implementation readiness probes against every pin:

| Invariant | Claude | Codex | Cursor | Antigravity |
| --- | --- | --- | --- | --- |
| Verification overlay still vetoes a trailing idle sentinel | Pass | Pass | Fail | Fail |
| `Thinking for 12s` and `Working (12s)` remain busy | Fail | Fail | Pass | Pass |
| A prose bullet beginning `- Thinking...` remains ready | Pass | Pass | Fail | Fail |
| Recovery remains false while the captured UUID is present | Pass | Pass | Pass | Fail |

### Material findings

1. **Antigravity — `src/tmux.ts:800-805`:** Lost-delivery recovery must require positive proof that the current action UUID is absent from the captured pane. When readiness comes from the idle sentinel, this implementation instead returns `idleSentinelAfterAction(...)` without also checking UUID absence; a capture containing the UUID followed by the sentinel therefore returns `true`. `src/runLoop.ts:738-764` can consequently mark an injected action absent and deliver it a second time. The smallest regression is an `actionAbsentAtReadyPrompt` test whose capture is `<action UUID>\n<idle sentinel>` and whose expected result is `false`.

2. **Cursor — `src/tmux.ts:90-110`; Antigravity — `src/tmux.ts:96-123`:** An idle sentinel is additive readiness evidence and must not override a live scrape blocker. Both implementations return `idle-sentinel` before checking Antigravity turn chrome or its account-verification overlay, so a captured overlay ending in the sentinel is classified ready and the coordinator can type into a pane that discards input. Put sentinel handling after all hard blockers and add the overlay-plus-sentinel regression.

3. **Cursor — `src/tmux.ts:81-102`; Antigravity — `src/tmux.ts:107-113`:** Cursor activity detection must distinguish rendered status chrome from prose. Their `\W{0,3}` prefix accepts Markdown punctuation, so `- Thinking... is quoted from the readiness plan` is classified as `cursor-turn-chrome` and can hold delivery indefinitely—the same false-busy class issue 102 is meant to remove. Restrict the optional prefix to known spinner glyphs rather than arbitrary non-word characters.

4. **Claude — `src/tmux.ts:90-94`; Codex — `src/tmux.ts:96-101`:** Cursor status recognition must cover every timer-shaped live form promised by the selected plan. Both match ellipsis forms but classify `Thinking for 12s` and `Working (12s)` as ready, so `nudge` can type into an active Cursor turn. Extend the anchored suffix to include `for <number>` and parenthesized timer forms, while retaining their useful exclusion of prose bullets.

5. **Cursor — `src/issueReport.ts:60-76` and `src/cli.ts:1091`:** A degraded status line must expose whether the cause is `hooks-never-seen` or `correlation-lagged`. The report can derive a cause only from its optional journal argument, but `coord status` passes lifecycle state without that journal, so the operator sees `/ degraded` with no actionable cause. Persist the cause in lifecycle state as Claude and Codex do, or pass the journal at every lifecycle-report call site.

6. **Antigravity — `src/issueReport.ts:59-67`:** The same degraded status rule must hold, but this pin never adds an alert cause to the report at all. Operators therefore cannot distinguish a dead hook bridge from ordinary correlation lag when using `coord status`.

7. **Claude — `src/runLoop.ts:720-765`:** Each `nudge-deferred` record must include `gateWaiting`, and normal stdout should be used only when the workflow is waiting on that agent or hooks and scrape disagree. This implementation records neither `gateWaiting` nor cursor state and logs the first occurrence of every code normally, so journal consumers cannot distinguish an operator-relevant gate and unrelated first-time deferrals add noise.

### Ranking and recommendation

1. **Codex `176321636ce7660142c5a77f8be75701911c817a` — recommended base.** It preserves hard-blocker precedence and UUID-absence safety, persists degraded causes for `coord status`, records hooks, `gateWaiting`, human rationale, split-brain state, and nudge stage, and edge-triggers normal output. Its material defect is localized to the Cursor timer suffix matcher.
2. **Claude `62ed5b44096ddd622e9b8c1263faa6c21f429e5b`.** It has the broadest new test coverage and sound recovery/cause persistence, but needs the same timer matcher correction plus the missing `gateWaiting`/stdout policy.
3. **Cursor `ecc899ee10d92e7324106e056fd1f5ed34373013`.** It handles timer-shaped chrome and UUID absence, but sentinel precedence can bypass a hard blocker, the broad punctuation prefix preserves a false-busy case, and degraded causes are absent from the actual status path.
4. **Antigravity `24106c134ae82a23917900374f300693c677774c`.** It has the same sentinel and prose defects, omits status causes, and uniquely violates the no-duplicate recovery invariant.

Recommendation: revise the Codex pin only by broadening its anchored, recent-line Cursor matcher for the two timer forms and adding the shared regression probes. The remaining issue-102 behavior is the closest of the four pins to the selected plan with the smallest safety-preserving correction.
