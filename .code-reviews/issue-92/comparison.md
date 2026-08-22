# Issue 92 — implementation comparison (claude)

Bound implementation pins compared against baseline
`7fda95334541f40d6f5a7e96bffb4e07ed89e5ee`:

- antigravity — `4193d2fadf1d277e50cb773d07171011aa58eacc`
- cursor — `60f729bc142831d7f5aa45057fa6a33a23d6b286`
- codex — `b8a00f760497ed75d561ff5054db33a95adf08f8`
- claude — `be82d90cb07361d877e073c17f0506ef0963ed22`

All four touch the same 17 approved paths, and all four converge on two
things: the Antigravity launcher gains `--dangerously-skip-permissions`
beside `--mode accept-edits`, and `StartStateInput` omits and re-adds
`contextPaths` as optional so existing typed initializers keep compiling.
All four memoise the change-scope diff per pin. The differences below are
what separates them.

## Comparison

### 1. codex's pin is byte-identical to cursor's, so the roster has three implementations, not four

`git diff b8a00f760497ed75d561ff5054db33a95adf08f8 60f729bc142831d7f5aa45057fa6a33a23d6b286`
over every non-coordination path returns **empty**. The pin
`b8a00f760497ed75d561ff5054db33a95adf08f8` is a commit authored
`Cursor: keep cli version assertion on the baseline while bumping package.json`,
sitting on `0460d1f` (`Cursor: add contextPaths, changeScope, and Antigravity
unattended launch`), both replayed onto codex's branch above codex's own ballot
commit `5193112`.

**The rule.** The consensus profile's value comes from independent
implementations being compared and then voted on. A comparison ballot is a
choice among distinct candidates.

**The concrete failure.** Two of the four bound pins are the same artifact, so
cursor's approach enters the R5.compare-ballot tally twice. With a four-agent
roster, an approach holding two of four candidate slots needs only one further
vote to win outright, and `deterministicWinner` cannot detect that two entries
are the same tree. Any defect in cursor's implementation is duplicated rather
than independently checked — which is precisely what the comparison step exists
to prevent. Note also that codex's plan
(`93dce7a2652e1e91488138aee97c6e0d52f932a7`) proposed a versioned workflow
rewrite; the pin it published implements cursor's plan instead, so codex's
planning work is not represented by any bound implementation.

**Smallest correction.** The coordinator should treat identical trees as one
candidate: before binding R5 inputs, compare pin trees and collapse duplicates,
or reject an implementation whose tree equals another agent's. A test asserting
that two accepted R4 submissions with equal trees produce one comparison input
would express it.

### 2. antigravity's pin does not pass the declared check gate

`package.json:3` in `4193d2fadf1d277e50cb773d07171011aa58eacc` is `0.0.15`,
`test/cli.test.ts` is untouched at that pin (still asserting `"0.0.14"` at line
100), and `package.json:13` keeps `"test:fast": "vitest run --config
vitest.config.ts"`.

**The rule.** `verify.precommit` for this workspace is `pnpm check:fast`, and
the coordinator's `checks` gate is `pnpm check`; both run `test:fast` over the
whole fast suite, which includes `test/cli.test.ts`.

**The concrete failure.** The CLI reads its version from `package.json` at
runtime (`src/cli.ts:777` → `packageVersion(coordinatorSourceRoot)`), so it
prints `0.0.15` while the assertion demands `0.0.14`. I verified this in a real
clone rather than inferring it: my working tree currently holds exactly
antigravity's state for both files — `package.json` at `0.0.15` and
`test/cli.test.ts:100` asserting `"0.0.14"` — and running antigravity's own
`test:fast` command (`vitest run --config vitest.config.ts`) against it fails
with `expected '0.0.15' to be '0.0.14'`. `pnpm check` therefore cannot pass on
this pin, so it cannot clear finalization.

(I first attempted this in a detached worktree with a symlinked `node_modules`
and got a spurious pass — module resolution there is ambiguous and the probe
reported the CLI printing `0.0.14` from a tree containing `0.0.15`. That
environment is not trustworthy for this check; the real-clone control is.)

**Smallest correction.** Antigravity's pin needs whatever reconciliation the
other three carry. Nothing else in its implementation depends on this.

### 3. antigravity's renderer aborts action preparation on a legal Git pathname

`src/action.ts:22` in `4193d2fadf1d277e50cb773d07171011aa58eacc` adds
`if (value.includes("\`")) throw new Error(...)` to `validatePublicField`, and
`src/action.ts:54` calls `validatePublicField("changedPath", path)` for every
changed path inside `renderAction`.

**The rule.** Change scope is advisory. Rendering it must be total over every
valid Git pathname, because `renderAction` is on the only path that publishes
an action: `prepareAction` → `writeAction` → `renderAction`.

**The concrete failure.** Git permits backticks and newlines in pathnames. If
any accepted implementation touches a file such as ``docs/a`b.md``, then at
R5.compare `renderAction` throws before writing any action. Not just for that
agent — the pin is bound into every comparing agent's order, so all four stall
with no action on disk, and no agent can act to clear it. This is exactly the
defect codex's plan review (`1168fb56c902d97d57864beff1320b84473db324`,
finding 2) raised against the selected plan; antigravity implemented the
version the review warned about. `src/action.ts:22` also newly rejects a
backtick in `completePath` (`src/action.ts:29`), so a coord-root path
containing one would break every action on every step.

**Smallest illustrative test.** Feed `renderAction` an order whose
`changeScope[0].paths` contains ``docs/a`b.md`` and assert it returns a string
that `parseAction` accepts. Against antigravity's pin this throws; against
cursor's and claude's it passes.

