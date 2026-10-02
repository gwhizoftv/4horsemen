# Issue 145 plan review

Protocol version: 1. Reviewed the exported plans bound by action `927de618-a0e0-4a00-85b2-70584d8394c2`:

- Cursor: `098cb8181ef8221e2ace0a2df106f54a3ef0c874`.
- Codex: `efc8ad44d8672911a5d7e4313d74d10aea96ac05`.
- Claude: `4415a10d356c858b27a9c911b771de8b2b1944a9`.

## Findings

### 1. Cursor — blocking: verification must retain delegated Git access

**Plan claim:** “Exact File List” proposes stripping `COORD_GIT_DELEGATE` in `src/hookPolicy.ts`'s default verification runner; “Risks and Mitigations” treats a declared check needing this-clone status as a separate product bug.

**Rule:** Declared verification commands must retain the delegated Git access that the existing shim intentionally gives hook subprocesses. Fixing a fresh shim test's inherited environment must not restrict real verification commands across managed products.

**Concrete failure:** A valid declared check such as `git diff --check` against the committing clone currently succeeds under the delegation guard. Under the proposed runner change, it inherits the agent's shim PATH and `COORD_ISSUE` but loses the guard. The shim rejects `diff` with exit 2, causing the required check and commit to fail even on a valid patch. Allowing operations on fixture repositories does not protect checks that inspect their actual committing clone. This follows directly from `inheritRunner` spawning in `input.clone` and the generated wrapper's delegation and same-clone branches.

**Smallest correction:** Leave the production verification environment unchanged. Scrub the inherited variable only at `test/install.test.ts`'s `runGit` boundary, before explicit test overrides, as the other two plans propose.

### 2. Cursor — blocking: serialization/teardown settings do not unblock worker reporting

**Plan claim:** “Exact File List” proposes single-fork execution, optionally increasing `teardownTimeout`, to stop the reporting-timeout failure; the conclusion promises that a green run will no longer die on that timeout.

**Rule:** The change must permit worker reporting replies to be processed during a long sequence of synchronous tests, rather than merely shorten execution enough to avoid a fixed RPC deadline on one machine.

**Concrete failure:** A single worker can still execute the synchronous installer tests for more than 60 seconds without yielding a macrotask. Single-fork scheduling does not insert a poll opportunity between those tests. The queued `onTaskUpdate` acknowledgement can therefore still time out with all assertions passing. `teardownTimeout` controls worker termination, not the reporting RPC deadline. Claude's bound plan reports this exact >60-second file behavior and three passing A/B runs after adding an event-loop yield; those are peer-reported measurements, not measurements independently repeated for this review. Inspection of the installed Vitest code also distinguishes reporting RPC timeouts from pool termination timeout.

**Smallest correction:** Add the narrowly scoped shared event-loop-yield setup proposed by Claude or Codex, and validate actual process exit codes over repeated full runs. Do not use a teardown timeout as a reporting-timeout fix.

### 3. Cursor — blocking: proposed regression edits are outside its file map

**Plan claim:** Tests item 3 calls for a runner-environment assertion in `test/hookPolicy.test.ts`, `test/verify-config.test.ts`, or `test/agentLanguage.test.ts`.

**Rule:** Every intended changed or created path must appear in the corresponding exact file list, and the plan must resolve the test destination rather than delegate that scope decision to implementation.

**Concrete failure:** None of these test paths is listed as changed or created. Following the test requirement either modifies an unauthorized path or omits the claimed regression coverage. `test/hookPolicy.test.ts` does not currently exist, despite the plan's promise of no new test files.

**Smallest correction:** With finding 1 addressed, drop the production-runner change and this now-unnecessary test. Otherwise name one existing test destination explicitly in the file map; an injected `VerifyRunner` alone cannot test the default runner's spawn environment because it bypasses that runner.

### Non-blocking comparison and scope observations

- **Claude:** No blocking finding. Its plan fixes the inherited-environment test boundary, injects fixture homes into both installer helpers, and addresses worker starvation without changing production policy. It reuses `makeProduct`, `workspaceRoot`, the existing `home` option and shim cases. The single new setup module has a concrete cross-suite justification; one new regression and one extended assertion are focused. Its measured reporting-timeout investigation is stronger than the timing hypothesis in the other plans. The two direct installer calls still read the real Claude home; adding explicit fixture homes to those calls within the already-listed test file would improve isolation, but they are not the reported Antigravity writers.
- **Codex:** No blocking correctness finding. The plan preserves production behavior, reuses existing helpers, includes both direct installer calls in home isolation, and includes a real event-loop yield. However, permanent `fileParallelism: false` is unnecessary scope given the peer's evidence that yielding alone fixes reporting while preserving parallel execution. Prefer removing serialization unless implementation produces separate evidence that it is required. The status-line fixture edit is supported by two failures observed in this clone, but is a separate reproduced test race rather than the reported RPC mechanism; keep it narrowly fixture-only and retain the exact payload assertion if included.
- **Cursor:** Its fixture-home and shim-test isolation changes reuse the correct existing extension points and require no new dependencies. The production runner change broadens scope and regresses valid checks; the unresolved runner/test choices prevent accepting the plan as written.

## Conclusion

Prefer **Claude's plan at `4415a10d356c858b27a9c911b771de8b2b1944a9`**: it is the smallest evidence-backed solution to the three reported defects. Preserve normal Git hooks and delegated verification access. Codex's plan at `efc8ad44d8672911a5d7e4313d74d10aea96ac05` is viable but broader; remove unconditional serialization absent additional evidence. Cursor's plan at `098cb8181ef8221e2ace0a2df106f54a3ef0c874` needs the blocking corrections above before implementation.

Review verification: ran `COREPACK_HOME="$HOME/.cache/node/corepack" HOME="$PWD/.codex/tmp" pnpm check:fast` to preserve the existing package-manager cache while protecting the owner's real home. Lint and typecheck passed; tests exited 1 with 619 passing and the two reported Antigravity installer cases failing on sandbox-denied writes under the substituted HOME. This independently confirms the missing fixture-home boundary without modifying real harness settings. The status-line test passed in this run; no reporting timeout occurred. No product code was changed for this review.
