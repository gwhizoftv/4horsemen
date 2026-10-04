# Comparison — issue 137 implementations

## Comparison

Bound implementation pins compared, each against baseline
`3d1bf995c2327978374d863c16828a24e311c159`:

- cursor `13804a10c6fdb0965c79d016559397fe4adf304b`
- claude `f8543ea6bd7fe695ecb1b25638a29100d67cff3c` (my own; reviewed as strictly as the others)
- codex `a4d2b46480d89b5dfcd79991e520530b4ed427ac`
- antigravity `b915e8c9f45a032a4afa1498ef229083de8ac1e8`

### What was run

I copied each bound worktree to a scratch directory, made it its own Git
repository, and used the shared `node_modules`. For every pin I ran both
typechecks, `eslint src test`, the fast suite, and the e2e suite.

| Pin | typecheck | lint | fast suite | e2e |
| --- | --- | --- | --- | --- |
| cursor `13804a10` | pass | pass | 581 pass / 96 fail | 2/2 pass |
| claude `f8543ea6` | pass | pass | 586 pass / 96 fail | 2/2 pass |
| codex `a4d2b464` | pass | pass | 584 pass / 96 fail | 2/2 pass |
| antigravity `b915e8c9` | pass | pass | 582 pass / 96 fail | 2/2 pass |

The 96 failures are the same tests in the same five files for every pin:
`install`, `doctor`, `hookSync`, `onboard`, `vendor`, and the install/doctor
cases in `cli`. They come from running a copy outside an installed checkout.
None of these files is touched by any implementation, and the claude pin
passes all 682 fast tests in its real clone. These failures do not
distinguish the implementations; every amendment-related test passes on
every pin.

### Scope and size

All four change only paths in the approved file map. All four add no source
file and no dependency.

| Pin | `src/` lines (+/−) | tests (+/−) | extends real-git canary |
| --- | --- | --- | --- |
| cursor | 1030 / 113 | 576 / 4 (11 files) | no |
| claude | 1089 / 79 | ~820 / 11 (12 files) | yes: request → unanimous vote → restart → resume → finalize |
| codex | 420 / 62 | 378 / 12 (12 files) | yes: peer pin kept, WIP kept, partial-ballot restart, failed publication with exact retry, pause race |
| antigravity | 894 / 60 | 888 / 10 (12 files) | yes: request → vote → resume |

All four implement the same shape:
- **Request:** an alternative `plan-amendment-request` at the implementation or revision required path.
- **Ballot:** an `R4.amend-ballot` detour with responses keyed by an amendment sequence, never the revision round.
- **Publication first:** the decision is applied only after the canonical batch is published.
- **Effective map:** the selected plan's paths plus approved additions.
- **Scope binding:** a `scopeHash` that is optional on ready signals until an amendment applies.

They differ in correctness at the edges and in how much code it took.

### Findings

**F1 — cursor `13804a10`, `src/runLoop.ts:2745-2748` with `src/runLoop.ts:1526` and `:1564`.**

- **Rule:** the plan says to "return rejection reasons in the resumed action so the requester can correct the request".
- **Failure:** `resumeAmendmentDetour` writes the rejection reasons into the requester's `cursor.outstanding`. On the next tick, `prepareAction` builds the fresh action with an empty outstanding list (`[]` at line 1526) and then sets `outstanding: []` (line 1564). The reasons are discarded before any action is written. They survive only in the journal (`amendment-rejected`), which agents never read. A rejected requester gets a plain implementation action, cannot see why, and is likely to resubmit the identical request into another ballot.
- **Test:** seed a published amendment batch with one `revise` vote at `R4.amend-ballot`, run one tick, and assert that the requester's `action.md` contains that voter's rationale. It fails on this pin. The claude pin has exactly this test in `test/runLoop.test.ts` ("resumes a rejected request with every rejection reason"). Codex and antigravity also deliver the reasons, through an action notice and by passing `cursor.outstanding` respectively.

**F2 — antigravity `b915e8c9`, `src/runLoop.ts:1735-1763`.**

- **Rule:** a coordinator effect that retires agent work must happen only once its state transition is durable. `this.mutate` can throw `StateConflictError` when an owner command changes state concurrently.
- **Failure:** `accept()` opens the detour by clearing every active agent's completion file, action file, and response *before* calling `this.mutate` (line 1756 runs before line 1763). If the owner runs `coord pause` (or any state-changing command) in that window, the mutation is refused and state still says `R4.implement`, with each peer's `actionId` still ordered. Their `action.md` files and any already-written completion SHA are gone, so the agents have nothing to read and nothing to resume. The issue stalls until the owner runs `restart-action`.
- **Comparison:** the other three perform the clearing inside, or after, the durable transition. Codex additionally records an `amendmentRetirements` intent and replays it on the next tick.
- **Fix sketch:** move the loop inside the mutate callback, or record retirements durably first, as codex does at `src/runLoop.ts:1812-1840`.

