# Issue 92 — plan review (claude)

Plans reviewed at their bound commits:

- antigravity — `dc6a7bdf3bc731b81382f0944b26cae400c8c21c`
- cursor — `44a0512f2292d5dd16ff14b9eff2e4755b7d959b`
- claude — `3c9b810b4ab3f329cae009004609d76bbfecfc09`
- codex — `93dce7a2652e1e91488138aee97c6e0d52f932a7`

Finding 1 applies to three of the four plans including my own, so it is stated
once and then attributed. Every claim below was checked against the working
tree at baseline `7fda95334541f40d6f5a7e96bffb4e07ed89e5ee`.

## Findings

### 1. Three plans bump the package version without approving the two tests that assert it

**Claim.** Every plan bumps `package.json` from 0.0.14 to 0.0.15 to clear the
pre-1.0 ship gate: antigravity (`dc6a7bdf3bc731b81382f0944b26cae400c8c21c`,
"Changed" list), cursor (`44a0512f2292d5dd16ff14b9eff2e4755b7d959b`, "Changed"
list), claude (`3c9b810b4ab3f329cae009004609d76bbfecfc09`, file list), codex
(`93dce7a2652e1e91488138aee97c6e0d52f932a7`, file list).

**Rule.** The approved-path gate in `src/evidence.ts` accepts an implementation
only when every path changed between the baseline and the pinned commit is
covered by the selected plan's file map. Anything the version bump forces the
implementer to edit must therefore appear in that plan's file map. Separately,
`pnpm check:fast` must pass before every commit on this branch.

**Failure.** Exactly two assertions in the repository hardcode the current
version:

- `test/cli.test.ts:100` — `expect(lines.join("").trim()).toBe("0.0.14")`
- `test/install.test.ts:165` — `expect(config.coordination?.version).toBe("0.0.14")`

(`grep -rn '0\.0\.14' test/ src/ package.json` returns these two plus
`package.json:3` and nothing else.) Bumping the version makes both fail. The
implementer must edit both files, but:

- antigravity's file map names neither, so it is blocked on both;
- claude's names `test/install.test.ts` (for a launcher assertion) but not
  `test/cli.test.ts`, so it is blocked on `test/cli.test.ts:100`;
- codex's names `test/cli.test.ts` but not `test/install.test.ts`, so it is
  blocked on `test/install.test.ts:165`.

In each case the implementer faces a choice between a red `pnpm check:fast` —
which blocks the commit — and editing a file outside the approved map, which
the evidence gate rejects at `R4.implement`. The failure surfaces only after
the most expensive phase in the baseline (13.84 min, 24.3% of the issue-88 run)
has already been spent.

**Correction.** Add both `test/cli.test.ts` and `test/install.test.ts` to the
file map of every plan that bumps the version. Cursor's plan
(`44a0512f2292d5dd16ff14b9eff2e4755b7d959b`) already lists both and needs no
change.

### 2. antigravity: the AGENTS.md trim cannot reach a commit from an agent clone

**Claim.** antigravity (`dc6a7bdf3bc731b81382f0944b26cae400c8c21c`), "Changed"
list: "`AGENTS.md` — Trim the redundant tracked protocol section (lines 28–129)
… eliminating ~3.6 KB of duplicated instructions from every agent prompt turn."
Its own Alternatives Rejected item 4 simultaneously rejects "Modifying git index
flags or removing `skip-worktree` in clones".

**Rule.** `src/agentsProtocol.ts:50` sets `--skip-worktree` on `AGENTS.md` in
every agent clone, and `git add` on a skip-worktree path stages nothing. A plan
step that cannot be staged cannot be delivered.

**Failure.** The duplication is real — the clone's `AGENTS.md` is 233 lines: the
tracked file plus a `<!-- coordination protocol — coord install -->` overlay at
lines 130–233 that repeats lines 28–129 — so the diagnosis is right. But the
implementer works in an agent clone where `git ls-files -v AGENTS.md` reports
`S`. Reproduced in a scratch repository: with skip-worktree set, editing the
file and running `git add` prints a hint and stages nothing, `git status` is
clean, and the commit carries no change. The implementation therefore publishes
green — `pnpm check` passes, nothing references the trimmed lines — while the
claimed ~3.6 KB per-turn saving silently does not ship. Nothing in the plan's
test list would catch it, because no test asserts `AGENTS.md` content.

