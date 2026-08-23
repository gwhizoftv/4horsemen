# Issue 95 implementation comparison

Bound implementation pins compared:

- claude `b331e9a0cb4cf9acdc455eb272371278ddbc0414`
- codex `5f3c7a8b9c18d2f6abf6cc2cb3542609d42d4f17`
- cursor `1addcc238016dd198255fef585e0dbdbf3856ef0`

## Comparison

All three pins change the same eleven product files and no others, and all three
carry `package.json` at `0.0.18` — equal to `origin/main` — which is the state
acceptance criterion 1 is about. None of them bumped the version mid-protocol,
and none touched `test/support/`, `githooks/`, or `src/checkVersionBump.ts`,
even though the approved path list would have permitted the first of those.

### Verification actually run

I did not judge the peer pins by reading alone. Each was checked out into a
detached worktree and exercised with this clone's toolchain:

| Check | claude `b331e9a0` | codex `5f3c7a8b` | cursor `1addcc23` |
| --- | --- | --- | --- |
| `tsc -p tsconfig.json --noEmit` | clean | clean | clean |
| `tsc -p test/tsconfig.json` | clean | clean | clean |
| `eslint src test` | clean | clean | clean |
| `versionBump` + `cli` + `install` tests | 67 passed | 67 passed | 69 passed |
| e2e (`vitest.e2e.config.ts`) | 2 passed | 2 passed | 2 passed |
| full `pnpm check:fast` at `0.0.18` | 435 passed | — | — |
| `pnpm check:version-bump`, equal version | exit 1 | — | — |
| `pnpm check:version-bump`, base `0.0.13` | exit 0 | — | — |

One caveat on my own method: the first peer run reported 32 failures in both
worktrees. That was my harness, not their code — `ensureBuilt` shells out to
`pnpm build`, and pnpm's dependency-status check rejects a worktree whose
`node_modules` is a symlink. Building `dist/` with `tsc` directly cleared it and
both pins went green. I am recording this because the failure looked damning and
was not.

**No correctness defect was found in any of the three pins.** The live ship-gate
case is gone from all of them, the surviving gate is intact in all of them, and
the four agent-facing surfaces are corrected in all of them. What follows is
ranked on secondary quality, and the findings are small by comparison with that
agreement.

### 1. codex `5f3c7a8b`: three gate decisions asserted inside one test case

`test/versionBump.test.ts:29` — the whole fixture is a single
`it("rejects an equal feature version, accepts an advance, and exempts the base branch", …)`.

**Rule.** When one test covers several independent decisions, a failure must
still identify which decision broke; assertions after the first failure in a
case never execute, so they report nothing.

**Concrete failure.** Suppose a later refactor breaks the base-branch exemption
(`src/versionBump.ts:83-92`) *and* nothing else. The exemption assertion is the
third in the case, so it does report. But invert the situation: a change that
makes `enforce` always `false` fails assertion 1 and aborts the case, so the
exemption assertion — the one that would have shown the gate now passes
everything — never runs. The suite reports exactly one failing test whose name
lists all three behaviors, and the reader cannot tell from the report which of
the three decisions regressed, or whether more than one did. The information
that matters most when a merge gate breaks is precisely which decision changed.

**Smallest correction.** Split into three cases, as cursor does at
`test/versionBump.test.ts:62`, `:71`, `:81` and claude at `:62`, `:69`, `:76`.
The fixture helper is already extracted in both, so this costs nothing but
whitespace.

### 2. codex `5f3c7a8b` and cursor `1addcc23`: the parse-rejection decision is uncovered

`test/versionBump.test.ts` (codex `:29`, cursor `:62`-`:88`) — both fixtures
cover equal-version rejection, strict-advance acceptance, and the base-branch
exemption. Neither drives the fourth branch, `src/versionBump.ts:99-110`, where
a version that is not a dotted triple returns `ok: false`.

**Rule.** Every branch of the surviving merge gate that can return `ok` needs
coverage, because `pnpm check:fast` no longer exercises this function against a
real branch at all — a wrong answer here is silently green rather than red.

**Concrete failure.** Change `if (headParts === null || baseParts === null)` to
return `ok: true` — a plausible "unparseable versions shouldn't block anyone"
edit. A PR that sets `"version": "0.1.0-rc.1"` then passes the gate and merges,
and the pre-1.0 `0.0.N` scheme the whole issue is built around is silently
abandoned. Every test in both pins stays green.