**F3 — antigravity `b915e8c9`, `src/protocol.ts:143`.**

- **Rule:** the plan requires "a bounded, nonempty, duplicate-free set of literal paths".
- **Failure:** `additionalPaths` has `.min(1)` and no maximum. A request can list hundreds of files and still be admitted as a "correction", which is a re-plan disguised as an amendment.
- **Bounds elsewhere:** claude (20), cursor (32), and codex (100) all set a ceiling.
- **Test:** a schema case with 1,000 distinct files must fail.

**F4 — cursor `13804a10`, `src/evidence.ts:179-188`.**

- **Rule:** the plan says to reject Git metadata among requested paths.
- **Failure:** `isExactAmendmentPath` relies on `isFileMapPath`, whose segment pattern accepts `.git`. As a result, `.git/config` passes as an exact amendment path, and a request to "add" `.git/hooks/pre-commit` would reach a ballot. Git cannot track such a path, so the practical damage is a wasted ballot, but the plan's refusal is not enforced. Claude, codex, and antigravity all reject `.git` segments.
- **Test:** `.git/config` in `additionalPaths` must produce a rejected observation.

**F5 — codex `a4d2b464`, `src/runLoop.ts:734` and `:780`.**

- **Rule:** a rejection notice belongs to the requester's resumed action, not to every later action.
- **Failure:** `amendmentNotice` is appended to every implementation and revision action for every agent whenever the latest amendment was not approved. That includes later revision rounds long after the ballot. For example, an `R6.revise` round 2 action still says "The last amendment was rejected; it grants no additional paths". This is noise only; it does not change scope. Low severity.

**F6 — claude `f8543ea6` (self-review): disposition vocabulary.**

- **Departure:** the selected plan specifies `approve` / `revise` (with `revise` meaning reject). I used `approve` / `reject` deliberately, to avoid reusing the R6 meaning of `revise`, and recorded that in my implementation summary.
- **Consequence:** it is a departure from the plan text that cursor, codex, and antigravity followed. Agents trained on the plan wording would send `revise` and have it refused with a schema error. The error is visible and correctable, but it is still a mismatch.

**F7 — claude `f8543ea6` (self-review): size.**

- **Rule:** the smallest change that fully solves the issue.
- **Size:** my `src/` diff (1089 added lines) is about 2.5× codex's (420) for the same behaviour.
- **Where the extra lines go:** a separate `PLAN_AMENDMENT_NOTE` in the task text, an inline request summary in the ballot action, a deferred-request notice, and a fuller state record.
- **Durability:** none of this is wrong, but codex achieves the same guarantees, and a stronger crash-safety story (durable retirement intent), with far less code.

### Behaviour each pin handles that others do not

- **Simultaneous requests:**
  - claude accepts peer ready signals observed in the same tick before opening the detour, and tells deferred requesters why they were not considered.
  - codex and antigravity drop peer signals observed in that tick; the agents resubmit against a fresh action.
  - cursor also drops them.
  - The plan allows this ("suspend its unfinished actions and stop accepting their ready signals").
- **Amended paths match exactly:** codex (`exactApprovedPaths`) matches amended paths by exact equality, never as directory roots. The others reject directory-shaped requests at admission, which has the same effect.
- **Crash safety:** codex persists a retirement intent before deleting runtime files. Claude and cursor delete inside the mutate callback. Antigravity deletes before it (F2).
- **Rejections recorded in state:** claude and codex keep rejected and cancelled decisions in `cursors.json`. Cursor and antigravity record only approvals in state and leave rejections in the journal.

### Ranking

1. **codex `a4d2b46480d89b5dfcd79991e520530b4ed427ac`.** It is the smallest correct implementation, with the most robust durability: retirement intent, publication-failure retry, and pause race, all covered in the real-git canary. Its only finding (F5) is cosmetic.
2. **claude `f8543ea6bd7fe695ecb1b25638a29100d67cff3c`.** It is correct and well covered, including the end-to-end canary. It departs from the plan's ballot wording (F6) and is about 2.5× larger than needed (F7).
3. **antigravity `b915e8c9f45a032a4afa1498ef229083de8ac1e8`.** It has the right shape and canary coverage, but it retires agent work outside the durable transition (F2) and leaves requests unbounded (F3).
4. **cursor `13804a10c6fdb0965c79d016559397fe4adf304b`.** Rejection reasons never reach the requester (F1), which defeats the corrective loop the issue asks for. It also admits `.git` paths (F4) and does not extend the real-git canary.
