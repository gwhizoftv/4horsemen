# Issue 88 — keep coordinator internals out of agent-facing prose (remaining work)

Baseline `76cfd1550c3e74c0b6281cd83be04da9049f5814` already carries the first
pass at this issue (`src/agentLanguage.ts`, the single banned-term list, plus
`agentFacingSubject`). Three surfaces are clean and covered: the rendered
`action.md` body, the typed injection text, and the protocol overlay installed
into a clone.

Two leaks survive at this baseline, and the reason they survive is structural:
`test/agentLanguage.test.ts` enumerates agent-facing prose by hand and scans
only `templates/product/AGENTS.md` and the rendered overlay block. Running the
shipped checker over the working tree at this baseline reports:

- `AGENTS.md:45` — "…execute that new action even without a typed nudge." →
  `delivery-vocabulary: nudge`
- `AGENTS.md:46` — "…how you recover when a nudge did not land." →
  `delivery-vocabulary: nudge`
- `AGENTS.md:126` — "…is what the coordinator `checks` gate." →
  `gate-vocabulary: gate`
- `src/hookPolicy.ts:67` — "…declare both phases empty…" →
  `phase-vocabulary: phases`

`AGENTS.md` is not incidental prose. `CLAUDE.md` pulls it in with `@AGENTS.md`,
so every agent working this repository reads those three sentences at the start
of every session — the same class of text the issue's first acceptance criterion
covers. The `src/hookPolicy.ts` string is thrown as a `HookPolicyError` from
`verifyCommands` and printed to the agent's own terminal by the pre-commit hook
whenever a clone's config declares no `verify`.

This plan fixes those four strings and closes the enumeration gap that let them
survive, so the same class of leak fails a test next time instead of shipping.

## Exact File List to be changed or deleted

Nothing is deleted.

### 1. `AGENTS.md` — remove delivery and gate vocabulary (tracked content only)

Two edits against the **tracked** blob (`git show HEAD:AGENTS.md`), not against
the working-tree copy. The working-tree copy has the installed protocol overlay
appended after `<!-- coordination protocol — coord install -->`; that overlay is
already clean and must not be committed into the tracked file.

Lines 44–46, replace:

```
If `actionId` in the front matter has changed, execute that new action even
without a typed nudge. Delivery still comes from the coordinator; this watch
is how you recover when a nudge did not land.
```

with:

```
If `actionId` in the front matter has changed, execute that new action
immediately; do not wait for another coordinator message. New work still comes
only from the coordinator's `action.md`; this re-read is how you recover when a
message to your terminal did not arrive.
```

Line 125–126, replace:

```
fast tests — no Vite build). Full `pnpm check` (build + check:fast + e2e) is
what the coordinator `checks` gate. Run `pnpm check:fast` before commits.
```

with:

```
fast tests — no Vite build). Full `pnpm check` (build + check:fast + e2e) is
what the coordinator runs on an approved commit. Run `pnpm check:fast` before
commits.
```

(The second replacement also repairs a sentence that has no main verb.)

Because coordination sets `skip-worktree` on `AGENTS.md`, `git add AGENTS.md`
cannot stage this and the protocol forbids clearing the bit to work around it.
Stage the new tracked content with index plumbing instead, which never reads the
working-tree copy:

```sh
git show HEAD:AGENTS.md > /tmp/agents-new.md
# apply the two replacements above to /tmp/agents-new.md
sha="$(git hash-object -w /tmp/agents-new.md)"
git update-index --cacheinfo "100644,$sha,AGENTS.md"
# ... commit together with the other files ...
git update-index --skip-worktree -- AGENTS.md
```

`--cacheinfo` clears the `skip-worktree` bit as a side effect, so the final
`--skip-worktree` line is required, not optional. Verify with
`git ls-files -v -- AGENTS.md` (must print `S AGENTS.md`) and
`git status --short` (must be empty).

### 2. `src/hookPolicy.ts` — one agent-visible diagnostic string

In the `HookPolicyError` thrown by `verifyCommands` (line 67), replace:

```
'  To opt out deliberately, declare both phases empty: "verify": { "precommit": [], "prepush": [] }'
```

with:

```
'  To opt out deliberately, declare both lists empty: "verify": { "precommit": [], "prepush": [] }'
```

