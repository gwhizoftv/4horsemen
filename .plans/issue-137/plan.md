# Issue 137 — agreed, additive corrections to the selected plan's file map

Protocol version: 1. Baseline: 3d1bf995c2327978374d863c16828a24e311c159.

The issue asks for agreement on overlooked files needed to finish the original
scope, not permission to change the feature or bypass verification. Add an
on-demand amendment ballot during implementation or revision. The selected
plan stays pinned and immutable; a published, unanimously approved addendum
extends its effective file map. Ordinary workflows never enter this detour.

## Exact File List to be changed or deleted

Product changes, with no deletions:

| File | Necessary change |
| --- | --- |
| `src/protocol.ts` | Strict amendment-request, private amendment-ballot, and published amendment-ballot schemas; optional scope-binding field on implementation/revision signals for compatibility. |
| `src/steps.ts` | One conditional amendment-ballot definition and its evidence identifier; typed amendment observation/decisions and order scope metadata; round handling that distinguishes amendment sequence from revision round. |
| `src/state.ts` | Default-empty amendment history and nullable pending request/resume state, ballot discriminants, and durable request/decision journal events. Preserve format-4 issues without amendments. |
| `src/evidence.ts` | Recognize the alternate request artifact only for authorized implementation/revision actions; validate bindings and exact additions; enforce the effective approved map and scope binding on subsequent product signals. |
| `src/machine.ts` | Conditional detour, complete active-roster denominator, publication-before-authorization, unanimous decision, and return to saved work without consuming a revision round. |
| `src/runLoop.ts` | Admit/freeze requests, prepare ballots, persist/resume the detour, resolve effective paths and scope identity, materialize evidence, and preserve existing work and safety checks. |
| `src/ballotResponse.ts` | Parse the amendment ballot through the existing private-response reader and action-ID validation. |
| `src/ballotPublication.ts` | Amendment batch kind, sequence-specific canonical paths, and canonical ballots citing the exact request and selected plan evidence; reuse existing publication machinery. |
| `src/orderScaffold.ts` | Render the alternative request JSON, amendment judgment JSON, and current scope binding in implementation/revision scaffolds. |
| `src/action.ts` | Render separately bound scope evidence without mixing it into the single authorized product input for revisions. |
| `src/materializedInputs.ts` | Export amendment request/approval JSON as bound documents using the existing content-addressed packet machinery. |
| `src/agentLanguage.ts` | Register the new evidence identifier and its plain-language artifact name. |
| `src/cli.ts` | Make existing drop/reset recovery cancel stale pending amendment ballots and retain only amendments applicable to the surviving selected-plan identity. No new command. |
| `templates/product/AGENTS.protocol.md` | Document the coordinator-offered amendment request and the prohibition on treating a request as approval. |
| `docs/coord-driver.md` | Describe request, unanimity, resume, refusal, restart, and drop semantics and their evidence trail. |

Existing test files to extend or adapt only for this feature:

- `test/protocol.test.ts`
- `test/evidence.test.ts`
- `test/machine.test.ts`
- `test/runLoop.test.ts`
- `test/ballotResponse.test.ts`
- `test/ballotPublication.test.ts`
- `test/state.test.ts`
- `test/cli.test.ts`
- `test/orderScaffold.test.ts`
- `test/action.test.ts`
- `test/agentLanguage.test.ts`
- `test/integration.test.ts`

## Exact file list to be created

No new product, test, dependency, configuration, or hook files. This planning
action creates only `.plans/issue-137/plan.md`. Runtime state, agent request
artifacts, and coordinator-published ballot evidence are generated protocol
outputs, not additional source files.

## Reuse and Scope

### Existing behavior and reuse

`evaluateEvidence` already checks the fetched branch, required artifact,
immutable product pin, lineage, input hash, and approved file map.
`extractApprovedPaths` and `resolveApprovedPaths` recover paths from the exact
accepted plan SHA, not a mutable branch tip. Keep that behavior, including
extractor-upgrade support; editing an agent's plan later must not change scope.

