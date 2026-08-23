# Implementation comparison — issue 102

Bound implementation pins compared:

- claude `62ed5b44096ddd622e9b8c1263faa6c21f429e5b`
- codex `176321636ce7660142c5a77f8be75701911c817a`
- cursor `ecc899ee10d92e7324106e056fd1f5ed34373013`
- antigravity `24106c134ae82a23917900374f300693c677774c`

## Comparison

All four pins converge on the same shape and, in the journalling and messaging
half, are close to interchangeable. Every pin adds `nudge-deferred` and
`agent-observability-recovered` to the journal enum, returns a structured
outcome from `nudge`, classifies a degrade with the identical predicate
(`entry.lastEvent === null && entry.sessionId === null ? "hooks-never-seen" :
"correlation-lagged"` — claude `src/agentLifecycle.ts:607`, codex
`src/agentLifecycle.ts:591`, cursor `src/agentLifecycle.ts:586`, antigravity
`src/agentLifecycle.ts:588`), keeps the restart remedy only for
`hooks-never-seen`, refuses to degrade an action that reached workflow
completion, clears a standing alert when it does, records both sides of a
scrape/hook disagreement on one event, and de-duplicates repeated stdout for an
unchanged code. Judged on the issue's messaging criteria alone, any of the four
would do.

They separate entirely on the safety layer: what is allowed to authorize typing
into a live pane. The findings below are all in that layer.

### F1 — cursor `src/tmux.ts:93`: the sentinel is consulted before every vendor blocker

`harnessPromptReadiness` returns `{ ready: true, reason: "idle-sentinel" }` from
line 93, above the `switch (agentId)` that begins at line 94. Only the
trust-dialog check precedes it.

**Rule.** A positive readiness hint may add a reason to send; it must never
remove a blocker. The antigravity account-verify overlay (`src/tmux.ts:105-107`
in the same pin) exists precisely because that overlay paints a `>` prompt and
Accept-edits chrome while discarding every keystroke.

**Concrete failure.** An antigravity agent finishes an action and prints the
sentinel; the verify overlay then appears without repainting below it, so the
sentinel is still the last non-empty line. Line 93 returns ready before the
`antigravity` case can test for the overlay. `nudge` types the prelude, the
action text, then Enter into an overlay that drops all of it, returns `sent`,
and `markActionInjected` burns `lastNudgedIdleEpoch`. The action was never
delivered and the lifecycle now records that it was — the B5 stall, reintroduced
by the mechanism meant to cure it. The same ordering also lets a sentinel
override `cursor-turn-chrome`.

**Smallest test.** With that pin's own function:
`expect(harnessPromptReadiness("⚠ Verifying your account...\n" + COORD_IDLE_SENTINEL, "antigravity")).toEqual({ ready: false, reason: "antigravity-verify-overlay" })`
fails at line 93 and passes once the sentinel is evaluated after the switch.

### F2 — antigravity `src/tmux.ts:100-102`: same ordering defect

Lines 100-102 return `{ ready: true, reason: "idle-sentinel" }` when the last
non-empty line is the sentinel, before the `switch` at line 103 — so the
account-verify check at lines 117-119 and the cursor chrome check at lines
109-113 are both unreachable in that state. The rule, the failure, and the test
are those of F1.

Contrast: claude `src/tmux.ts:135-160` and codex `src/tmux.ts:112-141` both run
every blocking predicate first and consult the sentinel only inside the
per-agent branch, so no positive hint can clear a blocker in either.

### F3 — antigravity `src/tmux.ts:802-804`: the recovery proof is inverted

```ts
if (readiness.reason === "idle-sentinel") {
  return idleSentinelAfterAction(captured.stdout, actionId);
}
return !captured.stdout.includes(actionId);
```

**Rule.** `actionAbsentAtReadyPrompt` answers exactly one question: was this
action *never delivered*? The only evidence for that is a ready prompt whose
viewport does not contain the action id. A sentinel printed *after* the action
id proves the opposite — the agent saw the action, worked on it, finished, and
went idle.

**Concrete failure.** This is reachable from the branch that pin itself adds at
`src/runLoop.ts:746` (`execution === "idle" && decision.code ===
"idle-transition-already-used" && watchdogElapsed`), which is the exact state of
an agent that has just finished a turn: hooks idle, the idle transition spent,
the watchdog long elapsed, `delivery === "injected"`, `turnId === null`. The
captured pane holds `…<action id>… / COORD-IDLE: waiting…`, so readiness is
`idle-sentinel` and line 803 returns true — "the delivery was lost". The
coordinator retypes an action the agent has already completed. The agent
re-executes it and publishes and pushes a second time against one
`requiredPath`, racing the coordinator's verify of the first submission. The
condition that most strongly proves delivery *succeeded* is read as proof that
it failed.

**Smallest test.** Drive `actionAbsentAtReadyPrompt` with a stub runner whose
capture returns `` `❯ ${actionId}\n${COORD_IDLE_SENTINEL}` ``; it must be
`false` and is `true` at that pin. The one-line correction is to keep the UUID
check as the sole proof and let the sentinel only satisfy the *readiness* half:
`return readiness.ready && !captured.stdout.includes(actionId)`.

