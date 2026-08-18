# Code review — issue 86, Codex implementation

Reviewer: Claude
Target: `issue-86/codex` @ `46a9fe24ccc8691e455f6d3363e31388566d0fa6`

## Findings

### 1. A lost keystroke now deadlocks the run loop permanently (blocking)

`src/agentLifecycle.ts:387` (and the same predicate at `:374`), `src/agentLifecycle.ts:439`.

**Rule.** Issue 86 rule 7 requires delivery to be retried "after positive evidence
that the action was not accepted, such as a changed CLI session, a failed
injection, **or a prompt-ready observation proving the action is absent**." Every
delivery state must have at least one recovery path that does not require the
human to restart the agent CLI.

**Failure.** `injectedAwaitingAcceptance` is true whenever
`action.delivery === "injected" && action.turnId === null`. If the injected text
never reaches the CLI's input widget — the exact failure this repository has been
fighting in `c757d47` ("stop treating tmux send as delivery") and `6ff52f0`
("submit vim INSERT nudges with Escape then Enter") — then no `UserPromptSubmit` /
`beforeSubmitPrompt` hook ever fires, so `action.turnId` stays `null` forever.
Every subsequent `Stop` event, including ones from turns the human started by
typing in the pane, re-enters the `kind === "stopped"` branch at `:382` and sets
`execution = "queued"`. `decideLifecycleNudge` then returns
`{kind:"wait", reason:"queued"}` on every tick, forever.

`markObservabilityDegraded` (`:462`) does not rescue this: it returns early
because `entry.lastEventAt >= action.injectedAt` — the `Stop` events *are*
arriving, so the instrumentation looks healthy. The issue therefore stalls with
zero prompts pending, `coord status` prints `injected / queued / healthy`, and
the only escape is a session-id change at `:318`, i.e. a CLI restart. Codex,
Claude and Cursor have no other way out; only Antigravity can break the loop,
via the `kind === "status"` branch at `:405`.

**Correction.** The missing evidence already exists and is already public.
`TmuxController.capturePane` (`src/tmux.ts:677`) grabs the last 40 lines, and the
nudge text now carries both the action UUID and the digest. In
`maybeLifecycleNudge`, when the decision is `wait`/`queued` *and*
`action.delivery === "injected" && action.turnId === null`, capture the pane; if
`harnessPromptReady(paneText, agent.id)` is true and the pane text does not
contain `action.actionId`, that is a prompt-ready observation proving the action
is absent — reset `delivery` to `"ordered"` and clear `injectedAt` so the next
tick may re-deliver.

**Test.** Mirror of the new `retries an action that a busy pane never injected`
case: inject once, feed a `stopped` observation carrying an unrelated `turnId`,
then have `capture-pane` return a ready prompt without the action UUID, and
assert exactly one further literal `send-keys`.

### 2. Deleting `rewriteOrderedAction` reintroduces the bug fixed by `ca5b691` (blocking)

`src/runLoop.ts:546` (the removed private method), `test/runLoop.test.ts:190`.

**Rule.** An in-flight `action.md` must carry the `approvedPaths` that the
*current* extractor resolves. A mid-issue extractor upgrade has to reach an
action that is already ordered, because the agent will not be re-ordered until
the step fails.

**Failure.** `ca5b691` ("Cursor: refresh implement action paths on retry") added
`rewriteOrderedAction` for precisely this, with a regression test. This commit
deletes the method and *inverts* that test — `expect(body).toContain("scripts/setup_claude.sh")`
became `expect(body).not.toContain("scripts/setup_claude.sh")`, and
`expect(literalNudges).toBeGreaterThan(0)` became `expect(literalNudges).toBe(0)`.
After an extractor upgrade mid-issue, the ordered implement action keeps its
pre-upgrade `approvedPaths` for the remainder of the step: the agent either
commits files the stale list does not cover and the verify gate rejects them, or
it never touches a path the new extractor would have approved. Issue 86 asks for
none of this, and no #86 acceptance criterion covers it — inverting a passing
regression test is not the same as superseding it.

**Correction.** The machinery this commit adds already makes the rewrite safe.
`orderAgentAction` (`src/agentLifecycle.ts:160`) resets `delivery` to `"ordered"`
whenever the digest changes, so a rewritten `action.md` is by construction a
different action and its redelivery cannot be the duplicate #86 is about.
Restore `rewriteOrderedAction`, call it **before** `orderAgentAction`, and
compute `sha256OfFile(runtime.action)` after it. Note the resulting order still
waits for an eligible idle observation before injecting (the `retryableInjectionAt`
bypass at `src/runLoop.ts:583` does not apply to a fresh order) — that is the
correct behaviour and is compatible with rule 1. Restore the original assertions
in `test/runLoop.test.ts`.