Reuse `buildOrder`, `deriveBoundInputs`, `approvedPathsForOrder`,
`resolveApprovedPaths`, `participantsForStep`, and `decide` rather than creating
a second workflow engine. Reuse `readAgentResponse`, `parseBallotResponse`,
`archiveAcceptedResponse`, `prepareBallotBatch`, `createEvidenceCommit`, and
`reconcileEvidencePublication` for private judgments and durable public
evidence. Reuse `materializeBoundInputs`, `mutateCursorsState`, authority checks,
journaling, action preparation, and lifecycle-aware delivery. Do not write
peer clones or require a peer to cherry-pick a plan edit.

Extend the existing `order()`/`mirror()` evidence fixtures, machine state and
accepted-response/batch fixtures, run-loop `fixture()` and injected mirror,
CLI drop fixtures, and real bare-origin integration canary. No replacement
fixture framework or new abstraction is needed. Existing hook support for
coordination-only commits is sufficient; neither hook policy nor the product
hook tree changes.

### 1. Request without claiming implementation completion

Implementation and revision actions offer two mutually exclusive outcomes:
their existing ready signal, or a protocol-v1 `plan-amendment-request` JSON
artifact at that action's existing required artifact path. The requester
commits and pushes only the request evidence and writes its SHA to the normal
completion mailbox. In-progress product edits remain untouched and unstaged;
the request does not need a passing product commit or an implementation pin.
This uses the already-supported coordination-only commit route when a missing
test update makes product verification fail. It does not waive checks for the
eventual product commit.

The request contains the common issue/session/agent fields, current action ID,
the current input-set hash, a coordinator-supplied `scopeHash`, a nonblank
explanation of the discovered omission, and `additionalPaths` entries with an
exact repository-relative file path and a nonblank necessity reason each.
The scaffold supplies every binding; only explanations and additions are
agent-authored. The scope hash covers the exact selected-plan citations,
sorted effective paths, and the ordered applicable approved-amendment
request/publication identities. Compute it canonically with the existing hash
utilities, not from branch names or timestamps.

Accept requests only from an agent currently authorized to implement or
revise. Verify origin reachability, issue/session/agent, action ID, input hash,
and scope hash before recording a request. Require a bounded, nonempty,
duplicate-free set of literal paths that add something not already covered.
Reject absolute/traversing paths, empty or dot segments, Git metadata,
coordination artifact namespaces, directory entries and wildcard/brace
patterns. Existing plan-map directory semantics need not change; new
amendments authorize explicit files only. The requester must connect each
file to the already agreed behavior; reviewers, not a filename heuristic,
decide that semantic question. A request can never satisfy implementation or
revision readiness.

### 2. One serialized, conditional agreement detour

Introduce internal `R4.amend-ballot`, an all-active-agent response action.
It is a detour callable from `R4.implement` or `R6.revise`, not an extra item
in every profile's normal sequence. Handle it before normal profile
normalization so reviewed and solo issues cannot accidentally skip it.
In reviewed mode all active reviewers vote, not just the implementer; in solo
mode the one active agent makes an explicit recorded judgment.

Persist one pending request with its exact Git citation, validated content,
base scope identity, selected-plan citations, active roster, saved source
step/round, and monotonically increasing amendment sequence. A sequence is
not a revision round. Centralize the affected round selection so request
ballots, accepted responses, batches, retries, and CLI recovery all use the
same amendment sequence while the existing revision limit remains unchanged.

Freeze at most one proposal at a time, choosing in active-roster order when
multiple valid requests are observed together. Prioritize opening the detour
over advancing the source work. Suspend its unfinished actions and stop
accepting their ready signals while the ballot is active. Do not erase
accepted implementations, product pins, local changes, or the selected plan.
Retire superseded action IDs and mailbox contents through existing runtime
cleanup, not Git resets. An unchosen simultaneous request is not silently
approved or merged: its author receives a fresh resumed action and must
resubmit against the then-current scope if still necessary.

