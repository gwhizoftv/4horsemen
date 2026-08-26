# Issue 121 — implementation comparison

Bound implementation pins:

- cursor `a56990ab9da86c59d8f96b6610eed00ad39ad841`
- claude `225c476b732e40ca8c0681afdc2d091fb8b1e956`
- codex `a82456a50a7e586752c7e36cc57c55ae44c1eea9`

All three implement the same selected plan and touch the same eight product
paths. The interesting differences are concentrated in one function —
`stripSections` in `src/evidence.ts`, which decides whether a path cited under
Reuse and Scope can be rewritten by the implementation — and in what each one
proved with a test.

## Method

Each pin was built in its own detached worktree with `tsc -p tsconfig.json
--outDir`, and the three `extractApprovedPaths` exports were then called from a
single script, so every result below is that pin's own compiled code rather than
a hand-copied reimplementation. Running the full fast suite from a detached
worktree fails 85 tests in 6 files (install, vendor, onboard, doctor, cli,
hookSync) for **all three pins including a control run of claude's own** — that
is a property of the worktree harness, not of any implementation, so it is not
reported as a finding. The suites that are pure of that harness
(`evidence`, `orderScaffold`, `agentLanguage`, `action`, `machine`) pass on
every pin: 103 tests for cursor `a56990ab9da86c59d8f96b6610eed00ad39ad841` and
codex `a82456a50a7e586752c7e36cc57c55ae44c1eea9`, 104 for claude
`225c476b732e40ca8c0681afdc2d091fb8b1e956`.

## Comparison

### 1. cursor `a56990ab9da86c59d8f96b6610eed00ad39ad841` — `\z` is not an anchor in JavaScript, so the reuse section is often not stripped at all

**Where.** `src/evidence.ts:53`:

```ts
const pattern = new RegExp(`^#{1,6}\\s+(?:${alternation})\\s*$[\\s\\S]*?(?=^#{1,6}\\s+|\\z)`, "im");
```

**Rule.** JavaScript regular expressions have no `\z`. In a non-unicode pattern
it is an identity escape matching the literal character `z`, so the lookahead
reads "the next heading, or the letter z" — not "end of input". A stripper whose
whole job is to remove a section must remove it for every plan that satisfies
`checkPlan`, because the same function decides what an implementation is allowed
to rewrite.

**Concrete failure.** Two ordinary plan shapes defeat it, both produced by
calling this pin's own compiled `extractApprovedPaths`:

- Reuse and Scope written as the last section (heading order is not enforced
  anywhere): the lookahead never succeeds, the match fails, `raw.replace` is a
  no-op, and the section is scanned like any other. A plan whose file list names
  only `src/product.ts` and whose reuse section mentions `src/existing-helper.ts`
  yields `["src/existing-helper.ts", "src/product.ts"]`. Codex and claude both
  yield `["src/product.ts"]`.
- Any letter `z` in the reuse body — this repository depends on `zod`, so
  "reuses the zod schemas in …" is an expected sentence: the lazy match stops at
  that `z`, leaving the rest of the section in the scan. A reuse body citing
  `src/protocol.ts` and `src/hash.ts` after the word "zod" yields
  `["src/hash.ts", "src/product.ts", "src/protocol.ts"]` under this pin, against
  `["src/product.ts"]` under both others.

In both cases the implementation silently gains write permission over modules the
plan said it would only read, and nothing reports it: the outstanding list is
empty because the paths are, as far as verification can tell, approved. This is
the exact defect the section was introduced to prevent.

**Smallest test.** In `test/evidence.test.ts`, the existing reuse fixture places
the section mid-document with `## Tests` after it, which is the one shape the
regex handles — which is why the suite is green. Add a case with the reuse
section last:

```ts
expect(extractApprovedPaths("## Exact File Map\n- `src/a.ts`\n\n## Reuse and Scope\nBuilds on `src/b.ts`.\n"))
  .toEqual(["src/a.ts"]);
```

That fails on this pin and passes on the other two. The fix is one character
class: replace `\z` with `$(?![\s\S])`, or drop the regex for a line scan.