**Correction.** Either drop this item, or have the coordinator perform the trim
outside the agent clones and add a test asserting the tracked `AGENTS.md`
contains the protocol headings exactly once, so a no-op commit fails loudly.

### 3. antigravity: trimming the tracked half deletes the only repo-specific check contract

**Claim.** Same item as finding 2: make "the managed overlay … the single
canonical protocol source."

**Rule.** The overlay is rendered verbatim from
`templates/product/AGENTS.protocol.md` (`src/agentsProtocol.ts:16-19`), which is
the generic template installed into *any* onboarded product. Anything specific
to this repository can only live in the tracked section.

**Failure.** The two halves are not identical. The tracked "Checks that actually
run" section carries the paragraph naming this repository's real contract —
`verify.precommit` is `pnpm check:fast`, full `pnpm check` is the coordinator
gate, and non-main branches additionally require a version strictly greater than
`origin/main`. The overlay copy ends at "do not guess them from tracked hook
files" and contains none of it. Deleting lines 28–129 therefore removes the only
statement of the precommit command and the version-bump gate from every agent's
`AGENTS.md` — the exact rule finding 1 shows plans are already getting wrong.
The next issue's agents would plan against a file that no longer names
`pnpm check:fast`.

**Correction.** Trim only the headings that are byte-identical between the two
halves, and keep the repository-specific paragraph in the tracked file.

### 4. antigravity: coordinator-derived artifacts have no commit SHA to record

**Claim.** antigravity (`dc6a7bdf3bc731b81382f0944b26cae400c8c21c`), Risks item
4: "The coordinator will write the derived JSON artifacts (`selection.json`,
`reviser-authorization.json`, `consensus.json`) directly to the coordination
runtime and mirror, computing input-set hashes and citations identical to
agent-authored signals."

**Rule.** `acceptedSubmissionSchema` in `src/state.ts:280-285` requires
`submissionSha: gitShaSchema` — a real 40-character lowercase commit — on every
accepted submission, and `deriveBoundInputs` in `src/runLoop.ts` turns each
accepted submission into a `BoundInput` whose `commitSha` later steps must cite
and `computeInputSetHash` must hash.

**Failure.** A coordinator-derived selection has no commit. Recording it
requires either relaxing `submissionSha` or inventing a SHA; a fabricated
40-hex value passes the schema but is unresolvable in the mirror, so the
`R4.implement` action that binds it would cite a pin no agent can `git show`,
and `checkPin` would reject the first artifact that tries. The plan's file map
does not include `src/state.ts`, so the implementer cannot legally relax the
schema either — the change is blocked by its own file map before the schema
question is even reached.

**Correction.** Adopt codex's shape for this: persist the derived result in
cursor state inside the locked gate transition and journal the source SHAs,
choices, and winner under `gate-advanced`, rather than manufacturing a
submission. That requires adding `src/state.ts` and `src/machine.ts` to the file
map, which codex's plan already does.

### 5. antigravity and codex omit the Antigravity unattended launch entirely

**Claim.** Neither antigravity (`dc6a7bdf3bc731b81382f0944b26cae400c8c21c`) nor
codex (`93dce7a2652e1e91488138aee97c6e0d52f932a7`) lists
`scripts/lib/launcher.sh` in its file map, and neither mentions agent wait.

**Rule.** The owner's Phase-2 direction on issue 92 numbers this third of five
and states the reason: "Fixing launcher/permissions is an efficiency win that
shows up as wait time, not just owner annoyance." A plan may decline a
prioritized item, but then it owes a reason grounded in the measurement.

**Failure.** The baseline puts Antigravity's nudge→intent wait at a median of
~7 min and a max of ~2.3 h on consensus-ai #392, against 48.6s median on
coordination #88. Neither plan changes it and neither explains the omission, so
selecting either leaves the single largest wait component in the run that
motivated this issue untouched — and the change it declines is one line in
`launcher_command()`. `agy --help` on this machine lists
`--dangerously-skip-permissions`, so the flag is available, not speculative.

**Correction.** Add the launcher line, or state in Alternatives Rejected why the
measured wait should stand.

### 6. cursor: the compare packet reads a (commit, path) pair whose blob does not exist

**Claim.** cursor (`44a0512f2292d5dd16ff14b9eff2e4755b7d959b`), Package B: "the
coordinator materializes a content-addressed read-only packet of every bound
implementation pin (`commitSha` + `path`) via the existing mirror `readBlob`
trust boundary … and injects the packet directory plus exact
`git show <sha>:<path>` fallbacks into the action."

