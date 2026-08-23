# Plan review — issue 95

Reviewed the Cursor plan at `50a6f7c0dc6941c61ae17aa1890015137b5d651f`,
the Claude plan at `8eb124c6495be6c19cb12afd3531c225b86166f5`, and
the Codex plan at `95ffc31408fb69bc596d2c863fd34df3977b1afa`.

## Findings

### 1. None of the plans gives a permitted, mechanically executable way to commit the tracked AGENTS change

**Plan claim:** All three Exact File List sections require changing tracked
`AGENTS.md` while preserving its clone-local overlay. Cursor says to edit the
tracked sentence without clearing skip-worktree, Codex says to preserve the bit
while updating the tracked documentation, and Claude's Risks section proposes
`git update-index --cacheinfo` followed by re-setting skip-worktree.

**Rule that must hold:** The repository protocol says the clone's skip-worktree
bit must not be cleared or otherwise changed, the clone-local protocol overlay
must not be replaced, and a mechanically complete plan must describe work that
can actually reach the issue commit under those constraints.

**Concrete failure:** A normal worktree edit to `AGENTS.md` is ignored while the
entry is `S`, so the Cursor and Codex instructions can produce a commit that
silently omits the required acceptance change. Claude's proposed `--cacheinfo`
sequence explicitly flips the entry from `S` to `H` before setting it back, so
following that plan performs the forbidden index-flag transition; an
interruption between those commands also leaves the clone-local overlay
unprotected. Thus every plan either omits the tracked change or violates the
protocol as written.

**Smallest correction:** Remove the forbidden cache-info sequence and obtain an
owner/coordinator-supported tracked-file update path that leaves this clone's
index flag untouched for the entire operation. If no such path is provided,
escalate the `AGENTS.md` acceptance item for an explicitly owner-authorized
commit rather than pretending the automated implementation can stage it.

### 2. Cursor hardcodes the very next-version guess this issue is meant to eliminate

**Plan claim:** Cursor's `package.json` entry and Conclusion require a one-time
`0.0.18` to `0.0.19` bump on this PR branch before merge, while the same plan's
A1 acceptance case requires the implementation branch to remain equal to
origin/main during the normal suites.

**Rule that must hold:** The version must be selected from the actual PR base at
merge preparation, not guessed during planning, and the mid-protocol approved
implementation must be able to demonstrate that an equal version passes
`check:fast` and `check`.

**Concrete failure:** If another PR advances main to `0.0.19` before issue 95 is
ready, following the literal plan produces a head version equal to the base and
the surviving version-bump workflow rejects the PR. If the implementer instead
bumps inside the selected implementation to satisfy the file-list instruction,
the accepted commit no longer demonstrates the equal-version condition that
motivates the issue.

**Smallest correction:** Keep the manifest version unchanged in the automated
implementation. Immediately before merge, refresh the PR base and choose any
strictly greater dotted version in a separate, explicitly late ship commit;
do not name `0.0.19` in the plan as an invariant. Claude's statements that this
PR “will need” `0.0.19` should be softened for the same concurrency reason.

### 3. Two plans accidentally broaden their approved path sets beyond their stated file maps

**Plan claim:** Claude says no support helper will be created and that only
backticked paths are approved, yet its Exact file list to be created section
backticks `test/support/`. Cursor says `src/checkVersionBump.ts` is reused and
unchanged, yet backticks that path in its no-new-files section.

**Rule that must hold:** Evidence extracts approved paths from every backticked
path anywhere in the selected plan, and the exact file map must authorize only
the files or trees the implementation intends to change.

**Concrete failure:** Selecting Claude's plan authorizes every file below
`test/support/`, even though the plan says that tree is not being changed;
selecting Cursor's plan authorizes changes to `src/checkVersionBump.ts`, even
though the plan relies on that entry point remaining untouched. An
implementation can therefore alter those supposedly excluded paths and still
pass approved-path validation, defeating the file-map boundary.

**Smallest correction:** Remove code formatting from inspected-but-unchanged
paths. If a shared helper is actually desired, name one exact support file in
the changed list rather than approving the whole directory. Codex's enumerated
path set does not have this leakage and is the safer basis for consolidation.

## Conclusion

All three plans correctly identify the central implementation: delete the live
current-checkout ship assertion, retain the dedicated command and PR workflow,
make version assertions manifest-driven, remove the self-rewriting test runner,
and align user-facing documentation. Codex is the closest mechanically coherent
file map, and Claude supplies the strongest hermetic gate-test detail, but no
plan is acceptable verbatim because the mandatory tracked `AGENTS.md` edit has
no protocol-compliant staging mechanism. Resolve that blocker first, then use a
consolidated plan that keeps the automated implementation at the base version,
selects the eventual ship version only from the fresh merge base, and removes
the peer plans' accidental approved-path expansions.