### 2. codex `a82456a50a7e586752c7e36cc57c55ae44c1eea9` — a depth-1 reuse heading swallows every section after it

**Where.** `src/evidence.ts:120-135`, specifically the depth rule at line 128:
`if (depth === undefined || depth > skippedDepth) continue;`.

**Rule.** Stripping must remove the reuse section and nothing else. `checkPlan`
accepts the heading at any level (`^#{1,6}\s+…`), so the stripper must behave the
same way for `#` as for `##`.

**Concrete failure.** A plan that writes `# Reuse and Scope` with a single hash
and places its file lists after it loses every path: the deeper `##` headings
that follow all satisfy `depth > skippedDepth` and are skipped to the end of the
document. Calling this pin's compiled `extractApprovedPaths` on such a plan
returns `[]`, where cursor and claude both return
`["src/product.ts", "test/product.test.ts"]`. The implementation is then rejected
for touching paths outside an empty approved list, and the outstanding item
points at the paths rather than at the heading level that erased them.

This fails closed rather than open, which makes it far less serious than
finding 1 — nothing is silently permitted — but it is a real refusal an agent
cannot diagnose from the message it gets.

**Smallest test.**

```ts
expect(extractApprovedPaths("# Reuse and Scope\nReads `src/b.ts`.\n\n## Exact File Map\n- `src/a.ts`\n"))
  .toEqual(["src/a.ts"]);
```

The smallest correction is to end the skip at the next heading of any level, as
the other two pins do.

### 3. claude `225c476b732e40ca8c0681afdc2d091fb8b1e956` — acceptance is case-insensitive, stripping is not

**Where.** `src/evidence.ts:136`: `skipping = headings.includes(matched[1] ?? "")`,
an exact-case comparison, against `markdownSection` at `src/evidence.ts:43`,
which builds its heading regex with the `i` flag.

**Rule.** The set of sections `checkPlan` recognises as a reuse section and the
set `extractApprovedPaths` removes must be the same set. Where they differ, a
plan is accepted under one rule and extracted under the other.

**Concrete failure.** A plan whose heading reads `## Reuse and scope` — lowercase
`s`, an ordinary sentence-case slip — passes `checkPlan` because the regex is
case-insensitive, and is then scanned in full because the strip list is not.
This pin's compiled `extractApprovedPaths` returns
`["src/existing-helper.ts", "src/product.ts"]` for that plan; cursor (via its `i`
flag) and codex (via `toLowerCase`) both return `["src/product.ts"]`. The
consequence is finding 1's consequence in a narrower shape: a module the plan
only reads becomes writable, with nothing reported.

**Smallest test.**

```ts
expect(extractApprovedPaths("## Exact File Map\n- `src/a.ts`\n\n## Reuse and scope\nReads `src/b.ts`.\n"))
  .toEqual(["src/a.ts"]);
```

Fix: compare lowercased titles against a lowercased heading set, matching
`markdownSection`.

### 4. cursor `a56990ab9da86c59d8f96b6610eed00ad39ad841` — the scaffold tells agents something untrue about the path ceiling

**Where.** `src/orderScaffold.ts:105`: "Paths cited here do not widen what the
implementation may change — only the file lists do." The same sentence is
installed into every clone via `templates/product/AGENTS.protocol.md`.

**Rule.** Rendered instructions describe mechanism, and agents act on them
literally. A statement about what grants write permission must match what
`extractApprovedPaths` actually does.

