## Comparison

The exact bound implementations reviewed were:

- cursor: `0ea934235417926b4b8ba1c258b01959745878f0`
- codex: `564ab5e7ca90dc682c970184b24fe0d3b4ddbf59`
- claude: `fd9eff090797bb9efbcad51856c08ec2c378a762`

### Findings

1. **Cursor — `src/cli.ts:300-365` (P1).** A permitted drop must recompute every roster-bound canonical decision, journal its supersession, invalidate changed downstream bindings, and rewind to the earliest affected agent-facing step. This implementation only clears current-step evidence and actions after `dropAgent`; it never re-derives or rewinds. Because `dropAgent` can null an implementation decision while leaving the cursor at `R6.revise`, the next tick reaches `src/machine.ts:55-59` and silently substitutes `activeRoster[0]`, preparing revision work for an agent who did not win the implementation ballot. A focused CLI test should seed a selected implementation, drop a cited non-reviser, and assert a superseding decision plus either unchanged exact bindings or a rewind before any new action.

2. **Cursor — `src/runLoop.ts:214-226` (P1).** A plan-decision identity must cover the decision kind, ordered active roster, every active accepted eligible plan, and every active accepted plan ballot so the result is reproducible from its citations. This code hashes and records only ballots. Replacing an accepted plan SHA/path while leaving ballots unchanged therefore reuses the old identity and audit event even though the eligible input set changed; the stored record also cannot reproduce why the winner was eligible. The same hash helper used at `src/runLoop.ts:247` and `src/runLoop.ts:276` also omits decision kind, roster order, and consensus round from `inputSetHash`.

3. **Cursor — `src/runLoop.ts:1366-1395` (P1).** A content-addressed `decision-derived` event must be exact-once across a crash between journal append and cursor replacement, and the decision must be re-derived from the locked current state. Here the precomputed record is appended unconditionally inside the mutation with no identity lookup. A crash after line 1390 durably appends the event but before the cursor file replacement causes the retry to append the same decision a second time; a concurrent roster mutation can also make the record stale before it is stored. The smallest test should pre-seed the journal event while leaving the slot null, run one tick, and assert one event and a record whose `decidedAt` reuses that event timestamp.

4. **Claude — `src/cli.ts:397-415` (P1).** When a drop makes a previously derived plan election underdetermined, the workflow must return to `R3.plan-ballot`; it must never resume implementation without a canonical plan decision. If the dropped selected-plan agent had received every remaining active ballot, `derivePlanSelection` returns `null`, but this branch clears work from `R4.implement` and rewinds only to `R4.implement`. The machine then falls back to the first active participant, while `selectedPlanAgents` binds all remaining plans, so an implementation action is issued without any selected plan. A regression test should derive a unanimous plan winner distinct from the implementation reviser, drop that winner during revision, and assert a rewind to `R3.plan-ballot` with no `R4.implement` action until a replacement decision exists.

5. **Codex — `src/state.ts:349-355` (P2).** Persisted derived-decision schemas must fail closed unless they contain exact accepted-input citations and a decision identity structurally tied to kind, hash, and round. This base schema accepts `inputs: []` and an arbitrary non-empty `decisionId`; a syntactically valid but incomplete cursor file can therefore route revision or finalization from an unverifiable winner/pin instead of rejecting the runtime. Require at least one citation, use a structured identity schema, and cross-check the identity against the record kind and consensus round.

### Relative assessment

1. **Codex `564ab5e7ca90dc682c970184b24fe0d3b4ddbf59` is the preferred base.** It includes policy-complete, length-prefixed hashes; re-derives under the state lock; deduplicates crash-retry journal events; refuses silent missing-decision routing; and handles permitted drops by recomputing or rewinding to the prerequisite ballot. Its remaining finding is a persisted-schema hardening issue rather than a normal-workflow routing failure.
2. **Claude `fd9eff090797bb9efbcad51856c08ec2c378a762` is second.** It has the strongest structured state schemas and broad focused coverage, but the underdetermined-drop path can occur in an otherwise valid run and advances without the canonical decision the change is meant to establish.
3. **Cursor `0ea934235417926b4b8ba1c258b01959745878f0` is third.** Its direct phase removal works on the happy path, but its incomplete identities, non-idempotent persistence, and lack of drop recomputation miss central acceptance requirements.

### Verification

- Codex: `pnpm check` passed at the bound product commit (466 fast tests and 2 end-to-end tests in the checked suite).
- Claude: an independent `pnpm check:fast` run passed (495 tests).
- Cursor: lint and typecheck passed; 461 tests passed, while one `coord onboard` test exceeded its 15-second timeout in the comparison worktree. The ranking above is based on the reproducible code-path findings, not that timing-only result.