The first sentence of that error ("The workspace config declares no `verify`…")
is unchanged, because `test/hookSync.test.ts:210` and
`test/verify-config.test.ts:81` both match on it.

Nothing else in `src/hookPolicy.ts` changes. The `runVerifyPhase` log lines
(`coord ${input.phase}: …`) interpolate the values `precommit` and `prepush`,
which carry no internal vocabulary, and the `VerifyPhase` type and the
`--phase` CLI flag stay as they are — they are operator and config surface.

### 3. `src/agentLanguage.ts` — name the prose surfaces in one exported list

Append a single exported constant plus its doc comment. No existing export
changes, and `AGENT_FACING_BANNED_TERMS` is not widened:

```ts
/**
 * Repository-relative prose an agent reads directly, as opposed to text this
 * process renders. Listed here rather than in the test so that adding a file an
 * agent reads is a one-line change next to the rule it must satisfy.
 *
 * `AGENTS.md` is scanned with any installed protocol overlay removed: the
 * overlay is rendered from `templates/product/AGENTS.protocol.md` and is
 * covered on its own, and a clone carrying an older installed copy must not
 * fail the test for the tracked file's content.
 */
export const AGENT_FACING_PROSE_FILES: readonly string[] = [
  "AGENTS.md",
  "CLAUDE.md",
  "templates/product/AGENTS.md",
  "templates/product/AGENTS.protocol.md"
];
```

`README.md` and everything under the docs directory are deliberately absent; see
Alternatives Rejected.

### 4. `test/agentLanguage.test.ts` — cover the two uncovered surface classes

Add `AGENT_FACING_PROSE_FILES` to the existing import from
`../src/agentLanguage.js`, add imports of `AGENTS_PROTOCOL_MARKERS` and
`removeManagedBlock` from `../src/productIgnore.js`, and of `verifyCommands`,
`runVerifyPhase`, and `HookPolicyError` from `../src/hookPolicy.js`. Then add
three cases inside the existing `describe("agent-facing language")` block:

- **"keeps internal vocabulary out of every agent-facing prose file"** — for each
  path in `AGENT_FACING_PROSE_FILES`, read `join(repoRoot, path)`, strip an
  installed overlay with
  `removeManagedBlock(text, path, AGENTS_PROTOCOL_MARKERS).content`, and assert
  `findAgentLanguageViolations(...)` is `[]`, with the path as the assertion
  label. This is the case that fails on the unmodified `AGENTS.md`.
- **"scans the instruction files an agent actually loads"** — assert the list
  contains `AGENTS.md` and `CLAUDE.md`, that every listed file exists and is
  non-empty, and that `CLAUDE.md` references `AGENTS.md`. Without this, the
  first case passes vacuously if the list is emptied.
- **"keeps internal vocabulary out of hook diagnostics an agent sees"** — build a
  minimal `CoordinatorConfig` with `verify` undefined, assert
  `verifyCommands(config, "precommit")` throws `HookPolicyError`, and assert
  `findAgentLanguageViolations(error.message)` is `[]`. Then, with
  `verify: { precommit: [{ name: "check", argv: ["node", "-e", ""] }], prepush: [] }`,
  call `runVerifyPhase` for both `"precommit"` and `"prepush"` with a stub
  `runner` returning `0` and a `log` that collects lines, and assert the
  collected output is free of violations.

The existing cases in that file are unchanged.

### 5. `docs/coord-driver.md` — record the widened boundary

In the "Agent-facing language boundary" section, the sentence "Three surfaces do
reach an agent and must stay free of that vocabulary: the rendered `action.md`
body, the typed injection text, and the protocol overlay installed into a
clone." becomes a list of five: those three, plus the prose files named by
`AGENT_FACING_PROSE_FILES` (`AGENTS.md` and `CLAUDE.md` included), plus the hook
diagnostics printed into an agent's terminal by `src/hookPolicy.ts`. Add one
sentence stating that `README.md`, the docs directory, analytics tables, and
CLI output remain deliberately out of scope, so a later reader does not "fix"
them.

## Exact file list to be created