**Concrete failure.** Extraction scans the whole plan minus the reuse section, so
Tests, Alternatives Rejected, Risks, and Conclusion all still contribute paths —
in every one of the three pins. An agent that believes only the file lists count
has no reason to notice that backticking `src/legacy.ts` under Alternatives
Rejected, as the option it is declining, has just granted write access to it.
Codex states the same rule correctly at `src/orderScaffold.ts:104-106` ("Paths
cited only here do not expand what the implementation may change; also list every
path intended for change in a file-list section above"), and claude's wording at
`src/orderScaffold.ts:111-115` is equivalent.

**Smallest correction.** Delete the clause after the em dash in both the scaffold
and the template.

### 5. codex `a82456a50a7e586752c7e36cc57c55ae44c1eea9` — the discipline heading captures three artifact contracts

**Where.** `templates/product/AGENTS.protocol.md:77`, `## Implementation
discipline`, inserted directly before line 86, `A **plan review** … must
include:`, and running until `## Checks that actually run` at line 132.

**Rule.** In a document agents navigate by heading, a section heading must span
only its own material.

**Concrete failure.** The plan-review contract, the code-review finding format,
and the comparison contract now all sit under "Implementation discipline". An
agent asked for a review that reads the section its heading points at gets
implementation advice; an agent looking for the discipline rules under that
heading also finds three unrelated contracts. Claude's placement at
`templates/product/AGENTS.protocol.md:124`, immediately before "Checks that
actually run" and after every artifact contract, has neither problem. Cursor
avoids it a third way, by folding the same rules into the existing plan-contract
paragraph with no new heading.

**Smallest correction.** Move the heading and its paragraph to just before
`## Checks that actually run`.

### 6. Coverage: what each pin proved, and what it left unproven

Same rule for all three: the behavior a change introduces needs a test that fails
without it.

- **codex `a82456a50a7e586752c7e36cc57c55ae44c1eea9`** proves the most. Its
  `test/integration.test.ts` additions assert the discipline text is present in
  the actual rendered instructions the canary hands to the planning,
  implementing, and revising agents — end-to-end wiring, not just the constant.
  Its `test/evidence.test.ts` monorepo fixture uses the `## Scope and Reuse`
  alias, so alias handling is exercised rather than assumed. What it does not
  have is the negative assertion its own plan promised ("assert that an unrelated
  scaffold does not receive the coding checklist"): nothing fails if the note is
  later appended to ballot or review instructions.
- **claude `225c476b732e40ca8c0681afdc2d091fb8b1e956`** is the only pin that
  ships that negative assertion (`test/orderScaffold.test.ts`, iterating
  `STEP_DEFINITIONS` and requiring the note on exactly three of ten). It is also
  the largest diff of the three — 165 insertions against codex's 118 and cursor's
  85 — with much of the excess in explanatory comments rather than code.
- **cursor `a56990ab9da86c59d8f96b6610eed00ad39ad841`** is the smallest and the
  least covered: `test/orderScaffold.test.ts` gains a single `toContain` line, no
  negative assertion, no integration assertion, and — as finding 1 shows — its
  one reuse fixture sits in the only document shape its stripper handles.

All three updated the three satisfying plan fixtures in `test/evidence.test.ts`
and the integration canary's plan, and all three added a rejection case for the
missing section. No pin left a fixture red.

## Verdict

**codex `a82456a50a7e586752c7e36cc57c55ae44c1eea9`.** It is the only pin whose
stripper survives every ordinary plan shape tested, its scaffold and template
prose describe the mechanism accurately, and it is the only one that proves the
discipline text reaches a real rendered instruction rather than only a constant.
Its two defects are contained: finding 2 fails closed and needs one comparison
changed, and finding 5 is a heading move.

**claude `225c476b732e40ca8c0681afdc2d091fb8b1e956`** is a close second and
carries the one piece of coverage codex lacks; its case-sensitivity gap
(finding 3) is a two-line fix but is a fail-open gap of the same kind as
cursor's, and its diff is the largest for the same delivered behavior.

**cursor `a56990ab9da86c59d8f96b6610eed00ad39ad841`** should not be selected as
it stands. Finding 1 means the central guarantee of this issue's change — that
naming code you reuse does not grant permission to rewrite it — is absent in two
plan shapes that require no unusual authoring, and its own suite cannot see it.

If codex is selected, the smallest revision is: end the skip at the next heading
of any level (finding 2), move the `## Implementation discipline` heading below
the artifact contracts (finding 5), and add the negative placement assertion from
claude's `test/orderScaffold.test.ts` that its own plan called for.