**Rule.** For `R5.compare`, `deriveBoundInputs` in `src/runLoop.ts` builds each
input as `inputFromSubmission(value, "implementation", true)` — `commitSha` is
the **product pin** (`submission.productPin`), while `path` is the
implementation-ready **signal** path, `.signals/issue-N/implementation-ready-<agent>.json`.
`src/evidence.ts` separately requires that the product pin differ from the
signal commit ("product pin must differ from the coordination signal commit").

**Failure.** The bound `commitSha` and the bound `path` come from two different
commits. `readBlob(productPin, signalPath)` therefore returns null for every
implementation in the normal case where the signal is committed after the
product pin, so the packet is built with an empty or null-hashed manifest and
the compare agents receive a packet containing none of the implementation code
it exists to hand them. The printed fallback, `git show <productPin>:<signalPath>`,
fails for the same reason, so the plan's independent verification path fails
with it. Nothing detects this: the coordinator wrote a packet, the manifest
hashed what it read, and the action rendered.

**Correction.** Resolve the content from the pin's tree rather than the bound
signal path — for example `mirror.changedPaths(baselineSha, productPin)` for the
file list, reading blobs at `productPin` for the paths that returns.

### 7. cursor: the packet relocates token cost rather than removing it

**Claim.** cursor (`44a0512f2292d5dd16ff14b9eff2e4755b7d959b`), Alternatives
Rejected item 6, rejects "Inlining full implementation blobs into `action.md`"
because it "would explode action bytes and cacheRead further", and offers the
packet as "the bounded form".

**Rule.** The baseline measures agent context, not coordinator file size:
Claude's input side is ~99% cacheRead in every phase, and cacheRead is driven by
what enters an agent's context, wherever it is read from.

**Failure.** Once four compare agents read four full implementations out of the
packet, the token volume entering context is the same as inlining them — the
packet moves the bytes from `action.md` into files the agent opens on the very
next turn, and adds coordinator write I/O. On a #392-scale implementation this
makes `R5.compare` no cheaper, while the plan's own acceptance criterion ("lower
or equal R5.compare wall/token pressure") records the outcome as a pass because
"equal" satisfies it. The stated saving is unfalsifiable as written.

**Correction.** Put a name-status list and diffstat in the packet and leave full
blobs to `git show` drill-down, so the read-once artifact is genuinely smaller
than what it replaces; and tighten the acceptance criterion to a strict
reduction.

### 8. claude and codex ignore the Antigravity prompt-readiness coupling that cursor caught

**Claim.** claude (`3c9b810b4ab3f329cae009004609d76bbfecfc09`) changes the
Antigravity launcher and lists neither `src/tmux.ts` nor `test/tmux.test.ts`.
Cursor (`44a0512f2292d5dd16ff14b9eff2e4755b7d959b`) lists both and states the
condition: "update Antigravity ready detection only if the unattended mode
changes the pane banner that `harnessLooksReady` matches today."

**Rule.** `harnessPromptReady` at `src/tmux.ts:74-79` gates every nudge to
Antigravity on the captured pane text matching both `/>|shortcuts|Accept-edits/i`
and `/Antigravity|Gemini|accept-edits/i`. The coordinator withholds the nudge
while that returns false.

**Failure.** The splash banner supplying "Antigravity" scrolls out of the pane
during a session; after that, the second alternation is satisfied only by the
persistent mode footer, which is where `accept-edits` appears (see the fixture
at `test/tmux.test.ts:37`). If `--dangerously-skip-permissions` changes that
footer text, `harnessPromptReady` returns false for the rest of the session,
every Antigravity action stalls until the observability watchdog fires, and the
change made to *reduce* Antigravity wait increases it. Claude's plan has no step
that would notice; its manual check only confirms that `agy` starts.

**Correction.** Add `src/tmux.ts` and `test/tmux.test.ts` to the file map and
capture the pane text under the new flag before locking the launcher line, as
cursor's plan already requires.

### 9. codex: the largest change budget is spent on the smallest measured share

**Claim.** codex (`93dce7a2652e1e91488138aee97c6e0d52f932a7`), Conclusion: "It
cuts 15 of 37 model actions in a normal four-agent consensus run"; Alternatives
Rejected, "Build a generated context index first", defers the context work until
"the lower-risk turn reduction is measurable."