Each ballot binds and materializes the exact request, original selected
plans, and applicable earlier approval evidence. It asks whether every
addition is necessary to complete the original scope, with private JSON
`{ actionId, disposition: "approve" | "revise", rationale }`. Here `revise`
rejects the proposal with actionable reasons. It does not change the source
implementation revision round. Agents do not commit ballots or see peers'
unpublished responses.

Use existing action-scoped response archives and batch publication. Publish
one canonical amendment ballot per voter under a sequence-specific path in
the current issue's plans directory, with request/plan citations, response
digests, roster-bound batch identity, and disposition. Do not widen scope
until every required response is accepted and that exact batch is published.
Unanimous approval authorizes only the requested additions; any `revise`
leaves the approved map unchanged. Return rejection reasons in the resumed
action so the requester can correct the request or stay within the old map.

### 3. Resume against one authoritative effective map

Persist the decision and its publication SHA before resuming. Effective scope
is the selected pinned plan map plus only approved additions bound to that
same selected-plan set. Preserve original plans and prior decisions as audit
evidence; never overwrite accepted plan SHAs or amend their contents in place.

Resume the saved implementation/revision step and original revision round.
Reissue unfinished work with fresh action IDs, current approved paths, scope
hash, and approval citations. Already accepted implementations remain
accepted: an additive amendment cannot invalidate a product that was within
the smaller approved map. Unaccepted old ready signals must not claim the
new scope. Add optional `scopeHash` fields to ready-signal schemas for
backward compatibility; missing hashes remain acceptable only on an issue
with no applicable approved amendment, while after approval exact matching
is required. If a hash is supplied even before approval, validate it.

Bind amendment evidence separately on `InternalOrder` and render/export it
alongside normal inputs. Do not add approval commits to revision `basedOn`:
the existing invariant of exactly one authorized product parent must remain
intact. Product verification still rejects any changed path outside the
effective map and all existing pin, check, and finalization restrictions
remain in force. A missing coordinator-approved map must fail closed, not
fall back to the implementation's self-declared list.

### 4. Restart, roster changes, and compatibility

Keep format 4 with default-empty amendment state so existing no-amendment
issues read unchanged. Pending requests, sequence IDs, accepted responses,
publication outbox entries, and decisions survive restart. Apply an approved
request at most once by its immutable identity. Reuse exact-SHA publication
retry; a failed or pending push cannot authorize paths. State mutation and
post-await authority checks prevent a stale runner from applying a vote after
an owner pause/drop/reset.

A drop during a pending amendment invalidates that pending ballot and its
unpublished batch, cancels the request, and resumes through existing
drop/reselection logic. No votes from the old ballot may satisfy a fresh
request. Previously published approvals can remain applicable when the exact
selected-plan set is unchanged: every remaining agent already approved them.
If reselection changes that set, old additions become historical only and
existing downstream reset logic must discard pins/acceptances that depended
on the old plan and scope. Preserve the existing safeguard against silently
reassigning an authorized reviser. No automatic feature-scope expansion,
manual runtime editing, owner command, or new dependency is introduced.

## Tests

Use small table-driven schema/binding cases and the existing workflow fixtures,
not a separate test for every field or a new suite. Required focused coverage:

1. **Request and judgment contract:** extend `test/protocol.test.ts` and
   `test/ballotResponse.test.ts` for the valid alternate artifact, exact-path
   restrictions, nonblank explanations, strict judgment fields, and stale
   action rejection. Extend existing scaffold/action assertions in
   `test/orderScaffold.test.ts` and `test/action.test.ts`; adapt the seeded
   action coverage in `test/agentLanguage.test.ts` for the conditional ballot.
2. **Enforcement:** in `test/evidence.test.ts`, show that a request does not
   complete implementation, and that an omitted test path is rejected before
   approval, accepted after the bound amendment, and rejected for a stale
   scope hash or an unrelated third path. Exercise revision as well without
   relaxing its single-parent or product/signal separation checks.
3. **Agreement:** in `test/machine.test.ts`, table-drive consensus/reviewed/solo
   participation and approve/revise outcomes. Missing voters and unpublished
   evidence must wait; only unanimity resumes with additions; rejection
   resumes unchanged; the saved revision round and accepted peer pins survive.
