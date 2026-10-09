# Issue 186 — implementation comparison

Protocol version: 1. Action: `2613a914-0fde-4f99-b4d1-c89e94823756`.

Reviewed the coordinator-exported worktrees at these exact implementation pins:

- Claude: `edab4cbee8b779be8d086b03232fcb21a4ce8ce9`.
- Cursor: `e2868cbb3590997c9ddf91de04810ec02f3c9d0f`.
- Codex: `89ab6ee45e8ad1da3886074bf1f5c2781d1a8c1a`.

## Comparison

**Prefer Codex as the revision base; no candidate is ready for final acceptance
as-is.** All three preserve the known exhausted-submit stall. Codex additionally
checks ordinary-path readiness and lifecycle, refuses lost confirmation, and
recognizes a newly submitted message without requiring Working chrome. Those
differences prevent the peer-specific failures reproduced below. This recommendation
does not treat Codex's own shared defect as acceptable.

### 1. [P1] All three leave an exhausted, visibly unsubmitted nudge marked injected

**Locations:** Claude `src/tmux.ts:1157-1164`; Cursor
`src/tmux.ts:1153-1164`; Codex `src/tmux.ts:1162-1170`.

**Rule:** Resolving the issue's unsubmitted-prompt stall requires a non-success
outcome when the bounded submit attempts end with positive evidence that the
exact nudge remains unsubmitted; the durable partial-send reservation must not
be cleared as though submission succeeded.

**Concrete failure:** Ignore every submit key while preserving the exact draft.
All three send `-l, C-j, C-m, C-m, C-m`, then return `sent/complete`. The run loop
marks the action injected and clears its reservation (Codex
`src/runLoop.ts:1241-1260`; peers retain the same outcome handling). Recovery
requires the UUID to be absent from a ready pane, but it remains in this draft.
Thus the original stall remains after the new retries.

Claude and Cursor also return `sent` if the final capture fails: `capturePane`
returns an empty string, `!codexComposerHolds(...)` breaks the retry loop, and
neither pin requires positive acceptance before its successful return. The
probe reproduced this on both; Codex correctly returned a mid-send refusal.

**Smallest regression:** A stateful pane whose submit keys never clear its
draft must stop at the existing key bound with a mid-send non-success outcome;
a run-loop assertion must retain the charged reservation/uncertainty rather
than mark the action injected. Also make the final capture return exit 1.

**Authorization constraint:** The implementation action explicitly retained
the selected plan's legacy `sent` outcome and rejected the earlier
`test/runLoop.test.ts` amendment as a behavior change. These pins obey that
constraint; obedience does not resolve the issue-level failure. Obtain explicit
approval for the outcome correction and its integration-test scope before
implementing it, rather than silently expanding the plan. Codex documents the
limitation at `docs/coord-driver.md:397-402` and tests the legacy outcome;
Claude's exhaustion test checks only the key count, and Cursor asserts `sent`.

### 2. [P1] Claude and Cursor do not revalidate ordinary-path retries at the key boundary

**Locations:** Claude `src/tmux.ts:1098-1122,1155-1160`; Cursor
`src/tmux.ts:1088-1111,1156-1159`.

**Rule:** An additional submit key must still target the exact idle nudge after
the asynchronous gate check, with current readiness/lifecycle evidence; that
rule applies to ordinary sends as well as stale-working overrides.

**Concrete failure:** On the ordinary path, let the retry capture show the
exact nudge, then change the composer to an owner draft during the following
`display-message` gate call. Both candidates issue an extra `C-m` against that
owner draft: their `send()` only rechecks the composer when `staleOverride`
exists. Cursor additionally sends both extra `C-m` keys when Working chrome is
already visible in the retry capture. Claude's outer readiness check catches
that particular Working case, but not the intervening edit. Neither peer
passes an ordinary-path lifecycle observer from `RunLoop.deliver`.

**Smallest regression:** Use the existing runner-stub pattern to mutate the
draft at the retry's gate call and assert no further submit key. In a separate
case, paint Working after the first `C-m` while retaining the exact draft.
Codex passed both probes, returning mid-send refusals without extra keys; its
observer does not grant ordinary sends stale-working override authority.

### 3. [P1] Claude sends through a gate invalidated during its new settle wait

**Locations:** Claude `src/tmux.ts:1076-1083,1089-1091,1103-1105,1121-1124`.

**Rule:** A successful input gate sampled before a sleep cannot authorize a
key after that sleep if pane input state has changed; settling must preserve
the existing per-key gate guarantee.

**Concrete failure:** On a ready-file override, hide the newly typed draft for
one capture. The first submit's gate succeeds, then `settled()` sleeps 150 ms.
Set `pane_input_off=1` during that sleep and render the exact draft on the next
capture. Claude sends `C-j` without rechecking the gate, only discovering
input-off before the following key. This can drop the submit and leave a
partial-send hold. Cursor and Codex both stop before `C-j` in the same probe.

**Smallest regression:** Extend the delayed-paint stub with an input-off change
in its settle sleep; assert that the only sent key is the literal text and that
the outcome is `busy/input-off/mid-send`. Claude instead sent `-l, C-j`.

### 4. [P2] Claude and Cursor retain false holds when submission has no Working chrome

**Locations:** Both peers `src/tmux.ts:218-235`; Claude
`src/tmux.ts:1107-1119`; Cursor `src/tmux.ts:1096-1108`.

**Rule:** Fresh exact submitted-message evidence and an empty composer must
not depend on the transient Working label; lack of that label alone is not a
reason to declare a positively observed submission uncertain.

