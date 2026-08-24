# Plan review — issue 109

Bound plans reviewed:

- Cursor `bcf63b62794fb8245d8eabb16d35d38f88ee51e3` at `.plans/issue-109/plan.md`
- Claude `0a7d41e2ee6135ebc5e1c4777be0226e1cb38c04` at `.plans/issue-109/plan.md`
- Codex `a651dc57a1d1cddbf647decc0f7daf9fa2bfe8bd` at `.plans/issue-109/plan.md`

## Findings

### Cursor — `src/cli.ts` drop handling still recomputes selection summaries

**Plan claim:** `src/cli.ts` — “Update `rederiveAfterDrop` to recompute/invalidate
derived plan and implementation selections from remaining accepted evidence.”

**Rule:** Coordinator derivation must be idempotent, journaled exactly once per
durable decision identity, and applied under the run-loop state lock — not from
a parallel CLI path during owner drop handling.

**Failure:** The current `rederiveAfterDrop` already recomputes winners with
`deterministicWinner` and writes `cursors.selection` directly. Following this
plan without narrowing the CLI role repeats that pattern against `derived`,
creating the same dual-path race and duplicate-journal risk as Codex’s plan.

**Smallest correction:** Invalidate affected `derived` slots in `dropAgent`; have
the CLI filter accepted rows and clear owner questions only; leave
re-derivation and journaling to the next coordinator tick.

### Cursor — changed-file list omits required test and fixture updates

**Plan claim:** The Tests section names eleven files; it does not list
`test/action.test.ts`, `test/cursorHookUsage.test.ts`, or
`test/support/fixtures/analytics-journal.jsonl`.

**Rule:** After `RUNTIME_FORMAT_VERSION` 2 → 3 and removal of `expected*` order
fields, every fixture that seeds format 2 journals or obsolete order shapes must
be updated or `pnpm check:fast` fails.

**Failure:** `test/action.test.ts` fixtures still carry `expectedSelectedAgents`;
`test/cursorHookUsage.test.ts` seeds `formatVersion: 2` journal events; and
`analytics-journal.jsonl` is entirely format 2. An implementer following Cursor’s
file list alone will ship a broken test suite.

**Smallest correction:** Add all three paths to the changed-file list (Codex
includes them explicitly).

### Cursor — `cursors.selection` retirement is underspecified

**Plan claim:** `src/state.ts` — “Replace or retire `cursors.selection` so
downstream routing cannot drift from derived evidence.”

**Rule:** Issue 109 forbids parallel summary fields that can drift from cited
evidence; canonical routing must read only `cursors.derived`.

**Failure:** “Replace or retire” leaves room to keep a mirrored `selection`
object updated alongside `derived`. Any missed write path restores the exact
drift the issue removes, and drop/rebind logic would have to maintain two
authorities.

**Smallest correction:** Delete top-level `reviser`, `selection`, and obsolete
`acceptedSubmission` result fields outright, as Claude and Codex specify.

### Codex — `src/cli.ts` drop handling recomputes and journals derived decisions

**Plan claim:** `src/cli.ts` replaces selection-summary mutation with
“dependency-aware invalidation and recomputation of canonical derived decisions,
journal replacements with the prior decision identity as superseded,” and
“clear/reissue downstream work whose binding changed.”

**Rule:** Coordinator derivation must be idempotent, journaled exactly once per
durable decision identity, and applied under the run-loop state lock — not from
a second code path during owner CLI drop handling.

**Failure:** If `coord drop` recomputes winners, writes `cursors.derived`, and
appends `decision-derived` events while the run loop uses a separate derivation
path, the same roster/input set can produce duplicate journal entries, divergent
`decidedAt` timestamps, or a persisted decision that the next tick recomputes
again because the machine never emitted the matching pure decision. Drop would
also race with an in-flight tick that read pre-drop accepted evidence.

**Smallest correction:** Invalidate affected `derived` slots in `dropAgent`,
filter accepted rows, and clear owner questions in the CLI; leave all
re-derivation and journaling to the next coordinator tick (as Claude’s plan
states explicitly).

### Codex — live operator docs omit `docs/coord-driver.md`

**Plan claim:** The changed-file list updates `docs/analytics.md` only; it does
not name `docs/coord-driver.md`.

**Rule:** Acceptance requires documentation to describe the new phase topology
and coordinator-owned decisions; `docs/coord-driver.md` today still describes
plan selection, reviser storage, and authorized-reviser drop policy in terms of
agent-published artifacts and top-level selection/reviser fields.

**Failure:** Operators following coord-driver after implementation will still
believe selection, reviser authorization, and consensus declaration are agent
artifacts, and will not see wipe/restart guidance for runtime format 3.

**Smallest correction:** Add `docs/coord-driver.md` to the changed-file list
with the same derived-state / `decision-derived` / 10-6-4 topology updates both
other plans include.

### Codex — no dedicated derivation module or unit tests

**Plan claim:** “Exact file list to be created: None.” Derivation logic is implied
to live inside existing `src/machine.ts` and `src/runLoop.ts` changes only.

