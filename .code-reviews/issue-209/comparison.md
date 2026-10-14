# Issue 209 implementation comparison

These are the bound implementation pins. Each was read from its exported
worktree at `docs/issue-209-efficiency-analysis.md`:

| Agent | Pin | Report size |
| --- | --- | --- |
| antigravity | `3efad6dc505f58f73561c9daad385fbccaa385c2` | 218 lines |
| cursor | `048135d9144c7bd8b87a1e86c78bd28b86ee27f0` | 160 lines |
| claude | `f274b186713f325492a93579e07f7b6c8fdab2b4` | 741 lines |
| codex | `15a02a905425b5da3c891f274302f9a3c0a7ef2e` | 724 lines |

**Scope.** Every pin changes only the single approved product path,
`docs/issue-209-efficiency-analysis.md`, plus its own coordination evidence.
None touches source, tests, configuration or hooks, and none posts the issue
comment. All four use the same cohort: 177, 195, 184, 204 and 206, ordered by
`createdAt`. They agree on every phase, pause and run headline that
`coord analytics` prints.

**Checks run for this comparison.** All are read-only:
- I re-read the cohort journals to check the claims in the findings below.
- I extracted codex's embedded calculation (doc lines 592–707) and ran it with
  `python3 -I` against `<coord-runtime>`. It exits 0, its reconciliation
  assertions pass, and its run elapsed, paused and hold durations equal
  `coord analytics`.
- Claude's embedded script was verified when it was implemented (identical
  output).
- No product suite was run. The hooks recorded `check:fast` and `test:e2e` for
  each pin and those results are cited as is. The coordinator owns final checks.

**Owner guidance for this action.** "We have hopefully fixed the delays caused
by the coordinator misreading idle status, and also failing to send proper
timed prelude strings." The selected report therefore needs a delivery measure
that can confirm or refute that fix in later runs. Several findings below turn
on that requirement.

## Comparison

### C1. codex `15a02a90`: delivery is called unattributable although the journal attributes it

- **Location.** `docs/issue-209-efficiency-analysis.md:233-238`. Cursor's
  "34.06-minute nudge-to-intent interval" in 204 R4.implement is said not to
  "distinguish coding, interrupted delivery, and manual work". Lines 376-387
  then rank "make blocked delivery and hold recovery visible earlier", using
  preparation-to-first-send as the metric.
- **Rule.** Where the journal records a boundary, the report must attribute
  time with it. A proposal's validation metric must be able to detect the
  defect it targets.
