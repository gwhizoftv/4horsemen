# Issue 169 — plan review (claude)

Reviewed pins, read from the bound input files:

- cursor `dc7e33a29aa9dba2b197e9570580d48a15bb1dd9`
- codex `5ba6d9c400d7d87cbcc6d69f32a49dcf80af5cb9`
- claude `6f52fe39843b95fa8a00309a701ff9a5d6993f5f`

All three plans implement the issue's handshake: `ready <actionId>` beside
`complete`, matched against a durable last-accepted action id, accepted only
when newer than the last hook event, used once for a never-sent next action,
then deleted. They differ in where `ready` is cleared, how freshness is
measured, and how much else they change. Code references are to the baseline
`cd2798983651198c865cd37c494e8ac38062c109`.

## Findings

### F1 — all three plans: the agent rule ignores an `action.md` that acceptance already removed

- **Plan claim.** Cursor (protocol bullet): write `ready` "after the
  unchanged-`actionId` re-read". Codex (Handshake 1): "Only an unchanged
  `actionId` authorizes writing … a missing/unreadable action is not proof of
  an unchanged action." Claude (action.ts and protocol bullets): write `ready`
  "if the re-read shows the same `actionId`".
- **Rule.** The receipt has to be written in every state the agent can see
  after it has correctly finished an action and there is no new work. Accepting
  a submission deletes `action.md` (`src/runLoop.ts:1829` for Git,
  `src/runLoop.ts:2103` for response ballots). The next order is written only
  when the gate advances, which can be minutes later while peers finish.
- **Failure.** Agent A writes `complete`. The coordinator verifies and accepts
  before A's re-read; acceptance unlinks `action.md`, and the step still waits
  on peers. A's re-read finds no file. Under all three rules, A writes no
  `ready` (Codex forbids it outright). If A's Stop hook never reaches the issue
  (the issue 176 class), lifecycle stays `working`. When the gate advances, the
  next action meets a stale `working` with no receipt, and `deliver()` refuses
  with `no-idle-sentinel` — the exact stall this issue is meant to remove. The
  handshake only works when the agent wins a race against the coordinator's
  verify tick.
- **Smallest correction.** In both rendered footers and
  `templates/product/AGENTS.protocol.md`: "If `action.md` is missing, or still
  names the `actionId` you just completed, write `ready <the actionId you just
  completed>`." The coordinator's existing match against `lastAcceptedActionId`
  already makes that value safe. Add one `test/action.test.ts` assertion for
  the wording.

### F2 — cursor: `ready` is cleared on acceptance, so the main ordering never has a receipt

- **Plan claim.** Under `src/runLoop.ts`: "clear `ready` wherever
  `clearCompletion` already runs for drop/retire/accept transitions". Risks
  table: "also clear with `clearCompletion` on drop/retire".
- **Rule.** A receipt written before acceptance must survive acceptance. The
  plan's own Risks table says the agent may write `ready` before `complete` is
  accepted, and binding happens only when `markActionWorkflowComplete`
  records `lastAcceptedActionId`.
- **Failure.** In the normal ordering, the agent writes `complete`, re-reads
  the unchanged `action.md`, and writes `ready A`. The coordinator then accepts
  A. `accept()` calls `clearCompletion(runtime.complete)` at
  `src/runLoop.ts:1828` (and `:2102` for responses), and under this plan
  `clearReady` beside it, so `ready A` is deleted in the same mutation that
  makes it eligible. B is ordered against a stale `working` with no receipt and
  is deferred forever. Test case 1 would pass only because its fixture writes
  `ready` after acceptance, which is not how agents do it.
- **Smallest correction.** Do not clear `ready` at Git or response acceptance.
  Delete it only after a successful send, and optionally on drop, retire and
  owner recovery. Have the run-loop test write `ready A` before A is accepted.

### F3 — codex: counting telemetry as hook receipt makes Claude's receipt permanently stale

- **Plan claim.** Durable accepted identity 6: advance a hook-receipt
  timestamp and sequence "for normalized hook observations … including
  semantically duplicate observations and telemetry". Rule 7 then requires the
  receipt's write time to be "strictly later than the recorded hook-receipt
  time".
- **Rule.** Freshness may only be invalidated by evidence of new activity.
  Claude's status-line feed (`agent-event --event status-line`, normalized to
  `kind: "telemetry"` in `src/agentEvent.ts`) fires on status-bar renders,
  including the render that follows the agent's final `COORD-IDLE` line. The
  baseline deliberately treats it as "never counts as activity"
  (`applyTelemetry`, `src/agentLifecycle.ts:467`).
- **Failure.** Claude writes `ready A`, prints `COORD-IDLE`, and the status
  line re-renders. The telemetry observation advances the hook-receipt time
  past the receipt's mtime, so `ready A` is never eligible for Claude, the
  agent the issue's sample output comes from. Duplicate semantic observations
  have the same effect on any vendor with periodic callbacks.
- **Smallest correction.** Drop the new receipt record and sequence. Compare
  against `lastEventAt`, which already advances for every
  execution-relevant observation and for the first observation after a new
  order (`heartbeatNeeded`, `src/agentLifecycle.ts:695-698`). Keep the per-key
  `lifecycle-changed` snapshot for in-send races.