**Rule:** Each derived decision must be pure, reproducible from cited accepted
inputs, and covered by focused unit tests (issue “Required tests” lists
plurality, tie-break, exclusion, idempotency, and consensus null cases).

**Failure:** Without a shared pure module (`src/derive.ts` or equivalent) and
`test/derive.test.ts`, election and consensus preconditions are tested only
indirectly through large machine/runLoop fixtures. A bug in input eligibility,
pin resolution, or hash identity is harder to localize and easier to miss when
`escalate`/`revise` ordering changes.

**Smallest correction:** Add `src/derive.ts` and `test/derive.test.ts` as Claude
proposes; keep machine/runLoop responsible only for emitting/applying decisions.

### Claude — `src/derive.ts` ↔ `src/runLoop.ts` import cycle

**Plan claim:** `src/derive.ts` imports `deterministicWinner` from
`src/runLoop.ts`; `src/runLoop.ts` imports `src/derive.ts` for
`applyDerivedDecision`.

**Rule:** Module graph must remain acyclic so `pnpm typecheck` and the Node ESM
build load deterministically.

**Failure:** A direct mutual import between `derive.ts` and `runLoop.ts` creates
a circular dependency. Even if TypeScript accepts it today, initialization order
can leave `deterministicWinner` undefined at first use or force brittle
refactors later.

**Smallest correction:** Move `deterministicWinner` into `src/derive.ts` (or a
small `src/election.ts`) and import it from both `runLoop.ts` and `cli.ts`.

### Claude — decision hash reuses artifact `computeInputSetHash`

**Plan claim:** `src/derive.ts` imports `computeInputSetHash` from
`src/evidence.ts` for derived-record `inputSetHash` / `decisionId`.

**Rule:** Derived decision identity must incorporate decision kind, active-roster
order used for eligibility/tie-break, revision round (consensus), and the exact
accepted input citations so a roster reorder or profile boundary change yields a
new durable identity even when ballot SHAs are unchanged.

**Failure:** `computeInputSetHash` hashes sorted `BoundInput` tuples only. It does
not include roster order or decision kind. Two runs with identical ballot/plan
SHAs but different `activeRoster` order (after a permitted drop/reorder) would
collide on `decisionId`, breaking idempotent apply and supersession journaling.

**Smallest correction:** Add a decision-specific hash helper (Codex’s
length-prefixed kind + roster + round + citations encoding) and use it for
`decisionId`; keep artifact `inputSetHash` for published JSON only.

### Claude — format-version fixture updates incomplete

**Plan claim:** Tests changed lists eleven files; it does not name
`test/cursorHookUsage.test.ts` or
`test/support/fixtures/analytics-journal.jsonl`.

**Rule:** After `RUNTIME_FORMAT_VERSION` 2 → 3, every persisted document reader
and strict journal fixture must use the new literal or tests fail closed.

**Failure:** `test/cursorHookUsage.test.ts` seeds multiple journal events with
`formatVersion: 2`, and `analytics-journal.jsonl` is entirely format 2. A
follower of Claude’s file list alone will leave failing tests after the bump.

**Smallest correction:** Add both paths to the changed-file list and bump their
fixtures to format 3 (Codex includes these explicitly).

### Claude — `test/protocol.test.ts` declared unchanged

**Plan claim:** “`test/protocol.test.ts` needs no change (it never exercised the
three removed schemas).”

**Rule:** Active `publishedArtifactSchema` must reject removed discriminators
(`selection`, `reviser-authorization`, `consensus-declaration`) so a re-added
branch cannot slip through silently.

**Failure:** With no negative protocol tests, removing union members is verified
only by compilation. A partial revert or merge conflict that reintroduces one
schema would pass fast tests until an integration run hits the obsolete path.

**Smallest correction:** Add negative discriminator cases as Codex’s plan
requires.

## Conclusion

All three bound plans (`bcf63b62794fb8245d8eabb16d35d38f88ee51e3`,
`0a7d41e2ee6135ebc5e1c4777be0226e1cb38c04`, `a651dc57a1d1cddbf647decc0f7daf9fa2bfe8bd`)
align on the core goal — delete the three deterministic agent phases, persist
canonical `derived` state, journal `decision-derived`, and fail closed on runtime
format 2. Claude’s plan is strongest on module boundaries, lock-safe
`derive-decision` semantics, `assertRuntimeFormat`, and numbered test cases;
Codex’s is strongest on decision-hash specification, protocol negatives, and
fixture breadth; Cursor’s matches the issue scope but shares Codex’s CLI
re-derivation ambiguity and omits several files both peers name.

No bound plan is safe to implement verbatim without corrections: Cursor and Codex
must not derive or journal from the CLI drop path; Cursor must delete (not
“retire”) parallel selection summaries and extend its test/fixture file list;
Codex must document coord-driver and adopt a pure derivation module; Claude must
break the derive/runLoop import cycle, use a decision-specific hash, extend
fixture updates, and add protocol negative tests. A merged implementation plan
with Claude’s structure, Codex’s hash/fixture/protocol detail, and a single
coordinator-side derivation path will satisfy the issue acceptance criteria.
