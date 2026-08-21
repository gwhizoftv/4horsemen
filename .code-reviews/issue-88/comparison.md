# Issue 88 implementation comparison

Bound implementation pins, each checked out at its exact SHA and executed:

- cursor: `2eb72a07ab9b02a575ab7483d21ca2fbb8dfa231`
- antigravity: `4eadf9f357d593e3c6abf88ca4008ff61d74d525`
- claude: `3662cc094cd9f12ec0a82f56e8d6a9e4da652536`
- codex: `9b2c05b6dc4e8d6780492972e5b572fc4d299f82`

All four converged on the same shape: a new `src/agentLanguage.ts` holding a
banned-term list and an `EvidenceId → agent-facing subject` map, the
`participation-ready` token and path rename, the footer rewrite in
`src/action.ts` and `templates/product/AGENTS.protocol.md`, the version bump,
and a new `test/agentLanguage.test.ts`. All four route `src/evidence.ts:212`
through `agentFacingSubject(order.evidenceId)`, closing the leak that three of
the four plans had missed. Every pin passes lint, both typechecks, its own fast
suite, and the e2e canary.

The differences that matter are in what each suite can actually detect.

## Comparison

### 1. claude `3662cc094cd9f12ec0a82f56e8d6a9e4da652536` — the language suite cannot detect the leak it was written to prevent