None. Every change lands in a file that already exists: the banned-term list and
its new prose-file list share `src/agentLanguage.ts` so the rule and its surface
list cannot drift apart, and the new cases belong in `test/agentLanguage.test.ts`
next to the fixture (`fixture`, `renderEveryStep`, `repoRoot`) they reuse. A new
module or test file would split one invariant across two places and buy nothing.

No new `.plans/`, `.signals/`, or `.code-reviews/` files are created by the
implementation step beyond the artifact the coordinator names in its own action.

## Tests

Red before green. On the unmodified baseline, the new prose case must fail and
name `AGENTS.md`:

```sh
pnpm exec vitest run --config vitest.config.ts test/agentLanguage.test.ts
```

Expected before the `AGENTS.md` and `src/hookPolicy.ts` edits: two failures —
`delivery-vocabulary: nudge` / `gate-vocabulary: gate` reported for `AGENTS.md`,
and `phase-vocabulary: phases` reported for the hook diagnostic. If either case
passes before the edits, the case is not scanning what it claims to scan and
must be fixed before proceeding.

After the edits, the same command passes. Then the regression set that pins the
strings this change is adjacent to:

```sh
pnpm exec vitest run --config vitest.config.ts \
  test/agentLanguage.test.ts test/verify-config.test.ts test/hookSync.test.ts \
  test/action.test.ts test/protocol.test.ts
```

Then the declared pre-commit gate for this repository, in full:

```sh
pnpm check:fast
```

(`pnpm lint` + `pnpm typecheck` + `pnpm test:fast`.) `pnpm check` additionally
runs `pnpm build` and `pnpm test:e2e`; the coordinator runs that list, and it
must be run locally before pushing because the src and test trees are declared
`workflowCriticalPrefixes` in the workspace config and the pre-push hook will
run the declared commands.

Manual verification of the index-plumbing step, which no unit test can cover:

```sh
git show HEAD:AGENTS.md | grep -nEi '\bnudg[a-z]*\b|\bgates?\b'   # expect no output
git ls-files -v -- AGENTS.md                                      # expect: S AGENTS.md
git status --short                                                # expect: empty
git show --stat HEAD                                              # expect AGENTS.md listed once
```

The last check matters because the failure mode of getting this wrong is silent:
a commit that contains the working-tree copy would append the whole installed
protocol overlay to the tracked file, and `git status` would still look clean.

No test asserts the *absence* of internal ids from state, the journal, or
analytics; the existing `leaves internal identifiers untouched` case already
pins `R1.join`, `gate-1-join`, and `join-published` as unchanged, and this change
does not touch them.

## Alternatives Rejected

**Clear `skip-worktree`, edit `AGENTS.md` in the working tree, `git add`, then
re-set the bit.** Rejected on two counts. The protocol in force explicitly
forbids clearing that bit, and more concretely the working-tree copy carries the
installed protocol overlay: `git add AGENTS.md` after clearing the bit would
commit ~120 lines of generated overlay into the tracked file. The plumbing route
in change 1 never reads the working-tree copy, so that failure is not available.

**Scan every `*.md` in the repository instead of an explicit list.** Rejected.
`README.md` (`internal-round-label: R2`, `nudge`, `gate`) and
`docs/coord-driver.md` (`R1.join → R2.plan`, gate ids, evidence ids) would be
swept in. Those are the operator's view, which the issue's second acceptance
criterion requires to keep its internal names, so a glob would force the
banned-term list to be weakened to accommodate them — trading a precise rule for
a vague one.

**Sanitize the analytics tables, `coord --help`, and `coord doctor` output.**
Rejected for the same reason, and the current `docs/coord-driver.md` already says
so in as many words: they are the operator's and owner's view and are
deliberately out of scope.

**Make `findAgentLanguageViolations` a runtime guard that refuses to write a
dirty `action.md`.** Rejected. `outstanding` strings carry git output, branch
names, and agent-supplied ballot choices, so a false positive would abort a run
loop and strand an issue mid-flight. The existing module comment already records
this decision; a test-time invariant fails loudly in CI and costs nothing at
runtime.

**Rename `VerifyPhase`, the `--phase` CLI flag, or `verify.precommit`.**
Rejected. These are config and operator CLI surface, not agent-facing prose. The
only value ever printed into an agent terminal through them is `precommit` or
`prepush`, neither of which carries internal workflow vocabulary; renaming the
flag would break every installed hook and every workspace config for no gain.