**Smallest correction.** One more case against the same fixture:
build the repo with a head manifest of `0.0.2-beta` and assert
`enforce: true, ok: false`. claude `b331e9a0` has this at
`test/versionBump.test.ts:83`.

### 3. claude `b331e9a0`: the fixture asserts the decision but not the inputs it read

`test/versionBump.test.ts:62-87` — every case asserts only `enforce` and `ok`.
Both peers additionally assert `headVersion` and `baseVersion` (codex
`test/versionBump.test.ts:29`, cursor `test/versionBump.test.ts:62`).

**Rule.** A test for a comparison should pin which two values were compared, not
only the verdict, so the report says what the function saw.

**Concrete failure.** This one is narrower than it first looks, and I am stating
the limit honestly rather than inflating my own gap: the obvious regressions —
reading the head manifest as the base, or swapping the two operands — are still
caught by the strict-advance case, which flips to `ok: false`. What escapes is a
regression that reads *some other* lower base, for instance resolving `baseRef`
to the wrong ref while still finding a parseable older version. The verdict
stays correct for the fixture's inputs, and no assertion records that the base
version was not the one on `main`.

**Smallest correction.** Add `expect(result.baseVersion).toBe("0.0.1")` and the
matching `headVersion` assertion to the two enforcing cases, which is exactly
what both peers already do.

### 4. codex `5f3c7a8b`: the surviving gate is missing from the command list

`docs/repo-map.md:57-62` — the "Commands that actually run" list keeps
`check:fast`, `check`, and `test:e2e`, and the prose below it (`:62`) names the
`version-bump` GitHub Action, but `pnpm check:version-bump` never appears as a
listed command.

**Rule.** repo-map's command list exists so an agent can find what runs without
searching the tree; the one command this issue promotes to sole enforcement
belongs in it.

**Concrete failure.** An agent preparing the merge commit reads the list, sees
three commands, none of which check the version, and has no local way to confirm
the bump before pushing. They discover the requirement from a red PR check
instead — the same discover-by-failure loop the issue set out to remove, just
moved later.

**Smallest correction.** Add the bullet cursor has at `docs/repo-map.md:61`
("`pnpm check:version-bump` — pre-1.0 merge gate only…"), or claude's
equivalent.

### 5. cursor `1addcc23`: a 143-column line in a hand-wrapped file

`AGENTS.md:126` — 143 characters, in a file whose every other line wraps at
77-79 (verified by measuring lines 124-130 of all three pins).

**Rule.** `AGENTS.md` is hand-wrapped and read in terminals; a line at nearly
twice the file's width wraps unpredictably.

**Concrete failure.** Cosmetic only — no check enforces it, since `eslint` covers
`src` and `test` alone. It is worth one line here because this file is the
agent-facing protocol and the next agent to edit that paragraph inherits the
irregular wrap.

**Smallest correction.** Re-wrap the sentence at 79 columns.

### Ranking

**claude `b331e9a0`** and **cursor `1addcc23`** are the two strongest pins and
are close. Both split the gate fixture into named cases and both list
`check:version-bump` where an agent will find it. claude additionally covers the
parse-rejection branch (finding 2) and carries the fullest agent-facing wording
— it is the only one that tells agents outright not to plan a bump for ordinary
issue-branch commits, which is what acceptance criterion 4 asks for. Its gaps
are finding 3 (inputs not asserted) and nothing else. cursor's gaps are findings
2 and 5, both small, and its assertions on `headVersion`/`baseVersion` are
better than claude's.

**codex `5f3c7a8b`** is correct and passes everything, but carries findings 1, 2,
and 4 — the coarsest test reporting of the three and the one documentation set
that omits the surviving command. Its `AGENTS.md` sentence is the tightest
written of the three.

If one pin ships as-is, claude `b331e9a0` with finding 3 applied is the smallest
distance to a complete implementation; cursor `1addcc23` with findings 2 and 5
applied is an equally acceptable destination. Any of the three merged today
would satisfy every acceptance criterion in the issue.

### One thing that applies to whichever pin is chosen

`package.json` is `0.0.18` in all three, matching `origin/main`. That is correct
for the implement step and is the evidence for acceptance criterion 1, but it
means the PR into `main` will be blocked by the `version-bump` workflow until a
separate commit advances the version. That commit is merge preparation, must be
taken against the base as it stands at that moment rather than the `0.0.19`
guessed during planning, and must not be folded into the implementation pin.