**File and line:** `test/agentLanguage.test.ts:180-190` ("keeps internal
vocabulary out of the correction block"), against `src/evidence.ts:212`.

**Rule that must hold:** a test for a leak must observe the code path that
produces it. Feeding a value into the renderer and asserting the same value
comes back proves the renderer is transparent, not that the producer was fixed.

**Concrete failure:** the test builds its `outstanding` array from
`agentFacingSubjects()` — the very map the fix installs — and asserts the
rendered action is clean. It never calls `evaluateEvidence`, so nothing
connects `pinErrors` to that map. Reverting `src/evidence.ts:212` to
`subject: \`${order.evidenceId} artifact\`` and running
`vitest run test/agentLanguage.test.ts test/evidence.test.ts` at this pin gives
**61 passed, 0 failed**. The same mutation applied to the other three pins fails
a test in each:

| pin | result with the leak reintroduced |
| --- | --- |
| cursor `2eb72a07ab9b02a575ab7483d21ca2fbb8dfa231` | FAIL `uses outcome subjects for pin-validation outstanding text` (1 failed / 57 passed) |
| antigravity `4eadf9f357d593e3c6abf88ca4008ff61d74d525` | FAIL `does not leak evidenceId in pin-lineage rejection messages` (1 failed / 58 passed) |
| codex `9b2c05b6dc4e8d6780492972e5b572fc4d299f82` | FAIL `uses outcome language rather than an internal evidence id in pin rejection details` (1 failed / 86 passed) |
| claude `3662cc094cd9f12ec0a82f56e8d6a9e4da652536` | **all 61 pass — leak undetected** |

`grep -c 'evaluateEvidence' test/agentLanguage.test.ts` is 0 at this pin, and
`test/evidence.test.ts` gained no pin-subject assertion (+12 lines, all
fixture renames). This is the acceptance criterion the whole change exists to
serve, and it is the one criterion this pin cannot regression-test.

**Smallest correction:** add codex's test verbatim — stub `validatePhasePin` to
return `` `${subject} failed immutable ancestry validation` ``, run
`evaluateEvidence` on an `implementation-pinned` order, and assert
`outstanding` contains `the implementation signal` and not
`implementation-pinned`.

### 2. antigravity `4eadf9f357d593e3c6abf88ca4008ff61d74d525` — ships a file its own checker rejects

**File and line:** `templates/product/AGENTS.md:34`, against
`src/agentLanguage.ts:15` (`{ label: "gate-vocabulary", pattern: /\bgates?\b/i }`).

**Rule that must hold:** if a term is banned from installed agent guidance, the
installed agent guidance must not contain it, and the suite must scan the file
that carries it.

**Concrete failure:** this pin changes only the "R7 finalization" sentence in
that template and leaves line 34 reading "and they gate pull-request creation".
Running this pin's own `findAgentLanguageViolations` over its own shipped file
returns `["gate-vocabulary: gate"]`. Its suite passes anyway because
`grep -c 'templates/product/AGENTS.md' test/agentLanguage.test.ts` is **0** — it
scans `renderAgentsProtocolBlock` but never the product template. cursor,
codex, and claude all scan it and all reworded the sentence. The user-visible
consequence: `coord install --write-product` writes gate vocabulary into a
product repository, so acceptance criterion 1 fails on a file this change
explicitly set out to clean.

**Smallest correction:** reword line 34 to "and they must pass before
pull-request creation" (codex's and cursor's wording) and add the file to the
template scan.

### 3. antigravity `4eadf9f357d593e3c6abf88ca4008ff61d74d525` — weakens the evidence-id rule instead of resolving the collision

**File and line:** `src/agentLanguage.ts:17` —
`/\b[a-z]+(?:-[a-z]+)*-(published|pinned|declared|verified)\b/`, with
`authorized` removed from the alternation the other pins carry.

**Rule that must hold:** every `EvidenceId` must be detectable in agent-facing
text; the list is the whole point of the module.

**Concrete failure:** `reviser-authorized` is now unmatched. Probing each pin's
compiled checker with the exact string a reverted `subject` would emit —
`"reviser-authorized artifact pins abc, which is not an ancestor of current
origin tip"` — gives `MISSED` for antigravity and `CAUGHT` for cursor, codex,
and claude. The exposure is a future prose leak rather than a live one, because
this pin's `test/evidence.test.ts` still covers the current call site through
`implementation-pinned`; but the one evidence id whose name also appears in a
published path is precisely the one it stopped checking, and nothing records
why.

**Smallest correction:** codex's second entry,
`{ label: "evidence-id", pattern: /\breviser-authorized\s+artifact\b/i }`, which
matches the internal label form while leaving the published path alone.

### 4. cursor `2eb72a07ab9b02a575ab7483d21ca2fbb8dfa231` — the checker reports one match per term

**File and line:** `src/agentLanguage.ts:21-30` —
`const matcher = new RegExp(term.pattern.source, "i"); const matched = text.match(matcher);`
(no `g` flag, single `match` rather than `matchAll`).

**Rule that must hold:** a violation report should name every violation, since
the maintainer fixing a leaky action body works from that list.

**Concrete failure:** `findAgentLanguageViolations("R1.join and R2.plan and R3.review")`
returns **3** entries at this pin (`internal-round-label: R1`,
`internal-step-id: R1.join`, `join-vocabulary: join`) where antigravity, codex,
and claude each return **7**, naming `R2`/`R3` and `R2.plan`/`R3.review` too. A
maintainer fixing the first reported leak re-runs and is handed the next one,
one round-trip at a time. Detection itself is unaffected — the array is still
non-empty, so `toEqual([])` still fails — so this is diagnostic quality, not a
missed leak.

**Smallest correction:** `for (const match of text.matchAll(new RegExp(term.pattern.source, "gi")))`.

### 5. cursor `2eb72a07ab9b02a575ab7483d21ca2fbb8dfa231` and claude `3662cc094cd9f12ec0a82f56e8d6a9e4da652536` — a published path changed to satisfy the test, and they disagree on the new name

**File and line:** `src/steps.ts:128` in both pins.

**Rule that must hold:** an invariant test added to protect agent-facing prose
should not force a change to a published protocol path. `reviser-authorized.json`
is outcome-named and is not phase jargon; it collides with the checker only
because both pins wrote a suffix-shaped evidence-id rule
(`-(published|pinned|authorized|declared|verified)`) that matches it.

**Concrete failure:** cursor renames the path to
`.signals/issue-<n>/revision-authorization.json`; claude renames it to
`.signals/issue-<n>/reviser-authorization.json`; antigravity and codex leave it
at `.signals/issue-<n>/reviser-authorized.json`. Beyond the R1 rename that all
four share, these two impose a second contract break: an issue sitting at
`R5.reviser-auth` across the upgrade gets `required artifact ... is missing`,
burns a rejection round, and recovers only on reissue. The two names are also
mutually incompatible, so the churn is not even convergent. codex demonstrates
the collision is avoidable: an exact-alternation rule plus one targeted pattern
covers the same regression with no path change.

**Smallest correction:** revert `src/steps.ts:128` to
`.signals/issue-${issue}/reviser-authorized.json` and adopt codex's two-entry
evidence-id rule.

### What each pin verifies

| pin | fast suite | language tests | e2e | scans product AGENTS.md | catches reverted `subject` |
| --- | --- | --- | --- | --- | --- |
| cursor `2eb72a07ab9b02a575ab7483d21ca2fbb8dfa231` | 378 pass | 5 | pass | yes | yes |
| antigravity `4eadf9f357d593e3c6abf88ca4008ff61d74d525` | 379 pass | 6 | pass | **no** | yes |
| claude `3662cc094cd9f12ec0a82f56e8d6a9e4da652536` | 380 pass | 9 | pass | yes | **no** |
| codex `9b2c05b6dc4e8d6780492972e5b572fc4d299f82` | 407 pass | 34 | pass | yes | yes |

One `test/integration.test.ts` failure appeared for antigravity
`4eadf9f357d593e3c6abf88ca4008ff61d74d525` on the first sequential run and did
not reproduce across three further runs; it is reported here as a flake, not a
defect. `test/onboard.test.ts` times out under parallel load on the unmodified
baseline `26de98aae01426d582d17d15d1e33e1b6b3e3f90` as well, so it is
pre-existing and attributable to no pin.

## Verdict

codex `9b2c05b6dc4e8d6780492972e5b572fc4d299f82` is the strongest
implementation and the only one against which this comparison found no defect.
It carries the most coverage by a wide margin (34 language tests, 407 in the
fast suite), it is the only pin that resolves the `reviser-authorized`
collision without either weakening the rule or renaming a published path, and
its evidence-layer assertion is the sharpest test of the actual leak — it stubs
`validatePhasePin`, runs `evaluateEvidence`, and asserts on real `outstanding`
output rather than on strings the test itself supplied.

cursor `2eb72a07ab9b02a575ab7483d21ca2fbb8dfa231` is correct and complete; its
two issues are the first-match-only reporter and the avoidable path rename.

antigravity `4eadf9f357d593e3c6abf88ca4008ff61d74d525` ships a template its own
checker rejects and silently drops one evidence id from the rule, both of which
are unblocked only by gaps in its own scan coverage.

claude `3662cc094cd9f12ec0a82f56e8d6a9e4da652536` — my own pin — has the
weakest verification of the four despite the most prose about verification. Its
correction-block test is circular, it adds no evidence-layer assertion, and the
mutation above shows it would ship the reintroduced `evidenceId` leak green. It
also renames a published path that did not need renaming. On the evidence
gathered here it should not be selected over codex or cursor.