### 3. The degraded-observability signal is invisible on the default output channel (major)

`src/runLoop.ts:578`.

**Rule.** #86's acceptance criterion is "Missing or broken hooks produce an
**observable** degraded-health condition without creating duplicate prompt
storms." Observable means observable to the operator watching `coord N`, not only
to someone who later reads `journal.jsonl`.

**Failure.** The transition is announced with `this.verbose(...)`, which is a
no-op unless `-v` was passed (`src/cli.ts:552`, gated on `verboseState.enabled`).
Consider the state `docs/setup-workspace.md` itself documents as normal right
after install — "Restart Codex/Claude after install if their current session
predates the hook file." Until that restart, no hook ever fires, `execution`
stays `"unknown"`, `decideLifecycleNudge` returns `wait`/`"unknown"` on every
tick, and the operator sees a coordinator that prints nothing, never advances,
and never says why. Before this commit the same situation produced a visible
re-nudge every 45 seconds; the new behaviour is safer but strictly less
diagnosable at the default verbosity.

**Correction.** Emit the first degraded transition on `this.log` with the remedy
inline ("restart <agent>'s CLI so it loads coordinator lifecycle hooks"), keeping
the journal entry unchanged. `markObservabilityDegraded` already returns
`changed` exactly once per transition, so this is one line per agent, not one per
tick.

### 4. One journal append per hook callback, on an O(n²) append (major)

`src/agentEvent.ts:269`, `src/state.ts:535`, `src/agentLifecycle.ts:432`.

**Rule.** An append-only audit log must cost O(1) per append, and a
high-frequency observation source must not produce one audit record per
observation.

**Failure.** `appendJournal` derives `sequence` by calling `readJournal(paths)`,
which reads the entire journal and Zod-parses every line, on every append. Until
now journal writes were coarse — a nudge, a verify result, a gate advance. This
commit adds one append per hook callback, and for Antigravity the source is the
status line, which the CLI re-renders continuously; `renderStatusLineWrapper`
(`src/agentHookSync.ts:309`) forwards every single render.

`observeAgentLifecycle` cannot short-circuit either: `applyLifecycleObservation`
ends in `agentLifecycleEntrySchema.parse({...})`, which always returns a fresh
object, so the `if (next === current) return state;` guard at
`src/agentLifecycle.ts:432` is never true. Every render therefore also increments
`stateRevision`, rewrites `agent-lifecycle.json`, and takes the lifecycle lock.
On a multi-hour issue the journal reaches tens of thousands of lines, each
further append re-parses all of them, and `coord status`, `readJournal`, and
every subsequent nudge slow down together.

**Correction.** Two independent fixes. (a) Journal and persist only on a real
change: compare the candidate entry against the current one ignoring
`updatedAt` / `lastEventAt`, and skip both the state write and the journal append
when nothing else moved. (b) Have `appendJournal` obtain the next sequence
without parsing the whole file — it already holds an exclusive lock, so counting
newlines, or carrying the sequence in a sidecar, is sufficient.

### 5. The Antigravity status line renders through a cold Node start, machine-wide (moderate)

`src/agentHookSync.ts:309`, `src/install.ts:414`.

**Rule.** A status line is on the UI's render path. Install must not put a cold
process start there, and a user-global install must not tax Antigravity sessions
that have nothing to do with coordination.

**Failure.** The wrapper runs `node <cliEntry> agent-event` synchronously before
the downstream command, on every render. The setting lives at
`~/.gemini/antigravity-cli/settings.json` — user-global, not per-clone — so every
Antigravity session on the machine pays a Node cold start (tens to well over a
hundred milliseconds) per render, and unrelated sessions pay it only for
`handleAgentEvent` to return `observed:false` after failing to resolve a clone.
Separately, when there was no previous status line the wrapper emits nothing at
all and relies on `stack_with_default: true` to keep a display; I could not
confirm that key exists in the Antigravity settings schema.

**Correction.** Pre-filter in shell before spawning node — the payload names a
workspace path, so a `case`/`grep` against the known clone roots is enough to
skip the common case — or make the forward non-blocking. Either way, confirm
`stack_with_default` against the real schema before shipping, since the
no-previous-status-line path degrades to a blank status line if it is wrong.

### 6. Non-vendor agent ids get no instrumentation and so are nudged exactly once, ever (moderate)

`src/agentHookSync.ts:11` (`vendorForAgent`), `src/doctor.ts:305`.