- **Concrete failure.** The 204 journal does separate delivery from work:
  - Cursor's sends at sequences 279, 284, 287, 289 (owner) and 291 produced
    no cursor `agent-lifecycle` `prompt-submitted`.
  - The first prompt was submitted at sequence 293, 0.4 s after the owner send
    at 292, and 449.8 s after the first nudge.
  - In R4.implement, 450 s of cursor's 2,043.7 s is therefore lost delivery,
    not coding.

  Across the cohort, sends followed by `prompt-submitted` within 5 s were:

  | Agent | First sends | Resends |
  | --- | --- | --- |
  | claude | 37 of 37 | — |
  | codex | 40 of 40 | — |
  | cursor | 11 of 22 | 1 of 29 |

  - The proposed metric cannot see the failure. Cursor's preparation-to-first-send
    in 204 R4 was 1.75 s (codex's own table, line 217), because the send
    happened promptly and was then lost.
  - So the owner's prelude and idle fix could regress and codex's validation
    would still pass.
- **Smallest test.** A test cannot express this; it is an evidence correction.
  Add per-vendor `nudged` → `prompt-submitted` within N seconds, split into
  first, resend and owner sends, and use it as the validation metric for
  proposal 1.

### C2. antigravity `3efad6dc`: the proposal to bypass finalization rests on a false classification claim and would skip a required gate

- **Location.**
  - `docs/issue-209-efficiency-analysis.md:107` says commits that delete
    coordination files "are classified as `product` changes and undergo full
    verification even though the approved pin already passed those exact
    checks".
  - Lines 155-160 (proposal 3, "Risk / Safety: Zero") and line 205 propose
    skipping `pnpm run check` when the last commit only deletes evidence.
- **Rule.** The protocol states that final checks are "classified against the
  frozen issue baseline, not the last cleanup commit". Hook mode never ran
  `pnpm run check` (build + `check:fast` + e2e) on the pin. It ran only the
  precommit `check:fast` and prepush `test:e2e`.
- **Concrete failure.** Every cohort finalization `verification-run` classifies
  the baseline..final range by a real product path:

  | Run | Path that made the range `product` |
  | --- | --- |
  | 177 | `README.md` |
  | 195, 184, 206 | `docs/coord-driver.md` |
  | 204 | `scripts/lib/launcher.sh` |

  The final check therefore runs because the issue changed product files, not
  because of the cleanup commit. Implementing the proposed bypass would
  approve finalization on hook results that never included `pnpm build`, so a
  pin that type-checks but fails the build would ship.
- **Smallest test.** In the verification-runner tests, cover a final commit
  that only deletes `.plans/` on top of a pin that changed `src/`. Assert that
  the baseline-range classification stays `product` and the final `check`
  still runs.

### C3. antigravity `3efad6dc`: headline numbers have no derivation, and a solo speedup is inferred from one dissimilar task

- **Location.**
  - `docs/issue-209-efficiency-analysis.md:7`: "Faster agents sit completely
    idle for 50–75% of a phase's active duration".
  - Line 11: "reduce multi-agent consensus run times from 75–120+ active
    minutes down to 30–45 minutes".
  - Line 194: solo 206 shows that multi-agent overhead "accounts for >50 min".
  - Line 134: the R1 tool sequence "takes 1.5–2.5 minutes of CLI invocation
    overhead".
- **Rule.** The selected plan (step 6) says to label savings as estimates with
  assumptions, not to add overlapping savings, and not to infer a solo speedup
  from one dissimilar task. Every number must be reproducible.
- **Concrete failure.**
  - None of these figures has a computation in the document.
  - The R1 claim contradicts issue 209's join. From containment guard denial
    to coverage record took 3.4–21.9 s. Commit-hook start to acceptance took
    5.7–23.2 s. Both hooks finished in about 1 ms.
  - Antigravity's own 95 s gap is unattributed, not CLI overhead.
  - The document embeds no calculation snippet or source hashes (plan step 1),
    so these claims cannot be checked from the report.
  - Lines 22-25 also label terminal gate sequences as event counts, for
    example 3,418 for 177, whose journal has 3,420 events.
- **Smallest fix.** Delete the unsupported percentages. Keep only figures
  derived from tables in the report, with their assumptions.

### C4. antigravity `3efad6dc`: the ballot quorum proposal would drop the slowest agent from most votes

- **Location.** `docs/issue-209-efficiency-analysis.md:140-145` and line 203
  propose closing a ballot "after a 60s cutoff, treating unresponsive agents
  as abstentions", with "Risk / Safety: Low".
- **Rule.** The plan requires review and consensus gates to be preserved.
- **Concrete failure.** Cursor's ballot acceptance after preparation was:

  | Run | Phase | Seconds |
  | --- | --- | ---: |
  | 195 | R3.plan-ballot | 695.8 |
  | 195 | R5.compare-ballot | 325.1 |
  | 204 | R5.compare-ballot | 296.9 |
  | 204 | R6.ballot | 184.5 |
  | 177 | R5.compare-ballot | 295.1 |

  - Claude's and codex's ballots took 9–69 s.
  - With a 60 s cutoff, cursor abstains in most cohort ballots. "Consensus"
    then silently becomes a two-agent decision.
  - The cause is cursor's undelivered prompts (C1), which the owner says has
    now been addressed. The quorum would hide that defect instead of measuring
    it.
- **Smallest test.** A ballot-tally test where one active agent's private
  response arrives after the proposed cutoff. Assert that the decision still
  waits for it, or that the run surfaces a hold.

### C5. antigravity `3efad6dc`: a "new" profile is proposed that largely exists, and publication posts the whole file

- **Location.**
  - `docs/issue-209-efficiency-analysis.md:170-175` proposes introducing a
    hybrid `assisted` or `reviewed-solo` profile.
  - Lines 183/207 delimit the payload with the same marker twice, while line
    217 publishes with
    `gh issue comment 209 … --body-file docs/issue-209-efficiency-analysis.md`.
- **Rule.** The plan's step 6 requires checking whether an improvement already
  exists. The comment must be exactly the reviewed payload.
- **Concrete failure.**
  - `docs/coord-driver.md:567` already defines `reviewed`: "all configured
    reviewers participate in plan selection, one designated implementer
    continues". The proposal re-requests an existing profile.
  - The publication command posts all 218 lines: executive summary,
    methodology, ranked proposals and the receipt section itself. It does not
    post the delimited text at lines 183-207.
- **Smallest fix.**
  - Reword the profile proposal as owner adoption of `--profile reviewed`.
  - Extract the delimited block into a temporary body file before running
    `gh issue comment`.

### C6. cursor `048135d9`: the verification proposal relies on hook receipts that the code never creates

- **Location.** `docs/issue-209-efficiency-analysis.md:152`: "If a final
  `check` can be satisfied by hook receipts for the same tree", with the
  validation "a later run reports reused greater than 0 … when the hooked
  commands already passed".
- **Rule.** `docs/coord-driver.md` (Coordinator-owned verification) says:
  "Hook records, agent signals, failed, interrupted or dirty runs never become
  receipts." Receipts come only from coordinator-run candidate or final checks
  under `verification.mode: "coordinator"`, which this runtime does not freeze.
- **Concrete failure.** The owner keeps hook mode, as cursor's proposal
  implies, and waits for reuse. `Reused results` stays 0 indefinitely, and the
  validation can never pass. The actual existing lever is to adopt coordinator
  mode with cache declarations, and the report does not name it.
- **Smallest fix.** Replace "hook receipts" with "coordinator-mode candidate
  receipts (`verification.mode`, cache declarations as in
  `config.example.json`)".

### C7. cursor `048135d9`: the runner union is called the "critical path" and compared against unpaused time without removing pause overlap

- **Location.**
  - `docs/issue-209-efficiency-analysis.md:128` heads the runner union
    "Critical-path s".
  - Lines 132 and 152 give "whole verification critical path is 14–16% of
    unpaused time".
  - Line 138 reads "184 388.5s of 19.76 unpaused min".
- **Rule.** The selected plan (step 5) says union intervals "is not a
  reconstructed causal critical path". A share of unpaused time must exclude
  runner time that overlapped a pause.
- **Concrete failure.**
  - In 184, 189.6 s of the 555.3 s runner union ran during the R4 nudge-loop
    hold. Codex's V-unpaused column is 3.31 of 6.47 min.
  - Cursor's 16% for 184 is therefore 10.5% in unpaused terms, and its R4
    figure counts paused runner time against unpaused minutes.
  - Labelling the union "critical path" invites deducting it from phase time.
    The report's own line 150 says not to do that.
- **Smallest fix.** Rename the column "runner union". Compute the share from
  the union minus its pause overlap.

### C8. cursor `048135d9`: there is no calculation snippet, so the non-analytics tables cannot be reproduced

- **Location.** `docs/issue-209-efficiency-analysis.md:31-37` describes the
  rules in prose. Lines 84-91 (hold seconds and sequences) and 99-120
  (per-action sequences) cannot be produced by `coord analytics`.
- **Rule.** Selected plan step 1: "Include source hashes and calculation
  commands/snippets in the report so another agent can reproduce the tables
  without the author's scratch files."
- **Concrete failure.** A reviewer cannot regenerate the hold and action
  tables from the report. A transcription error there, such as line 82's "on
  all five" against the six holds listed, cannot be caught mechanically.
- **Smallest fix.** Embed the read-only calculation, as codex (lines 592-707)
  and claude do.

### C9. claude `f274b186` (self-comparison): two smaller gaps relative to codex

- **Location.**
  - `docs/issue-209-efficiency-analysis.md:281` cites the R4.implement runner
    union "6.47–10.17 min" without separating pause overlap. The 6.47 is 184,
    where 189.6 s overlapped the hold.
  - Line 50's inventory hashes only `journal.jsonl`. Codex also hashes
    `start.json`, `cursors.json`, final-check logs and terminal logs.
- **Rule.** The same as C7 for any union quoted next to unpaused time. Plan
  step 1 asks for source hashes for the evidence used.
- **Concrete failure.**
  - The report never converts the union into a share of unpaused time, so no
    wrong share is printed. A reader who did would overstate 184 by about
    3 min.
  - The terminal-log observation (204 cursor INSERT/prelude) cites a file
    without a hash.
- **Smallest fix.** Add a V-unpaused figure for 184 and hashes for the
  terminal and final-check logs. Both fit inside the approved file during
  revision.

### C10. codex `15a02a90`, minor: the comment body includes the whole calculation appendix

- **Location.** `docs/issue-209-efficiency-analysis.md:1` places the marker at
  the top, and line 713 closes the body. The posted comment is therefore
  lines 1-712, including the 115-line Python block and three hash tables:
  about 44 KB.
- **Rule.** The comment is the owner-facing proposal. The plan puts
  reproducibility material in the report.
- **Concrete failure.** The failure is not a size limit; the body is under
  65,536 characters. The issue thread instead carries a large code block whose
  ranked proposals start at line 374. That is acceptable but heavier than
  needed.
- **Smallest fix.** Move the `<details>` appendix and source manifest after
  `comment-body:end`.

### Coverage of the owner's questions

- **R1.join (previous action's guidance).** Codex, cursor and claude all
  explain it correctly with 209's closed join (sequences 0–165): 159.956 s,
  antigravity's turn last, and a 19 ms coordinator lag. Claude adds the
  containment and git-step split from lifecycle and hook events. Antigravity
  attributes it to 1.5–2.5 min of tool overhead (C3).
- **Prelude and idle fix (this action's guidance).** Only claude:
  - measures delivery per vendor (line 210);
  - ties cursor's losses to #206, citing the vim INSERT/`a`-prefix pane
    evidence;
  - proposes the per-vendor landing rate as the check on the fix.

  Codex treats the same interval as unattributable (C1). Cursor asks why
  "working" deferrals lead to holds but does not measure delivery.
  Antigravity proposes routing around the stalled agent (C4).

### Reuse and focus

- **Reuse of the existing reader.** All four reuse `coord analytics`.
- **Independent, reproducible calculations.** Codex and claude embed them, and
  both were run to confirm.
- **Distinguishing existing mechanisms from new work.**
  - Codex does this most carefully: `n` reminders, hold ACTION messages,
    receipts, materialized packets.
  - Claude names #206, `n` delivery, coordinator mode and the `reviewed`
    profile.
  - Cursor misnames the receipt source (C6).
  - Antigravity proposes rebuilding existing features or removing gates
    (C2, C4, C5).
- **New tests or files.** None of the four adds either, which is correct for a
  report.

### Recommendation

**Select claude `f274b186713f325492a93579e07f7b6c8fdab2b4`.** It is the only
pin whose top recommendation is measured by a metric that can verify the
owner's stated delivery fix (C1). Its numbers reproduce from an embedded
script. It posts only a delimited 4.7 KB body. During revision, fold in from
codex `15a02a905425b5da3c891f274302f9a3c0a7ef2e`:
- V-unpaused verification (C9);
- the start, cursors and log hashes;
- the final-check log suite breakdown;
- the 177 antigravity first-send delay (29.64 min).

Codex `15a02a90` is a close second: the most rigorous provenance and caveats,
but with the delivery gap in C1. Cursor `048135d9` needs C6–C8.
Antigravity `3efad6dc` should not be selected: C2 and C4 would weaken required
gates, and C3 leaves its figures unsupported.
