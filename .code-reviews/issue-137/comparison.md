## Comparison

Protocol version: 1. Issue 137. Reviewed the coordinator-exported worktrees at
these exact product pins, not moving branch tips:

| Candidate | Implementation pin |
| --- | --- |
| Cursor | `13804a10c6fdb0965c79d016559397fe4adf304b` |
| Claude | `f8543ea6bd7fe695ecb1b25638a29100d67cff3c` |
| Codex | `a4d2b46480d89b5dfcd79991e520530b4ed427ac` |
| Antigravity | `b915e8c9f45a032a4afa1498ef229083de8ac1e8` |

### Confirmed findings

1. **[P1] Cursor `src/evidence.ts:167-170,343,373`; Claude
   `src/evidence.ts:167-170,387,418`; Antigravity
   `src/evidence.ts:197-200,442,480`.** An amendment must authorize only the
   exact additional files approved by the voters, not a directory tree.
   These implementations merge additions into the legacy map and apply its
   prefix matcher without retaining exact-file semantics. Consequently,
   approving `test/product.test.ts` also permits a product pin changing
   `test/product.test.ts/unapproved.ts`, although nobody approved that file.
   A literal extensionless addition can likewise become a directory grant.
   This affects both implementation and revision checks. A focused test should
   supply the current scope hash, put the exact addition in the effective map,
   return only its descendant from `changedPaths`, and require rejection.
   Direct probes returned `satisfied` for all three candidates; Codex returned
   `rejected` using its separately tracked exact additions.

2. **[P1] Cursor `src/runLoop.ts:2632-2642`; Claude
   `src/runLoop.ts:2383-2385`; Antigravity `src/runLoop.ts:1754-1763`.** Request
   admission must become durable before the old action and its completion
   marker are destroyed, or retain a durable recovery intent for those
   effects. These paths delete them before the cursor replacement succeeds.
   A crash or cursor-write error at that boundary leaves the durable state
   on the old implementation action, with no pending amendment, no action
   file, and no completion marker to retry. Normal polling does not reconstruct
   this proposal from the amendment journal event, so an ordinary restart
   stalls until external recovery/resubmission. A fault-injection test should
   let the mutation callback finish, fail before cursor persistence, restart,
   and require the submitted request to remain recoverable. I exercised that
   boundary against each pinned implementation: all three removed both files
   while the persisted cursor remained at `R4.implement`. Codex preserved both;
   it saves the transition and retirement intent before draining cleanup.

3. **[P2, selected-plan compliance] Cursor `src/evidence.ts:336`; Claude
   `src/evidence.ts:380`; Antigravity `src/evidence.ts:435`.** The selected plan
   explicitly requires a missing coordinator-approved map to fail closed,
   never to be replaced by the submitter's claimed map. All three retain the
   self-declared `approvedPaths` fallback. If the coordinator's map is empty,
   a signal can therefore authorize its own changed files and be accepted
   without that scope having been established. This is a retained fallback,
   not a newly introduced baseline regression, but the approved plan calls
   for removing it. The empty-map probe with otherwise valid signal/pin
   bindings was accepted by all three; Codex rejected it.

### Scope, reuse, and coverage

- **Cursor:** Stays within the approved product path list and reuses existing
  evidence, state, private-response, and publication machinery. Its helpers
  for selected-plan identity and scope binding are issue-related, not a new
  general workflow engine. However, the published changes do not extend
  `test/integration.test.ts`, despite the selected plan's real-Git amendment
  canary requirement. Its added run-loop map-union test does not substitute
  for admission, publication, restart, and resume coverage. Findings 1–3
  prevent selecting this pin as ready.
- **Claude:** Also stays within scope, reuses existing protocol and runtime
  helpers, and extends existing test files rather than creating a new harness.
  It records deferred requesters, carries rejection reasons, filters approvals
  by exact selected-plan citations, and adds the real-Git implementation
  amendment route. Those are useful, focused choices. Its scope matcher and
  pre-persistence cleanup nevertheless have findings 1–3.
- **Antigravity:** Uses the existing ballot publication pipeline and existing
  unit/integration fixtures, with a real-Git implementation amendment route.
  The new derived scope records and conditional step address the issue rather
  than unrelated cleanup. It has the same confirmed findings 1–3; its cleanup
  begins even before entering the guarded state mutation.
- **Codex:** Stays within the same approved map, reuses the existing evaluator,
  materializer, publication outbox, and fixtures, and adds no product/test
  files, dependencies, or hook changes. The retirement queue is narrowly
  justified by finding 2. Exact additions remain distinct from legacy tree
  entries, and empty approved maps fail closed. Scope evidence is separate
  from revision ancestry. Its extended existing canary covers an accepted
  peer pin and unfinished edits, partial-ballot restart, failed push and
  exact-SHA retry, an owner pause after the push, rejection, a later approved
  revision amendment, and finalization with the same single product parent.
  Unit coverage includes all profiles, selected-plan replacement, drop
  cancellation, retirement recovery, and stale completion rejection. I found
  no blocking issue in the inspected amendment paths at this pin.

All four published product path sets remain within the selected plan; none
adds a dependency, changes the product hooks, or introduces a new source/test
file. The differences above concern correctness and focused coverage, not
preference for a larger implementation.

### Validation

Executed 12 isolated confirmation probes importing the exact bound worktrees:
one descendant-path probe, one empty-map probe, and one interrupted-admission
probe per candidate. They confirmed the outcomes described above. The probes
stubbed Git evidence for the scope checks and injected a cursor-persistence
failure for the durability check; they were not full peer test-suite runs.
Scratch files remain outside the product tree under
`/private/tmp/coord-issue-137/.codex/tmp/`.

The Codex product pin also passed full `pnpm check` during implementation:
build, lint, both typechecks, 680 fast tests, and two end-to-end tests. I did
not rerun the full suites for the other three pins and do not infer their
results from their readiness signals.

Before publishing this comparison, `pnpm check:fast` passed all 680 tests,
lint, and typechecks on an unchanged rerun. The first run had 679 passing
tests and a 15-second timeout in `test/onboard.test.ts:68`; no product or
test changes were made to obtain the passing rerun.

## Verdict

Prefer **Codex `a4d2b46480d89b5dfcd79991e520530b4ed427ac`**. It directly avoids
the demonstrated scope expansion and request-loss failures and has the most
complete exercised recovery path among these pins. Cursor, Claude, and
Antigravity need the findings above addressed before approval.
