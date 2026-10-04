# Issue 146 — plan review

Reviewed pins:

- cursor `29331e5a206544d2bb3fa9c7534616027db6bb97` (`.plans/issue-146/plan.md`)
- claude `fae0a54ca4a4f6f1a3260a71e16ddf2bbce9d93f` (`.plans/issue-146/plan.md`)
- codex `9cc96e5a69b432a41ad1ed6212d85ac8acd10f5f` (`.plans/issue-146/plan.md`)

All three plans agree on the dirty-clone fix in `prepareAgentIssueBranches`
(`src/prepareAgentBranch.ts:203-214`): a clone whose HEAD already equals
`issueBranchFor(...)` takes the existing `already-on-branch` path and must not be
counted by the batch dirty preflight, while off-branch dirt still refuses before
any clone changes. That part is correct in all three plans and needs no change.
The findings below cover where the plans diverge: runner liveness and hold
release.

## Findings

### cursor

**C1 — the "resume continues into `run()` whenever the issue is fully unpaused" change in the File List (`src/cli.ts`, item 2) can start a second runner.**

- *Rule:* An owner state command must not start a second coordinator loop for an
  issue that already has a live runner. No runner lease or lock exists:
  `assertNoManualSession` (`src/cli.ts:874-882`) checks only the manual tmux
  session. Delivery side effects (tmux sends) happen outside the cursor CAS, so
  two loops can both deliver.
- *Failure as written:*
  1. At baseline a runner stays alive while it is held, if resource work is
     pending (`resourceWorkPending`, `src/runLoop.ts:1095-1104`). Examples are a
     Claude usage-window hold with an exact `resetsAt`, or a hold on an agent
     with a bound Codex quota reader.
  2. The owner follows the recovery line from a second shell:
     `coord resume --issue N --hold latest`.
  3. The release leaves `paused === false`, so the plan enters
     `makeRunLoop(paths).run()`.
  4. The original runner sees the unpause on its next poll. Both runners then
     run `initializeEffects` (`ensureSession`, `openOwnerAgentClients`) and both
     run `runTick`, which sends the same action prompt twice and spends the
     nudge budget twice.
- The same path also turns plain `coord resume` (manual pause only) into a
  foreground run, which the plan's own test list does not cover.
- *Smallest correction:* make the run opt-in (an explicit flag, as codex
  proposes) and keep `resume` state-only by default.

**C2 — the plan keeps exit-on-hold ("Out of scope: … converting every … throw into a durable hold", and no `run()` change).**

- *Rule:* The issue's title and first sentence ask that coord "not exit unless
  there is no way to continue". A hold is a waiting condition that an owner
  command can clear, not a dead end.
- *Failure as written:* An `unobservable` hold still makes `coord 139` return at
  `run()`'s `finished` check (`src/runLoop.ts:2743-2748`). The owner has to
  notice the exit and type a restart, which is the reported experience. This is
  shortened by `--hold latest`, but it is not removed.
- *Smallest correction:* stop treating automatic holds as completion in
  `run()`, as both other plans do. Waiting is safe because `runTick` is already
  observation-only while paused (`src/runLoop.ts:2532-2539`).

### claude

**L1 — the plan makes plain `coord resume --issue N` release every hold except `nudge-loop` (File List, `src/cli.ts`).**