**Rule.** The owner's Phase-2 direction is explicit about ranking: prioritize
implement-step cost, treat compare as secondary, and "Ballot / publish / declare
/ finalize are small in both runs — low ROI for protocol surgery there unless
they enable larger savings upstream."

**Failure.** The action arithmetic is correct — 4+4+4+4+1+4+4+4+1+1+4+1+1 = 37
for version 1, 4+4+4+4+1+4+1 = 22 for version 2 — and the plan's compatibility
handling (workflow version defaulting to 1 on historical start state) is the
soundest in the set. But the phases it removes total 1.15 + 1.98 + 1.40 + 1.84 +
1.09 + 0.90 = **8.36 min of 56.92**, a 14.7% ceiling on wall clock, while
`R4.implement` + `R5.compare` — **25.15 min, 44.2%** — are untouched by design.
If this plan is selected, the next `coord analytics` run shows implement and
compare unchanged at roughly 44% of a shorter run, and the issue's stated goal
("speed up the process") is only partly met while the whole change budget and
the entire compatibility risk have been spent.

The plan's token case is stronger than its wall-clock case and it should be
argued on those terms: the six eliminated phases account for 9,979,662 of
Claude's 42,022,394 cacheRead tokens on issue 88 — **23.8%**. That is a real
result, and it is nowhere in the plan.

**Correction.** State the token arithmetic in the Conclusion rather than the
action count alone, and pair the version-2 work with at least the one-line
launcher change from finding 5 so the plan touches something the owner ranked
first.

### 10. claude: the plan's own repo-context lever is the weakest-evidenced item in it

**Claim.** claude (`3c9b810b4ab3f329cae009004609d76bbfecfc09`), change 1: naming
`contextPaths` in every action lets agents "open a named short list instead of
running a find/grep sweep to orient."

**Rule.** A plan for this issue must tie each change to a measurement, because
the issue is explicitly "enhancements based on the metrics generated from #91."

**Failure.** Findings 6 and 7 apply in reverse here: naming paths is cheap, but
nothing in the plan predicts how much of the measured cost it removes, and the
baseline attributes tool calls to plan (55), implement (34), and compare (27)
without separating orientation searches from work searches. If agents read
`docs/repo-map.md` *in addition to* their usual sweep — the most likely outcome,
since nothing in the action forbids the sweep — the change adds a file read per
agent per phase and removes nothing, and the plan's measurement step cannot
distinguish that from success because it compares only aggregate phase minutes.

**Correction.** Have the action state that the named context files replace the
initial orientation sweep, and record per-phase tool counts before and after as
the acceptance signal rather than phase minutes alone.

## Conclusion

Request changes on all four plans; none is ready as written.

- **cursor (`44a0512f2292d5dd16ff14b9eff2e4755b7d959b`)** is the strongest base.
  It is the only plan whose file map survives the version bump (finding 1), the
  only one that catches the tmux prompt-readiness coupling (finding 8), and its
  scope matches the owner's ranking. It needs finding 6 fixed before
  implementation — as written, Package B reads a blob that does not exist — and
  finding 7 fixed to make its compare saving falsifiable.
- **codex (`93dce7a2652e1e91488138aee97c6e0d52f932a7`)** is the most rigorous
  document in the set and its backward-compatibility design is the one other
  plans should copy (finding 4). Its problem is target selection, not
  craftsmanship: a 14.7% wall-clock ceiling for the largest and riskiest change
  in the set (finding 9), plus the `test/install.test.ts` block (finding 1).
- **claude (`3c9b810b4ab3f329cae009004609d76bbfecfc09`)** — my own — is blocked
  on `test/cli.test.ts` (finding 1), misses the tmux coupling its own launcher
  change creates (finding 8), and its headline lever is under-evidenced
  (finding 10). All three are correctable within its existing scope.
- **antigravity (`dc6a7bdf3bc731b81382f0944b26cae400c8c21c`)** has the most
  blocking defects: a deliverable that cannot be staged from the clone that must
  deliver it (finding 2), a trim that would delete this repository's only
  statement of its own check contract (finding 3), a derived-artifact design its
  own file map forbids implementing (finding 4), and the version-test block
  (finding 1). Its status-line debouncing idea is worth keeping — it is the only
  plan that addresses journal bloat — but it belongs in another plan.

If one plan must be chosen as-is, cursor's is the only one whose defects are all
inside files it already approved.