**Rule.** Agent ids are free-form — `agentIdSchema` is `/^[a-z][a-z0-9-]{0,63}$/`
(`src/protocol.ts:5`) and `coordinatorConfigSchema` only requires uniqueness — so
a delivery gate keyed on the id must degrade safely for ids outside the four
vendor strings.

**Failure.** `vendorForAgent` matches the literal id. An operator running two
Claude clones as `claude-a` / `claude-b`, or naming the Antigravity agent `agy`,
gets `{supported:false}` from `syncAgentLifecycleHooks`, `"unsupported"` from
`inspectAgentLifecycleHooks` — which `checkClone` deliberately does not report —
and an `execution` axis pinned at `"unknown"`. Combined with finding 3, that
agent receives exactly one nudge per action for the life of the issue, with no
diagnostic anywhere. The previous 45-second resend covered this case by accident;
nothing covers it now.

**Correction.** Derive the vendor from `harnessProcess` or the launcher, or add
an explicit optional `lifecycleVendor` to `agentConfigSchema`, rather than from
the id. Independently, have `doctor` surface `unsupported` as an informational
finding so an operator can see an uninstrumented agent *before* the run stalls.

### 7. `pull`-delivery agents are stamped `degraded` for being idle (minor)

`src/runLoop.ts:560`, `src/agentLifecycle.ts:462`.

**Rule.** Health describes the instrumentation, not the workflow. An agent
configured `delivery: "pull"` is never injected by design — `TmuxController.nudge`
returns `"disabled"` at `src/tmux.ts:692` — so the absence of a lifecycle event
within 45s of `orderedAt` says nothing about hook health.

**Failure.** `markObservabilityDegraded` falls back to
`action.injectedAt ?? action.orderedAt`. `config.product.example.json` ships
codex as `delivery: "pull"`. For that agent `injectedAt` is always `null`, so 45
seconds after any order it is stamped `degraded`, journalled as
`agent-observability-degraded`, and printed by `coord status` — while its hooks
are installed and working perfectly. The operator is told to restart a CLI that
has nothing wrong with it, which is exactly the kind of false signal that trains
people to ignore the real one from finding 3.

**Correction.** Skip the watchdog when the agent's `delivery` is neither `"nudge"`
nor `"both"`, or key it strictly off `injectedAt` and leave an ordered-but-never-
injected action at health `"unknown"`.

### 8. Branch does not carry the issue-86 artifacts, and the cleanup claim is not visible (minor)

`.plans/issue-86/`, `.code-reviews/issue-4/`.

**Rule.** `AGENTS.md` requires `.plans/issue-<n>/plan.md` with its six headings
for the issue under work, and a completion report should be checkable against the
tree it describes.

**Failure.** `git ls-tree -r origin/issue-86/codex` shows no `.plans/issue-86` or
`.code-reviews/issue-86` path at all, so there is no plan to review this
implementation against. The report also states "Removed both stale issue-4 review
files", but `.code-reviews/issue-4/review-codex.md`,
`.code-reviews/issue-4/review-cursor-by-claude.md`, and
`.code-reviews/issue-4/revise-requirements-claude.md` are still tracked
identically on both `main` and this branch, and `46a9fe2` deletes no files.
Please confirm what was actually removed and where.

## Verdict

**Request changes.** Findings 1 and 2 are blocking.

The core design is right and matches what #86 asked for: coordinator-owned state,
three genuinely independent axes (delivery / execution / health), correlation by
action UUID *and* digest so a delayed hook cannot accept a rewritten action, a
separate `agent-lifecycle.json` so hook traffic never touches the workflow
authority revision, retired-session handling that drops stale events, and
marker-scoped hook install/uninstall that composes with third-party entries. The
unit tests for the observation state machine and the hook-sync merge/removal
paths are good, and the docs are unusually thorough.

The problem is that the safety property was implemented as a one-way ratchet.
Rule 8 ("retain the safe no-duplicate behaviour rather than reverting to
unconditional resends") was honoured; rule 7 ("retry delivery only after positive
evidence that the action was not accepted... **or a prompt-ready observation
proving the action is absent**") was not implemented at all. That trade turns
every lost keystroke and every un-instrumented agent — both of which this
repository demonstrably has — into a silent permanent stall instead of a noisy
recoverable one. Finding 1 closes that gap using machinery that is already
present and already public.

Finding 2 is independent of the lifecycle design and should not have been part of
this change: a passing regression test from `ca5b691` was inverted rather than
superseded, and the digest-reset behaviour this very commit introduces is what
makes restoring it safe.