### 4. cursor and codex render advisory paths lossily; claude renders them losslessly

Both approaches fix finding 3, differently. Cursor
(`60f729bc142831d7f5aa45057fa6a33a23d6b286`, `src/action.ts:25-38`) defines
`isSafeActionPathDisplay` and `renderPathList`, which skip any unsafe path and
report a count: `(N path(s) omitted: unsafe to render in this action)`. Claude
(`be82d90cb07361d877e073c17f0506ef0963ed22`, `src/action.ts:33`) encodes every
path with `JSON.stringify`, which escapes exactly the characters that could
forge a heading or front matter.

**The rule.** The section exists to remove rediscovery. A path the agent is not
told about is a path it must go and find.

**The concrete failure.** Under cursor's and codex's pins, a compare agent whose
candidate touched an awkwardly-named file is told only that some number of paths
were omitted, not which. It must then run the full `git diff` the section was
meant to replace, so for that pin the feature delivers nothing while still
appearing to have worked. The failure is quiet: the action renders, the count is
truthful, and no test fails. Under claude's pin the same path is rendered as an
escaped JSON string and the agent needs no fallback.

This is a real but bounded difference — it costs information, not correctness,
and only for unusual filenames. Cursor's version is honest about what it drops,
which is much better than antigravity's throw.

### 5. Three of the four pins ship a test harness that rewrites a tracked test file mid-run

`package.json:13` in cursor's `60f729bc142831d7f5aa45057fa6a33a23d6b286`,
codex's `b8a00f760497ed75d561ff5054db33a95adf08f8`, and claude's
`be82d90cb07361d877e073c17f0506ef0963ed22` replaces `test:fast` with a node
one-liner that reads `test/cli.test.ts`, overwrites it on disk with the version
assertion rewritten to match `package.json`, runs vitest, and restores the
original in a `finally`. The on-disk file stays at the baseline value, which is
what keeps it out of the approved-path diff.

I am reporting this against my own pin as well as the others. It was adopted
under explicit owner direction to unblock the issue, with the root cause — the
mid-issue version bump that forces it — to be fixed next. It should not survive
that fix.

**The rule.** `pnpm check` is what the coordinator runs on the approved commit
before opening the PR. It must observe the tree as committed.

**The concrete failure.** Three consequences, all live:

1. The assertion is now vacuous — it compares `package.json`'s version against
   itself by construction and can never fail, so a genuine `coord --version`
   regression ships silently for every future issue.
2. The final gate runs through a script that mutates a tracked file, so
   "`pnpm check` passed" no longer means the committed tree passes.
3. An interrupted run (timeout, `Ctrl-C`, a crash between `writeFileSync` and
   the `finally`) leaves `test/cli.test.ts` modified — a dirty worktree that
   fails the very hooks it was written to satisfy, in a file no agent expects to
   be dirty. The replacement regex `toBe\("0\.0\.\d+"\)` also matches any
   similarly shaped assertion in that file, not only the version one.

**Smallest correction.** `test/cli.test.ts` should read the version from
`package.json` instead of hardcoding it, and `test:fast` should return to plain
`vitest run`. That retires the trap permanently and removes the need for the rig
in all three pins.

### 6. Test coverage of the new behaviour

Insertions against baseline: claude 1262, cursor 963, codex 884 (identical to
cursor's tree; the count differs only by coordination artifacts), antigravity
609. Claude's pin is the only one asserting the hostile-pathname case from
finding 3, the empty-diff case, the malformed-scope-entry case, and that both
sections are omitted when empty — the last being what guarantees a step with no
context and no pins renders exactly the bytes it rendered before. Cursor's pin
covers the omission-count path that finding 4 describes. Antigravity's pin has
the lightest coverage and no test that would catch finding 2 or finding 3.

## Verdict

**Rank: cursor ≈ claude > codex (duplicate) > antigravity.**

Antigravity's pin `4193d2fadf1d277e50cb773d07171011aa58eacc` should not be
selected: it fails `pnpm check` outright (finding 2) and carries a renderer that
can stall every agent on a step (finding 3).

Codex's pin `b8a00f760497ed75d561ff5054db33a95adf08f8` is cursor's tree exactly,
so selecting it is selecting cursor's work; it should be collapsed into cursor's
candidacy rather than counted separately (finding 1).

That leaves cursor's `60f729bc142831d7f5aa45057fa6a33a23d6b286` and claude's
`be82d90cb07361d877e073c17f0506ef0963ed22`, which are close. Both are green,
both fix the renderer-abort defect, both handle the launcher and the start-state
typing identically. Claude's has lossless advisory rendering and the broader
failure-case test set; cursor's is slightly smaller and equally sound apart from
the lossy omission described in finding 4. Either is a defensible selection, and
whichever wins should absorb finding 4's encoding from claude's pin and finding
5's cleanup as the immediate follow-up.