- *Rule:* An owner releases only a hold they identified. This is the #126
  invariant, stated at `src/state.ts:1172` ("Scoped owner recovery never
  releases another hold or a manual pause") and in `docs/coord-driver.md:456-457`
  and `:518`. An `unobservable` hold exists so that someone inspects the agent
  before delivery resumes.
- *Failure as written:*
  1. The owner manually pauses issue N.
  2. While it is paused, codex gets an `unobservable` hold.
  3. The owner runs plain `coord resume --issue N`, meaning only "unpause".
  4. The codex hold is released without inspection. The waiting runner resumes
     delivering to an agent whose state is unknown.
- *Smallest correction:* release only through a selector that names the hold.
  Either an agent selector that must resolve to exactly one hold (codex), or
  "the unique active hold" (cursor). Plain resume stays manual-pause-only.

**L2 — the plan keeps the runner alive while held and initializes effects lazily on release, but it does not handle `StateConflictError` from that deferred `initializeEffects`.**

- *Rule:* A runner kept alive to avoid exiting must not exit on an ordinary
  concurrent owner mutation. `initializeEffects` calls `authority()` between
  each step (`src/runLoop.ts:823-870`), and that throws `StateConflictError`
  whenever `stateRevision` moves. `run()` (`src/runLoop.ts:2741-2765`) does not
  catch it; only `runTick` does.
- *Failure as written:*
  1. A runner was started while the issue was held, so it has not initialized.
  2. The owner releases the hold.
  3. The runner begins `initializeEffects`. The mirror initialization and tmux
     `ensureSession` take seconds.
  4. During that window the owner issues a second command, for example clearing
     a manual pause or releasing a second hold, or a resource observation
     mutates state.
  5. `authority()` throws, `run()` rejects, and `coord N` exits. That is the
     symptom this issue reports.
- *Smallest correction:* in `run()`, catch `StateConflictError` from
  `initializeEffects`, leave `initialized` false, and retry on the next poll, as
  codex specifies. Add one `test/runLoop.test.ts` case that mutates state from
  an injected `ensureSession`.

### codex

**X1 — Tests, items 1–4, and the File List additions (`test/issueReport.test.ts`, `README.md`, the branch-identity recheck, and removing `resourceWorkPending`) are broader than the fewest focused tests and changes.**

- *Rule:* Add the fewest focused tests that fail before the change and pass
  after it, and make no change the issue does not need.
- *Failure as written:* Test 1 adds local commits, staged-blob comparisons, and
  detached/wrong-issue variants. Only "dirty and on the issue branch succeeds"
  and the mixed-clone refusal fail at baseline. The other variants already pass
  at `a792b19` through existing cases ("refuses a dirty clone", "does not reset
  an existing issue branch").
  - The "recheck branch identity before effects" step guards a window that does
    not exist: the preflight and the per-clone loop run synchronously in one
    call.
  - None of this is a correctness defect, but it multiplies the review and
    implementation surface.
- *Smallest correction:* keep these test cases:
  - same-branch dirty succeeds and keeps its bytes;
  - mixed-clone refuses;
  - held runner waits and continues after release;
  - init conflict retries;
  - agent selector resolves exactly one hold, and `--run` honours exclusion.

  Drop the identity recheck and the speculative variants.

**X2 — the plan makes a manual pause a waiting condition too (File List, `src/runLoop.ts`).**

- *Rule:* `coord pause` is documented as retaining state
  (`docs/coord-driver.md:456`), and an owner must keep a non-signal way to stop
  a foreground runner.
- *Failure as written:* After the change, `coord pause` from another shell no
  longer ends the foreground `coord N`. Only Ctrl-C does. The plan does not say
  this, and its docs item does not tell owners. An owner who uses pause to stop
  the runner, for example before switching to manual mode, finds the process
  still polling.
- This is acceptable if it is documented. Otherwise, keep `manualPaused` as a
  finish condition and wait only on automatic holds.
- *Smallest correction:* state the chosen behaviour in `docs/coord-driver.md`
  and assert it in the run-loop test.

Codex's plan is the only one that covers all of these:

- keeps the runner alive on holds;
- keeps hold release scoped and audited (agent selector, exactly-one match, with
  `--hold` as the fallback);
- makes a same-process continue explicit for a stopped runner (`--run`) rather
  than implicit;
- handles the deferred-initialization authority conflict.

It stays within the issue and creates no new files.

## Conclusion

- **cursor:** changes required. C1 can start duplicate runners and send
  duplicate deliveries. C2 leaves the issue's main complaint (exit on hold) in
  place.
- **claude:** changes required. L1 drops the scoped-release safety invariant.
  L2 lets the newly long-lived runner exit on an ordinary state conflict.
- **codex:** approve with scope trimmed. It is the safest and most complete
  basis. Apply X1 by reducing the tests to the focused set listed above, and X2
  by documenting the manual-pause waiting behaviour (or keeping manual pause as
  an exit). The dirty-on-issue-branch preflight fix, common to all three, should
  be kept as written.
