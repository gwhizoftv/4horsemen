# Plan review — issue 102

Reviewed at the bound commits: antigravity `ba6c7daa132cb6937aa1eca0032310e005611c9f`,
cursor `fe93f93e173bf52e0b5e5851994d3b2cb553150a`, codex `f1a824657dd73f3b07c25bb367bdfbc735f28f1c`.

## Findings

### F1 — antigravity: the plan never changes the degraded remedy or the sticky alert, but claims it addresses the issue

**Claim.** The antigravity plan's Conclusion says it "addresses all four concerns in Issue 102", and its
`src/runLoop.ts` bullet lists only "log and journal explicit busy rationales" and "prevent duplicate
nudge suppression". No section touches the operator message text, and the words `degraded`,
`markObservabilityDegraded`, `intent-seen`, and `health` appear nowhere in the changed-file list.

**Rule that must hold.** Two of the issue's five acceptance criteria are about that message: "Degraded
message no longer unconditionally tells operators to restart the CLI" and "`intent-seen` after degraded
does not leave a sticky 'restart hooks' operator alert". The text lives at `src/runLoop.ts:699`
(`Restart ${agent}'s CLI so it loads coordinator lifecycle hooks.`), reached from
`markObservabilityDegraded` at `src/agentLifecycle.ts:533`, which proves only that no hook correlated
with the last send inside the watchdog window — never that hooks are unloaded.

**Concrete failure.** Follow this plan and case B2 reproduces unchanged: Claude is mid-turn on the
previous prompt, the watchdog fires at 45s, and the operator is told to restart the CLI. Restarting is
not a neutral action — it kills the in-flight turn that was about to write `complete`, so the remedy
the coordinator prints destroys the work that would have cleared the condition. The issue is filed
because this already happened; the plan as written ships without touching the line that caused it.

**Smallest correction.** Add `src/agentLifecycle.ts:533` and `src/runLoop.ts:682-702` to the changed
list: classify the degrade (no `SessionStart` ever seen versus correlation lag) and emit the restart
remedy only for the first, and clear `health` when the workflow proves delivery worked.

### F2 — antigravity: relaxing idle-epoch exhaustion authorizes a second delivery of an action the agent already has

**Claim.** "Enhance `decideLifecycleNudge` and `markActionInjectionDeferred` so transient busy states
during injection or re-nudging do not permanently exhaust the idle epoch", motivated by "an action was
marked `injected` but the agent never processed it … suppressing subsequent nudges indefinitely".

**Rule that must hold.** After a send succeeds, only *positive evidence that the action is absent* may
authorize another send. That is why `markActionInjected` (`src/agentLifecycle.ts:207`) burns
`lastNudgedIdleEpoch: current.idleEpoch`, and why the one existing retry path
(`src/runLoop.ts:720-733`) is gated on `actionAbsentAtReadyPrompt` — a live, ready prompt whose
viewport no longer contains the action UUID (`src/tmux.ts:722`). `markActionInjectionDeferred`
(`src/agentLifecycle.ts:288`) is restricted to `delivery === "ordered"` for exactly this reason: an
action that was never sent cannot be sent twice.

**Concrete failure.** With the restriction relaxed, an action in `delivery: "injected"` gets
`retryableInjectionAt` set, `src/runLoop.ts:710` (`entry.action?.delivery !== "ordered" || …`) skips
the lifecycle decision, and the next tick with a ready pane types the same nudge again — precisely in
case B3, where the agent is already working on that action and hooks are still `queued` because `Stop`
for the older turn has not landed. The agent then has two copies of one action: it publishes and pushes
the same `requiredPath` twice, and the second turn races the coordinator's verify of the first
submission. The plan names no absence proof anywhere, so nothing prevents this.

**Smallest correction.** Keep `markActionInjectionDeferred` scoped to `ordered`, and make any new retry
branch for `injected` actions carry the same `actionAbsentAtReadyPrompt` proof the existing branch uses.

### F3 — antigravity: busy rationale written into `nudged` events corrupts two analytics measures