**Widen `AGENT_FACING_BANNED_TERMS` (for example to catch `ungated`, `delivery`,
or `round`).** Rejected. Every term currently on the list corresponds to a
concrete leak this issue found. `delivery` and `round` appear in legitimate
agent-facing sentences ("round 1" is in the required path for `R6.*` artifacts),
so adding them would produce false positives that force the prose to get worse,
not better.

## Risks and Mitigations

**The index-plumbing commit is easy to get subtly wrong, and wrong looks clean.**
If `--cacheinfo` is skipped or the wrong blob is hashed, the commit silently
omits the `AGENTS.md` fix while every test still passes locally, because the
worktree copy the test reads was never the thing that changed.
*Mitigation:* the four manual commands in Tests, run against the commit, not the
working tree — in particular `git show HEAD:AGENTS.md | grep …`, which reads the
committed blob. The new prose test reads the working-tree file and would not
catch this on its own, which is exactly why the manual check is listed.

**`--cacheinfo` silently clears `skip-worktree`.** Verified: after
`git update-index --cacheinfo`, `git ls-files -v` reports `H`, not `S`, and the
overlay then shows as an uncommitted ` M AGENTS.md` that the protocol forbids
the agent from cleaning up.
*Mitigation:* the trailing `git update-index --skip-worktree -- AGENTS.md`, and
`git ls-files -v -- AGENTS.md` in the verification list. Leaving the clone in
that state would also make the next `coord install` sync report drift.

**A clone with a stale installed overlay fails the new prose test for reasons
unrelated to the commit.** An older `coord install` could have written an overlay
that still contains `nudge`.
*Mitigation:* strip the managed block with
`removeManagedBlock(text, path, AGENTS_PROTOCOL_MARKERS)` before scanning. The
current template is separately covered by the existing
`keeps internal vocabulary out of the installed agent guidance` case, so nothing
is lost by ignoring the installed copy.

**Rewording the `HookPolicyError` breaks a test that matches on it.**
*Mitigation:* two call sites match that error, `test/hookSync.test.ts:210` and
`test/verify-config.test.ts:81`, and both match on the substring
"declares no `verify`", which this change does not touch. Both files are in the
targeted vitest invocation in Tests so a mismatch fails immediately rather than
at `pnpm check:fast`.

**The `AGENTS.md` reword drifts from the equivalent sentence in
`templates/product/AGENTS.protocol.md`,** leaving two different descriptions of
the same re-read behaviour.
*Mitigation:* the replacement text is deliberately the wording the issue itself
proposes and the wording the overlay already uses — "execute the new
instructions immediately; do not wait for another coordinator message" — so the
two surfaces converge rather than diverge. No change to the template is needed
or made.

**Scope creep into the operator surfaces.** The banned-term checker reports hits
in `README.md`, `docs/coord-driver.md`, `src/analytics.ts`, and `src/cli.ts`, and
a later reader may take those as work to do.
*Mitigation:* change 5 adds one sentence to `docs/coord-driver.md` naming those
surfaces as deliberately out of scope, next to the existing paragraph that
already says the same thing about analytics.

**No version bump is planned.** `package.json` stays at its current value: the
`0.0.N` advance is checked only on the PR into `main`, not on commits to an
issue branch, so bumping here would create a conflict with the coordinator's own
finalization step.

## Conclusion

The first pass on issue 88 built the right mechanism and pointed it at three of
the five surfaces that reach an agent. This plan finishes the job: it removes
the four remaining strings the shipped checker still flags in agent-facing text
(`AGENTS.md:45`, `AGENTS.md:46`, `AGENTS.md:126`, `src/hookPolicy.ts:67`), and it
replaces the hand-written surface enumeration in the test with an exported list
in `src/agentLanguage.ts` that is asserted to contain the instruction files an
agent actually loads.

The change is small — four strings, one new exported constant, three test cases,
one documentation paragraph — and it is bounded: no internal identifier moves, no
banned term is added, and the operator's view of the workflow is left exactly as
it is, which is the issue's second acceptance criterion. The only genuinely
delicate step is committing a `skip-worktree` file, and it is specified as an
exact command sequence with a verification that reads the committed blob rather
than the working tree.
