# Implementation comparison — issue 88

Bound pins:

- cursor `14496c05001a9e72f0a72301c5f12d0ebd597f75`
- codex `b45393f18c9b0fe0ec0bf35e9bb7e41e5b19cb11`
- claude `c90717513ce4935b78c37feba7e18cda55028613`

Every claim below was executed, not read off the diffs. Each pin was checked out
into its own worktree, `dist` was built there (without it, `test/cli.test.ts`
and `test/doctor.test.ts` fail on `Command failed: pnpm build` — an artefact of
my scratch worktrees, not of any implementation), and the suites were run. All
three are green: cursor 439, codex 438, claude 441.

## Comparison

### 1. codex `b45393f1` ships the leak this round exists to remove, and its own rules would flag it

**Where:** `AGENTS.md:45-46` and `AGENTS.md:32` at pin `b45393f18c9b0fe0ec0bf35e9bb7e41e5b19cb11`
— the file is untouched, 129 lines, byte-identical to the baseline.

**Rule:** the selected plan's first changed-file entry is `AGENTS.md`, and
acceptance criterion 1 is that no coordinator phase/delivery jargon appears in
agent-facing prose. The driver's own `AGENTS.md` is loaded into every agent
session in this repository.

**Concrete failure:** at codex's pin, `AGENTS.md` still reads "without a typed
nudge", "when a nudge did not land", "the current step … that step's", and "the
coordinator `checks` gate". Codex's own banned-term list at that pin bans every
one of them — `\bnudg[a-z]*\b`, `\bgates?\b` (`src/agentLanguage.ts:53`), and the
`workflow-sequence` rule codex *added* in this same commit
(`src/agentLanguage.ts:58`). Applying codex's own literal rule set to codex's own
shipped `AGENTS.md` yields:

```
delivery-vocabulary: nudge
gate-vocabulary: gate
workflow-sequence: current step
workflow-sequence: that step
```

The suite passes anyway because codex added no prose-file scan: `grep -c
'AGENT_FACING_PROSE_FILES\|"AGENTS.md"' test/agentLanguage.test.ts` returns 0 at
that pin, against 5 for cursor and 3 for claude. This is the precise pattern
codex's own plan review condemned — an audit whose coverage omits the surface it
certifies clean.

**Smallest test:** add cursor's `keeps internal vocabulary out of every
agent-facing prose file` case, or claude's equivalent. Either fails immediately
at this pin, before any of codex's other work is reached.

### 2. cursor `14496c05` never scans a single real git hook body

**Where:** `test/agentLanguage.test.ts:395` at pin
`14496c05001a9e72f0a72301c5f12d0ebd597f75` — `if (!path.endsWith(".sh")) continue;`

**Rule:** the plan's stated purpose for `shellEmittedText` is that hook stderr
reaches the agent's terminal, so every emitted operand under `githooks/` and
`templates/hooks/` must be scanned. The count guard on the line above
(`expect(walked.length).toBeGreaterThanOrEqual(8)`) exists so an empty walk
cannot pass vacuously.

**Concrete failure:** only three files in those trees carry a `.sh` extension —
`githooks/lib/identity.sh`, `githooks/lib/policy.sh`, `templates/hooks/shim.sh`.
The five files that *are* the git hooks have no extension at all:
`githooks/pre-commit` (8 emit lines), `githooks/pre-push` (9),
`githooks/post-merge` (5), `githooks/post-commit` (3), `githooks/commit-msg` (2)
— 27 of the 35 emitting lines, and the only ones an agent sees on a blocked
commit or push. The `>= 8` assertion is satisfied by the very files the loop then
skips, so the guard reports coverage that does not exist.

Executed: appending `echo "this step is gated by R6"` to `githooks/pre-commit`
and re-running the suite at each pin gives

```
cursor: 15 passed        <- undetected
codex:  1 failed | 13 passed
claude: 1 failed | 16 passed
```

**Smallest fix:** delete line 395. Codex's loop
(`filesUnder(...)` with no extension filter) and claude's `walk(...)` both
already scan every file, and both catch the injected string.

### 3. claude `c9071751` narrows the oracle and stops catching four leak classes the baseline caught

**Where:** `src/agentLanguage.ts:59-63` at pin
`c90717513ce4935b78c37feba7e18cda55028613` — `\bR[1-7]\b`, `\bphases?\b` and
`\bgates?\b` are removed from `AGENT_FACING_BANNED_TERMS`.

**Rule:** the banned-term list is the only mechanical guard on agent-facing text.
Removing a rule is safe only when it produces a false positive on text that must
stay; it must not re-legalise strings the previous round removed.

**Concrete failure:** this is my own pin, and it is the weakest of the three on
enforcement. Running the same probe strings through each pin's literal rule set:

```
                                              cursor   codex    claude