**Claim.** "`src/runLoop.ts`: Log and journal explicit busy rationales (`details: { busyReason,
gateReason, promptReason }`) in `nudged` and `agent-lifecycle` journal events."

**Rule that must hold.** A `nudged` event means an action was actually typed into the pane. Two derived
measures depend on that meaning: `deriveWaits` (`src/analytics.ts:249-262`) starts the agent-wait clock
at each `nudged` and stops it at `intent-seen`, reported as "Agent wait (nudged -> intent-seen)"
(`src/analytics.ts:554`); and `attemptedActions` (`src/analytics.ts:352-358`) treats every `nudged`
actionId as an action that should have a correlated turn, reporting the difference as missing identity
against token and tool coverage.

**Concrete failure.** A deferral recorded as `nudged` starts the wait clock at a moment when nothing was
delivered, so the reported median agent wait absorbs the entire busy window — and a busy loop that
never delivers at all contributes an actionId to `attemptedActions` with no bound turn, which is
reported as missing transcript identity and lowers the honest coverage number for an agent that did
nothing wrong. The measurement that operators would use to confirm this fix is the measurement it
breaks.

**Smallest correction.** Record deferrals under their own journal type (`nudge-deferred`), as the cursor
and codex plans both do, and leave `nudged` meaning "sent".

### F4 — antigravity: the `config.product.example.json` bump does not exist as described and does not touch the ship gate

**Claim.** "`config.product.example.json`: Bump coordination version from `0.0.17` to `0.0.18`", listed
alongside the `package.json` bump under "satisfy non-main branch ship gates".

**Rule that must hold.** An exact file list is executable as written; each entry must name a change that
exists and has the effect claimed. The pre-1.0 ship gate reads `package.json` only
(`readPackageVersion`, `src/versionBump.ts:40`, compared against `origin/main`).

**Concrete failure.** `config.product.example.json` contains no `0.0.17`: its only version is
`coordination.version: "0.0.16"` at line 34, inside the `coordination` install-stamp block that records
which driver version installed itself into an example *product* clone. An implementer following this
line either cannot find the string to change, or edits an install stamp so the example asserts an
install that never happened. Nothing catches it — `test/verify-config.test.ts:204` only asserts the file
still parses — and the gate is unaffected either way, so the plan spends a file entry on a change that
is at best inert and at worst a false record.

**Smallest correction.** Drop the entry. `package.json` alone satisfies the gate.

### F5 — antigravity: narrowing the scrape window to 5–10 lines breaks readiness predicates written against 40

**Claim.** "Instead of searching for `esc to cancel` or `Running...` across all 40 lines of
`capture-pane`, inspect the bottom active region of the viewport (the last 5-10 lines …)."

**Rule that must hold.** The window and the predicates are one design. `harnessPromptReady`
(`src/tmux.ts:63`) is not a single negative regex: for antigravity it is a *conjunction* over two token
families printed at different heights — a prompt token (`>`, `shortcuts`, `Accept-edits`) **and** a
vendor-identity token (`Antigravity`, `Gemini`, `accept-edits`) (`src/tmux.ts:79`) — and for claude
it is a disjunction that includes `auto mode`, part of the session banner. Shrinking the buffer changes
which half of each predicate is still visible.

**Concrete failure.** Applying one 5–10 line window uniformly, an idle antigravity pane whose recent
tail is ordinary agent output can satisfy the prompt half and lose the identity half, so
`harnessPromptReady` returns false for a genuinely idle pane and that agent is never nudged again — the
same permanent false-busy the issue is filed about, moved to a different vendor. The plan states the
window change but re-derives no predicate against it and adds no per-vendor case.

**Smallest correction.** Change the predicates rather than the window: keep `-S -40` and make the
activity match line-anchored chrome, so no positive token is lost.

### F6 — cursor: requiring an ellipsis does not separate Cursor chrome from prose, and this workflow proves it

**Claim.** "tighten Cursor in-flight chrome to require `...` or `…` after
`Generating|Running|Working|Thinking`", with the test "plan prose containing `status/thinking/stats` is
prompt-ready; real `Thinking...` / `Thinking…` remains busy".

**Rule that must hold.** The discriminator between chrome and prose has to be something prose does not
contain. `capturePane` reads 40 lines of whatever the agent most recently rendered
(`src/tmux.ts:715-718`), and on this workflow that content is the agent's own writing about this issue.

**Concrete failure.** Both peer plans published for this very step contain the literal strings the rule
keys on: the antigravity plan writes ``historical words like `Running...` or `Working...` `` and this
review's own subject matter forces `Thinking...` and `Thinking…` into the pane. So on the runs where
this fix matters most — any run whose artifacts discuss agent readiness — Cursor's pane still matches
the tightened regex and stays false-busy, and the A1 test in the plan passes while the production
behaviour is unchanged. The chosen test input (`status/thinking/stats`) is the one shape of prose that
the ellipsis rule happens to exclude.

**Smallest correction.** Anchor the match to the *start of a line* and to the tail of the buffer as well
as requiring the ellipsis, and add a negative test whose input is a markdown line quoting `Thinking…`
so a bullet or backtick prefix cannot satisfy the anchor. (The same failure defeats a leading
`\W{0,3}` anchor, which a quoted markdown bullet — `` - `Thinking…` `` — matches in three characters.)

### F7 — cursor: clearing degraded at `intent-seen` without blocking the re-degrade produces an alert loop

**Claim.** "on `intent-seen`, if that agent's lifecycle `health` is `degraded`, clear it to `healthy`
(and journal the downgrade rationale)", listed as the D5 fix.

**Rule that must hold.** Clearing an alert only helps if the condition that raised it cannot
immediately raise it again. `markObservabilityDegraded` (`src/agentLifecycle.ts:533`) re-arms on exactly
one input — `entry.health === "degraded"` — and otherwise re-evaluates `lastEventAt` against
`action.injectedAt`, neither of which the clear touches.

**Concrete failure.** Take the B2 sequence and let verification reject the submission. `reissue`
(`src/runLoop.ts:928-943`) clears `complete` and keeps the *same* actionId, and `orderAgentAction`
(`src/agentLifecycle.ts:174-181`) returns the state unchanged for an unchanged actionId and digest, so
`injectedAt` stays at the original send. The reissue nudge takes the `reason === "reissue"` path, which
skips the watchdog block. On the next tick `complete` is missing again, so the idle path at
`src/runLoop.ts:1194` runs, `health` is now `healthy` because intent-seen cleared it, `lastEventAt` is
still older than `injectedAt`, and the elapsed time is minutes past the watchdog — so the agent degrades
a second time and the operator sees the alert again for an agent that has already demonstrably
delivered. The clear makes the alert repeat rather than stick.

**Smallest correction.** Suppress the degrade itself on evidence, not just the flag: refuse to degrade
while the current action has recorded workflow completion, and re-arm only when a new delivery sets a
fresh `injectedAt`.

### F8 — cursor: deferring the agent waiting line leaves Cursor and Codex readiness with no positive signal

**Claim.** Under Scope, "Out of scope for this issue … requiring agents to print a fixed 'waiting for
next action.md' line", restated in Alternatives Rejected as "does not fix false-busy or opaque
journalling; optional follow-up".

**Rule that must hold.** Item 4 of the issue body is one of the four numbered symptoms the issue was
filed on, and it is the only one that supplies *positive* readiness evidence. It matters because
`harnessPromptReady` has no positive branch for two of the four vendors: cursor (`src/tmux.ts:69-73`)
and codex (`src/tmux.ts:80-82`) both `return true` by default, so for them "ready" means only "no busy
chrome matched".

**Concrete failure.** After F6's fix removes the one chrome pattern that made Cursor look busy, Cursor's
readiness function is a constant `true` for every pane state the trust-dialog check does not catch: a
pane mid-redraw, a pane showing a vendor error, a pane whose composer has lost focus. The coordinator
types the action into it, `nudge` returns `sent`, `markActionInjected` burns the idle epoch
(`src/agentLifecycle.ts:240`), and the only remaining recovery is the narrow UUID-absent path the same
plan declines to broaden — so a genuinely lost delivery is now *less* recoverable than before the fix,
with no journal entry saying anything went wrong because the send succeeded.

**Smallest correction.** Keep the waiting line in scope as additive positive evidence, matched only when
it is newer than the current action UUID in the buffer; it costs one paragraph in
`templates/product/AGENTS.protocol.md` and does not weaken any existing check.

### F9 — codex: letting a fresh `Stop` override live turn chrome can type into a turn the coordinator did not start

**Claim.** "a fresh idle Stop for the current delivery may override stale or ambiguous prompt text",
with activity chrome classified as overrideable and only pane/input/process and trust/verification UI
as hard blockers.

**Rule that must hold.** A `Stop` proves that *a particular turn* ended. It does not prove the pane is
currently accepting keys, because a turn the coordinator did not originate — the owner typing directly
into the pane, a session cron, a resumed background task — starts without any coordinator-visible hook
until the vendor's prompt-submit fires. `injectionGate` (`src/tmux.ts:702`) checks copy mode and
`pane_input_off`, neither of which is set by an ordinary in-flight turn: the only signal that such a
turn is running is the very chrome the plan makes overrideable.

**Concrete failure.** The owner types a question into the agent's pane while the coordinator's action is
pending. The pane shows `esc to cancel`; the last correlated `Stop` is newer than the last injection, so
it is "fresh"; `pendingInputCount` and `backgroundActive` are unchanged because no hook has fired for
the owner's turn yet. The plan's precedence overrides the chrome and sends: the prelude key, the action
text, then `Escape` and `Enter` (`src/tmux.ts:771-785`) land inside the running turn — cancelling the
owner's turn, or appending the action text to its input and submitting a merged prompt. This is the
one failure mode the scrape veto exists to prevent, and it is worse than the stall it replaces.

**Smallest correction.** Keep live activity chrome a hard blocker and let the fresh `Stop` override only
the *absence* of a positive prompt match (the "prompt-not-found" case), never a positive match on
in-flight chrome.

### F10 — codex: journaling only on reason change makes a persistent stall unmeasurable

**Claim.** "Make deferral recording report whether the reason actually changed so the journal can be
de-duplicated… Appending the same refusal every polling tick is rejected because it would flood the
journal. Persisting the last reason and journaling only its first occurrence or a transition preserves
the useful history." The state is cleared "on a new action or successful send", with no event named for
that clear.

**Rule that must hold.** The journal is the operator's post-hoc record; a condition's *duration* has to
be recoverable from it. Every other coordinator condition is bracketed — `nudged` is closed by
`intent-seen` (`src/analytics.ts:249-262`), `action-prepared` by `gate-advanced` — which is what makes
`coord analytics` able to report a wait at all.

**Concrete failure.** The exact scenario the issue was filed on — an agent stuck on one unchanging
reason (`foreground-mismatch`, or Cursor false-busy) for the whole run — produces exactly one journal
event, at the start, and never another. Nothing marks when it ended, so the journal cannot distinguish a
five-second blip from a forty-minute stall that consumed the run, and the operator asking "how long was
antigravity blocked" gets the same single line either way. De-duplication removed the flood and the
signal together.

**Smallest correction.** Keep the de-duplication, and either journal a resolution event when the
deferral clears (successful send, new action, changed reason) or carry `firstSeenAt`, `lastSeenAt`, and
an occurrence count on the persisted deferral so a later event can close the interval.

## Conclusion

All three peer plans agree on the core shape — reason codes instead of a bare `busy`, a dedicated
deferral event, and keeping the scrape as the typing gate — and that shape is right.

The blocking defects are F1 (antigravity ships without touching the degraded remedy at
`src/runLoop.ts:699` or the sticky alert, so two acceptance criteria are unmet and the reported harm
recurs), F2 (antigravity's idle-epoch relaxation can deliver one action twice with no absence proof),
and F9 (codex's fresh-`Stop` override can type into a turn the coordinator did not start, converting a
stall into a corrupted turn). None of the three should be implemented as written.

F6 and F8 are correctness defects in an otherwise sound cursor plan: the ellipsis rule does not
actually separate chrome from the prose this workflow generates, and removing the only negative signal
for a vendor whose readiness check has no positive branch leaves that vendor with no readiness check at
all. F3, F4, F5, F7, and F10 are narrower and each has a one-line correction.

The strongest plan to build on is cursor's — it is the only one that states the precedence policy
explicitly and scopes itself to the acceptance list — with F6 and F8 corrected and F7's re-degrade guard
added, plus codex's de-duplicated deferral record (F10 corrected) for the journalling half.