### F4 — cursor `src/tmux.ts:82` and antigravity `src/tmux.ts:111`: the chrome anchor admits markdown

Both pins use the identical matcher:

```
/^\s*\W{0,3}\s*(?:Thinking|Generating|Working|Running)(?:\s*[…]|\.\.\.|\s+for\s+\d|\s*\(\d)/im
```

**Rule.** The discriminator between vendor chrome and prose has to be something
prose does not contain. `capturePane` reads 40 lines of whatever the agent last
rendered, and on this workflow that is the agent's own writing about this issue.

**Concrete failure.** `\W{0,3}` admits exactly the markdown prefixes these
artifacts are written in. Running that regex against lines drawn from the
plans and reviews already published for this issue:

| line | result |
| --- | --- |
| ``- `Thinking…` is the chrome we match`` | matches — false busy |
| `> Thinking... appears while a turn runs` | matches — false busy |
| `* Working... is vendor chrome` | matches — false busy |
| `  - Running... in a bulleted plan line` | matches — false busy |

A Cursor agent that writes any of those lines — as every agent on this issue
did — leaves its pane permanently false-busy, which is symptom A1 unchanged.
Both pins' A1 tests pass because both chose `status/thinking/stats`, the one
prose shape the ellipsis rule already excluded.

**Smallest test.**
``expect(harnessPromptReady("- `Thinking…` is the chrome we match\nAuto · 1%", "cursor")).toBe(true)``
fails on both pins. Codex `src/tmux.ts:96-101` admits only whitespace and an
explicit spinner glyph before the word and requires a full status line, and
claude `src/tmux.ts:90-93` uses the same restriction; both pass it.

### F5 — codex `src/tmux.ts:149` and cursor `src/tmux.ts:131`: the staleness guard is never called

Both pins export `idleSentinelAfterAction`, and in both it is dead code — no
call site exists in `src/tmux.ts` or `src/runLoop.ts` at either pin. Codex's own
plan required "sentinel-after-current-action correlation anywhere the sentinel
contributes to `nudge`".

**Rule.** The 40-line capture keeps the sentinel from the previous action on
screen after it has stopped being true, so a sentinel only proves present-tense
idleness when it is newer than the current action id.

**Concrete failure.** In the delivery path both pins test only "is the sentinel
the last non-empty line". An agent that has been handed action N+1 and is
composing its first output — nothing painted below the sentinel it printed for
action N — reads as idle-sentinel. In codex this is bounded, because the vendor
blockers still run first and for `cursor`/`codex` readiness would have been true
anyway; the practical cost is a mislabelled `readiness` in the `nudged` journal
detail rather than an unsafe send. In cursor it compounds F1: the stale sentinel
is what reaches the overlay bypass. Claude `src/tmux.ts:125-133` threads the
action id into readiness and applies the same rule on both paths.

**Smallest test.** For the pin's own exported function:
``expect(harnessPromptReadiness(`${COORD_IDLE_SENTINEL}\nRead and execute ${actionId}`, "claude")).toMatchObject({ ready: false })``
— a sentinel older than the action must not read as idle.

### Where claude's pin is weaker

Stated plainly, since the same standard applies: claude `src/tmux.ts:90` allows
`·`, `•`, `●`, `○` and `∙` in the spinner prefix, so a line bulleted with a
middle dot (`· Thinking…`) still reads as chrome, a narrower version of F4.
Codex's spinner class is limited to braille frames and is the stricter of the
two. Claude's pin also adds no `test/analytics.test.ts` case for the two new
journal types, where codex extends `test/agentLanguage.test.ts` for the protocol
text; both are additive gaps, not defects.

## Verdict

The messaging half is a tie. The safety half is not, and it is where this issue
can do damage that the original bug never could: a wrong `busy` costs a stall,
while a wrong `ready` costs a corrupted or duplicated turn.

- **antigravity `24106c134ae82a23917900374f300693c677774c`** should not be
  merged as written: it carries the ordering bypass (F2), the markdown
  false-positive (F4), and uniquely the inverted recovery proof (F3), which
  re-delivers actions to agents that have already completed them.
- **cursor `ecc899ee10d92e7324106e056fd1f5ed34373013`** carries the ordering
  bypass (F1) and the markdown false-positive (F4); both are small, local
  corrections, but as pinned the Cursor false-busy it set out to fix survives.
- **codex `176321636ce7660142c5a77f8be75701911c817a`** and **claude
  `62ed5b44096ddd622e9b8c1263faa6c21f429e5b`** both order the sentinel after
  every blocker and both anchor the chrome match strictly enough to survive this
  workflow's own artifacts. Codex's remaining gap is F5 (uncorrelated sentinel,
  bounded to a mislabelled journal detail); claude's is the looser spinner class
  noted above.

Either codex or claude is a sound basis. The smallest complete result is
claude's pin with codex's braille-only spinner class adopted at
`src/tmux.ts:90`, or codex's pin with the action id threaded into
`harnessPromptReadiness` to retire F5.