### F4 — codex: scope and test volume exceed the issue

- **Plan claim.** The file map touches 15 files, including `src/state.ts`
  (cursor schema), `test/paths.test.ts`, `test/state.test.ts` and
  `test/agentLanguage.test.ts`. It adds a lifecycle hook-receipt sequence,
  identity-checked cleanup keyed on stat identity, amendment-request
  acceptance binding, an `unknown`-lifecycle override threaded through
  `maybeLifecycleNudge`, a Codex composer refactor, and five
  "parameterize"/"table-driven" test groups.
- **Rule.** The action requires the smallest change that fully solves the
  issue and the fewest focused tests. Every new mechanism has to be justified
  by a failure it prevents.
- **Failure.** Several additions widen behaviour without an issue-169 failure
  to prevent:
  - The `unknown` override lets a receipt authorize typing into an agent whose
    hooks were never correlated. Today the initial delivery for that case is
    not blocked by lifecycle at all (`deliver()` vetoes only
    `working`/background/pending), so the only new effect is on idle-path
    re-sends, which the issue does not ask for.
  - Stat-identity cleanup, the receipt sequence (see F3) and amendment binding
    each add persisted state and test fixtures.
  - The Codex composer refactor changes the one override path that already
    works.

  The result is a much larger review and regression surface for the same
  user-visible fix.
- **Smallest correction.**
  - Store `lastAcceptedActionId` once, where acceptance already writes
    (`markActionWorkflowComplete`).
  - Limit the override to the existing never-sent `working` exception.
  - Keep the Codex path unchanged apart from the proof flag.
  - Keep one end-to-end `runLoop.test.ts` case plus render and parse
    assertions in `test/action.test.ts`.

### F5 — cursor: the issue's startup question is declared out of scope rather than answered

- **Plan claim.** Problem section and Alternatives: "`foreground-mismatch` at
  Terminal open is a separate delivery gate and is out of scope here".
- **Rule.** The issue asks directly about that startup output: "we need to
  understand why this happens and fix it". A plan for the issue has to at
  least explain the cause, even if it changes no behaviour.
- **Failure.** Implemented as written, the owner still sees `delivery to
  claude deferred: foreground-mismatch (bash); the foreground process is not
  this agent's harness` on every start, with no explanation. The likely
  cause: the first tick runs before the launcher shell hands the pane to the
  harness, and the nudge then goes out a second later (issue 169 journal,
  22:48:48 → 22:48:49). The issue's question stays open.
- **Smallest correction.** State that cause in the plan and docs, as Codex's
  Reuse section and Claude's Diagnosis do. Optionally reword the human text
  while no lifecycle session exists, keeping the code unchanged.

### F6 — claude (self-review): the post-send stdout change needs its own test assertion

- **Plan claim.** `journalDeferral`: `gateWaiting` also requires that the
  lifecycle action is still `delivery: "ordered"`. Test 1, last step, checks
  that a `working` deferral after the send is journaled with
  `gateWaiting: false`.
- **Rule.** Every behavioural change needs a test that fails before it. This
  change also affects a Codex `unknown` deferral after injection, which Test 1
  (a Claude fixture) does not cover.
- **Failure.** An implementation could suppress only the `working` code (for
  example by special-casing it), pass Test 1, and still print `deferred:
  unknown; no lifecycle signal has been correlated yet` after every successful
  Codex send — one of the two misleading lines quoted in the diagnosis.
- **Smallest correction.** In the existing "journals each deferred reason once…"
  Codex fixture, after the send succeeds, assert that the `unknown` deferral
  row has `gateWaiting: false` and is not in `messages`.

### Scope, reuse and file justification

- **Cursor** reuses the right owners (`action.ts` parsing, `agentRuntimePaths`,
  `markActionWorkflowComplete`, the `staleWorking` path). It creates no product
  files. Its docs edits are proportionate. Apart from F1, F2 and F5 it is
  within scope, with focused tests.
- **Codex** has the most careful safety analysis: symlinked receipts, never
  consuming on a pre-send refusal, keeping the receipt across a startup `bash`
  refusal. It creates no new files, but see F3 and F4.
- **Claude** is the smallest change. It reuses the same owners and adds no
  product files. Its only fix beyond the receipt is the two operator messages
  that the issue's own symptoms trace to. Subject to F1 and F6.

## Conclusion

No plan is acceptable unchanged, because F1 affects all three: the agent-side
rule has to cover an `action.md` that acceptance already removed, or the
handshake fails whenever the coordinator verifies before the agent re-reads.

- **Cursor** also loses every receipt at acceptance (F2), which defeats the
  feature in its most common ordering.
- **Codex** also makes Claude's receipt permanently stale by counting
  telemetry (F3), and is broader than the issue needs (F4).
- **Claude**, with F1 applied and the F6 assertion added, is the smallest
  correct basis. Worth carrying over from Codex: keep the receipt across
  pre-send refusals, and refuse symlinked or non-regular receipts.