4. **Durability and canonical evidence:** extend `test/ballotPublication.test.ts`
   with one amendment batch identity/citation case and `test/state.test.ts`
   with old-state defaults and pending/history round-trip coverage. In
   `test/runLoop.test.ts`, cover restart around response acceptance, failed
   publication followed by exact retry, and replay without duplicate scope
   application. Check that request and approval bytes are materialized and
   cited in resumed actions.
5. **Concurrency and owner controls:** use `test/runLoop.test.ts` for two
   competing requests plus a delayed old completion, and its existing
   authority/pause test pattern. Extend `test/cli.test.ts` drop coverage for a
   pending amendment and for selected-plan replacement after approval;
   assertions must include no stale votes/additions and correct work resumption.
6. **Actual Git regression:** extend the existing scenario in
   `test/integration.test.ts` with an omitted test-file request during
   implementation, private unanimous votes, coordinator evidence publication,
   restart/resume, and implementation of the newly approved path. Finish its
   existing comparison/revision/finalization route. Preserve its bare-origin,
   exact-SHA, owner-unmerged PR, and cleanup checks rather than building a
   second end-to-end harness.

Commands verified from this checkout's package scripts:

- Focused iteration: `pnpm exec vitest run --config vitest.config.ts test/protocol.test.ts test/evidence.test.ts test/machine.test.ts test/runLoop.test.ts test/ballotResponse.test.ts test/ballotPublication.test.ts test/state.test.ts test/cli.test.ts test/orderScaffold.test.ts test/action.test.ts test/agentLanguage.test.ts`.
- Before commits: `pnpm check:fast` (lint, both typechecks, fast tests).
- Implementation acceptance: `pnpm check` (build, fast checks, existing e2e).

Do not substitute hook success for these checks. Do not bump the package
version for ordinary issue-branch commits or alter hooks to make tests pass.

## Alternatives Rejected

- **Permit all corresponding tests or widen directory globs automatically:**
  correspondence does not establish permission, and it could admit unrelated
  behavior changes without agreement.
- **Read the latest plan from origin or let the implementer edit its map:**
  silently changes the evidence other agents reviewed and bypasses consensus.
- **Reset to planning and restart the workflow:** needlessly discards finished
  work and repeats plan selection for a narrow file-list correction.
- **Treat an out-of-map implementation as an implicit request:** authors would
  have to violate the current action first, and the coordinator could confuse
  a scope proposal with completed product evidence.
- **New CLI command, alternate mailbox, or agent-committed votes:** unnecessary
  parallel protocols when the existing Git-artifact and private-ballot routes
  already provide provenance, delivery, and publication recovery.

## Risks and Mitigations

- **A file addition hides feature expansion.** Require per-file necessity
  explanations and explicit unanimous review against the pinned plan; scope
  checks alone cannot judge semantics. Rejected requests confer no authority.
- **The detour bypasses normal profile/round logic.** Special-case only this
  conditional action, preserve saved source state, and test all profiles plus
  a revision request. Do not alter ordinary profile sequences.
- **Publication, stale completions, or a drop grant unapproved scope.** Persist
  immutable proposal/batch identities, require published unanimity, bind
  resumed signals to the effective scope, and invalidate pending work on
  authority changes. Keep checked product ancestry separate from scope evidence.
- **An already busy agent is disturbed or local work is lost.** Reuse existing
  lifecycle-aware delivery, retire runtime orders only, and never reset,
  stash, check out, or edit an agent's working tree for this detour.
- **The change becomes a general plan editor.** Support additive exact file
  corrections only, one proposal at a time. No requirement edits, removals,
  broad patterns, generic workflow framework, or unrelated refactoring.

## Conclusion

An implementer can report a missing file without claiming completion or
bypassing failed product checks. The active agents explicitly agree on that
exact correction, publication makes the decision durable, and the coordinator
resumes preserved work with an enforceable amended map. This fixes the issue's
missing-test deadlock while keeping pinned plans, scope control, and normal
verification authoritative.