"R7 finalization is deletion-only cleanup"    CAUGHT   CAUGHT   passes
"they gate pull-request creation"             CAUGHT   CAUGHT   passes
"the current phase of the workflow"           CAUGHT   CAUGHT   passes
"wait for the R6 revision round"              CAUGHT   CAUGHT   passes
"must not commit ungated"                     CAUGHT   CAUGHT   CAUGHT
"the format for the current step"             CAUGHT   CAUGHT   CAUGHT
"the final cleanup step deletes those paths"  CAUGHT   CAUGHT   CAUGHT
```

The first two are the exact strings issue 88's first round removed from
`templates/product/AGENTS.md`. A future edit reintroducing either passes claude's
suite and fails the other two. The visible consequence is already in the tree:
`AGENTS.md:125` at claude's pin still reads "what the coordinator `checks` gate",
which cursor's pin reworded because cursor kept the rule.

I implemented the selected plan's instruction literally — plan `a58b4d38`
directs "drop bare `\bphases?\b`, `\bgates?\b`, and `\bR[1-7]\b`". Cursor and
codex both declined that instruction and kept the strict rules, which is what
both plan reviews had asked for. On this axis their judgement was better than my
compliance.

**Smallest fix:** restore the three patterns and reword `AGENTS.md:125`. Cursor's
`\b(?:un)?gat(?:e|es|ed|ing)\b` at pin `14496c05` is the cleanest form: it keeps
the bare-gate ban and folds in the inflections in one rule.

### 4. cursor `14496c05` reads its prose fixture from the git index through a subprocess

**Where:** `test/agentLanguage.test.ts:321` —
`execSync("git show :AGENTS.md", { cwd: repoRoot, encoding: "utf8" })`

**Rule:** a regression test should assert over the content the repository ships
and should not depend on mutable local state or on an external binary.

**Concrete failure:** `git show :AGENTS.md` reads the *index*, not `HEAD` and not
the worktree. In an agent clone the index is exactly where an in-flight edit
sits: after `git update-index --no-skip-worktree -- AGENTS.md && git add
AGENTS.md` — the staging route cursor's own plan prescribes — the index holds the
worktree copy including the 121-line installed protocol overlay, and the test
then asserts over content that will never be committed. It also requires `git` on
`PATH` and a repository present, so the case throws rather than reporting a
language violation when the suite runs from an exported tree.

**Smallest fix:** read the worktree file and strip the managed block in-process,
as claude's pin does:
`removeManagedBlock(readFileSync(join(repoRoot, "AGENTS.md"), "utf8"), "AGENTS.md", AGENTS_PROTOCOL_MARKERS).content`.
That is deterministic, needs no subprocess, and yields the same bytes in a fresh
checkout and in an installed clone.

### 5. cursor `14496c05` carries a stale signal file from the previous issue-88 session

**Where:** `.signals/issue-88/joined-cursor.json` at pin
`14496c05001a9e72f0a72301c5f12d0ebd597f75`

**Rule:** an issue branch should carry only the current session's evidence;
agents must not fabricate `.signals/` entries, and every published signal must
name the current `issueSessionId`.

**Concrete failure:** the file is not any step's required path — `src/steps.ts:79`
publishes `participation-ready-<agent>.json` — and its body reads
`"issueSessionId": "issue-88:26de98aa…"` with `"artifact": "join"`, both from the
first issue-88 run, not from this session's baseline `76cfd155`. Cursor's own new
rules ban that token (`"artifact"\s*:\s*"join"`) and that filename shape
(`joined-`). Severity is low because `.signals/issue-88/` is a current-issue
coordination path, exempt from the approved-path check and deleted wholesale at
finalization — but it is dead evidence naming the wrong session, and nothing
would have caught it.

**Smallest fix:** delete the file on the cursor branch.

### 6. All three modify the product hook tree, and all three converge on the wording

`githooks/lib/identity.sh` and `templates/hooks/shim.sh` are changed identically
in intent at all three pins, replacing "must not commit ungated" with a
declared-checks sentence; `src/hookPolicy.ts` swaps "both phases empty" for "both
lists empty" at all three. Codex's phrasing is the best of the three — "so this
agent clone must run the project's declared checks before committing" is a
positive instruction, where cursor's and claude's keep the double negative "must
not commit without running…".

This is not a differentiator, but it is worth surfacing to the owner: AGENTS.md
says "Do not modify the product `githooks/` tree as the way to satisfy checks",
and codex's own plan review called this out as disqualifying for cursor's plan
before codex made the same edit. Here the message text *is* the deliverable
rather than a means of turning a check green, so I read it as within scope — but
that reading should be stated by the owner rather than assumed by three agents
independently.

## Verdict

Ranked on what each pin actually does to the issue's two acceptance criteria:

**cursor `14496c05001a9e72f0a72301c5f12d0ebd597f75` is the strongest.** It is the
only pin that closes every enumerated leak — `AGENTS.md` fully cleaned including
the `checks gate` sentence, both templates, both scaffolds, all hook diagnostics
— while *keeping* the strict oracle its own plan proposed to weaken, and it
adopts the exported prose-file list so the enumeration gap cannot reopen. Its two
defects are contained: delete one line (finding 2) and swap one fixture source
(finding 4).

**claude `c90717513ce4935b78c37feba7e18cda55028613` is second.** Its coverage is
complete and its hook walk and prose scan are the most robust of the three, but
it is the only pin that weakens the guard, and it does so on four leak classes
including the two the previous round removed (finding 3). Correctable by
restoring three patterns, but it is a regression the other two avoided.

**codex `b45393f18c9b0fe0ec0bf35e9bb7e41e5b19cb11` is not acceptable.** It
strengthens the rules and then ships the file those rules condemn, because it
scans no prose file at all (finding 1). Its hook walk is correct and its wording
is the best written, but the round's primary leak survives it untouched.

Best combination if a revision is authorised: cursor's pin, minus line 395 of
`test/agentLanguage.test.ts`, with claude's `removeManagedBlock` fixture in place
of the `git show` subprocess, codex's hook-diagnostic wording, and the stale
`.signals/issue-88/joined-cursor.json` deleted.