**Concrete failure:** On a ready-file send, have `C-j` move the exact draft
into a new transcript message, empty the composer, and show a tool-result item
instead of Working, with the correlated hook not yet received. Both peers
return `busy/codex-composer-not-ready/mid-send` before `C-m`, creating the
unnecessary hold described in the issue. This is an existing proof limitation
left unresolved by those implementations, not a claim that they introduced
the helper. Codex compares with a pre-send baseline and returns sent without
another key in the same scenario.

**Smallest regression:** Extend the existing early-`C-j` submission case to
render `• Opened current result` instead of Working. Assert `sent` and keys
`[-l, C-j]`, while separately rejecting old matching scrollback as acceptance.

### Scope, reuse, and coverage

All three make the same narrow launcher change, preserving the approval,
sandbox, and per-issue grant arguments while adding `--no-daemon`. All extend
the existing launcher argv test at `test/install.test.ts:632`, skip the Codex
`i` prelude on positive INSERT evidence, retain the existing submit keys, reuse
the composer parser and runner stubs, and introduce no product files or
dependencies. No candidate modifies product hooks, event issue precedence,
peer runtime state, or the shared daemon.

- **Claude:** Five product files. The smallest local settle helper and two
  focused new tests are easy to follow, but the helper introduces finding 3;
  new tests do not cover ordinary retry races or failed final capture. Docs
  mention reinstalling launchers but still describe submission as confirmed
  without explaining the exhausted outcome.
- **Cursor:** Five product files. Straightforward bounded loops and two
  focused new tests, with no run-loop changes. Tests intentionally retain
  `sent` on exhaustion and do not exercise activity/edit races in the new
  ordinary retry path. Docs omit the explicit existing-pane restart step.
- **Codex:** Six product files, additionally `src/runLoop.ts` (present in the
  authoritative approved path list). Factoring the existing lifecycle closure
  and passing it to ordinary Codex delivery is relevant to protecting new
  retries, not an unrelated refactor. The shared proof helper is more complex
  than the peers' loops but avoids duplicating override/ordinary checks. The
  parameterized existing-file coverage includes ordinary, ready-file, and
  sentinel sends; lag, early acceptance, edits, activity, capture loss, stale
  scrollback, and the legacy bound. Direct integration coverage of the new
  run-loop observer remains a gap: `test/runLoop.test.ts` is unchanged because
  its scope amendment was rejected. Deployment docs correctly require
  preserving work, reinstalling the launcher, restarting the affected pane,
  and verifying its current-issue lifecycle/containment rather than restarting
  other clients' shared server.

### Verification evidence

I read the issue-186 journal's **advisory hook observations**, not coordinator
final-check results. Each successful precommit index identity matches the tree
of the corresponding bound implementation (verified from commit metadata):

| Candidate | Product tree | `pnpm run check:fast` | `pnpm run test:e2e` outgoing range |
| --- | --- | --- | --- |
| Claude | `7bcd3fd0ac82d20bdfc846410937abbd47bb7908` | journal sequence 343, exit 0 | sequence 359, exit 0, through readiness `c5b44113f4c59d60245c68f90be4b264c8d62068` |
| Cursor | `d6f9a10ed325fab1d5d169133751874d74233bc8` | sequence 522, exit 0 | sequence 557, exit 0, through readiness `556c91ca25ba8d7ba93b6118d11b13cf9fe579fb` |
| Codex | `3850216150f52b3d69cdd18ee82ed65b8964c9c4` | sequence 574, exit 0 | sequence 576, exit 0, through readiness `5ef9e856da4725ba8e86b66125956da767a61d05` |

Claude's earlier failed check at sequence 251 has a different index identity;
it is not a failure at its current bound pin. I did not rerun those suites for
this comparison or claim their results as coordinator-owned acceptance.

To investigate findings I ran a read-only `node --input-type=module` heredoc,
loading each exported `src/tmux.ts` through in-memory TypeScript transpilation.
It used the same stateful runner shape for each candidate: a ready INSERT
composer, literal text stored as its draft, configurable capture/submit events,
and a no-op sleep except for the explicit gate-change scenario. Six assertions
per pin produced **7 passes and 11 failures of the desired behavior**, not a
passing product suite:

| Probe invariant | Claude | Cursor | Codex |
| --- | --- | --- | --- |
| Exhausted exact draft is not successful submission | FAIL | FAIL | FAIL |
| Working after first `C-m` prevents retry keys | PASS | FAIL | PASS |
| Owner edit during retry gate prevents another `C-m` | FAIL | FAIL | PASS |
| Failed final capture is not submission proof | FAIL | FAIL | PASS |
| New exact transcript without Working proves submission | FAIL | FAIL | PASS |
| Input-off during settle prevents `C-j` | FAIL | PASS | PASS |

Creating scratch probe files under `.codex/tmp/` was denied; no alternate write
location was used, and the probes created no files or real tmux sends. Only
this comparison is submitted. No live Codex restart/containment smoke test has
been established here: argv coverage and the `--no-daemon` flag are not proof
that fresh native hook events reach the current issue. That deployment check
remains necessary before claiming the live misrouting is fixed.

### Recommendation

Select Codex as the least-risk revision base, explicitly resolve the exhausted
outcome contract and authorize its necessary integration-test scope, then
require focused regression evidence and the owner-controlled fresh-pane smoke
check. Do not approve any of these three pins unchanged merely because their
existing hook suites pass.
