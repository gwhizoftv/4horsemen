# Issue 255 — plan review

Protocol version: 1. Reviewed the exact bound plans and the current reader,
analytics attribution, existing fixtures/tests, and documented attribution
contract against the frozen issue requirements.

Bound plan pins:

- Muse: `365a094cff47adec222d55c12974f6c0b01175d3`.
- Claude: `8972b77767d9f982a048fe2d1b5c70bbd6df99d0`.
- Codex: `c3f3a2504e8c503f3ecb46c94caf761e107c1c45`.

Each pin supplies `.plans/issue-255/plan.md`; the coordinator-exported files
were read directly. No peer fetch or pinned Git read was needed.

## Findings

1. **[P1] Muse — Reuse and Scope, conservation step and scope limits
   (plan lines 184–195): leaving `unattributed` unchanged preserves the live
   token-coverage failure.** The plan explicitly leaves that loop unchanged
   and limits the fix to turn-keyed samples. The rule is that valid Codex
   token records in a shared vendor turn must receive exact attribution when
   their timestamps uniquely resolve to an action/phase; requiring an explicit
   transcript `turn_id` is not part of issue 255. At this baseline,
   `codexSamples` sends live `token_count` records without `turn_id` to
   `unattributed`. With the existing `sharedCodexJournal()` prompts at 02s and
   12s and a shared stop at 22s, the fixture token at 15s still matches both
   windows and takes the unchanged non-exact shared-turn fallback. Thus token
   coverage remains partial and the solo/cross-roster token total remains
   unavailable even after keyed tools are fixed. The proposed four-phase
   fixture assigns an explicit `turn_id` to every token record, so it does not
   expose this failure. Apply timestamp disambiguation to the unkeyed path as
   well, and include the live no-turn-ID token representation in that fixture
   or a parameterized variant.

2. **[P2] Muse — Reuse and Scope, effective-window step 1
   (plan lines 161–168): an infinite final window bypasses the proposed phase
   safeguard.** The rule is that a record outside the issue's known action
   and phase bounds cannot become exact merely because a stop event is
   missing. The stated formula sets the last sibling's effective end to
   `+Infinity` when `endedMs` is null, accepts a unique window immediately,
   and consults phases only if no unique window results. For shared prompts
   at 02s/12s/22s/32s, no recorded stop, and a terminal gate or report cutoff
   at 40s, a keyed record at 59s from the same continuing transcript matches
   the last sibling uniquely. Step 3 therefore marks it exact in R7.finalize
   despite its being outside every reported phase. The risk section's phase
   fallback mitigation is never reached. Bound an open window by a valid
   report/phase end, or make it ineligible for exact action-window attribution
   and require a bounded phase match. A single sample beyond the fixed cutoff
   should remain partial/unassigned, not increase an exact phase total.

3. **[P2] Claude — Exact File List, `sharedTurnOwner` rejection rule
   (plan lines 41–44): a tie elsewhere in the turn must not invalidate a
   uniquely timed sample.** The plan says the helper returns null when two
   siblings share `startedMs`. The rule is to judge timestamp ambiguity for
   the record being assigned, retaining exact attribution for records that
   have one possible action/phase owner. Consider one R1 action starting at
   02s, followed by two R2 action entries both starting at 12s, all with a
   shared stop at 22s. A keyed token/tool record at 08s has only the R1 action
   as a possible owner; neither later action has started. Rejecting the entire
   sibling group because of the later tie returns null for this record, and
   the specified latest-action fallback incorrectly puts it in R2 with partial
   coverage. This contradicts the per-sample requirement even though the
   record's own window is unambiguous. Restrict tie rejection to competing
   owners at that sample timestamp; add this earlier-sample/later-tie case to
   the existing shared-turn test support. Tied actions belonging to one phase
   also need not make the reported phase ambiguous.

Scope and reuse assessment:

- **Muse:** The plan identifies and reuses the existing parser, action-turn
  representation, resolver, coverage accounting, and test helpers. Its one
  new JSONL fixture has a stated purpose (four phases with both tokens and
  tools); no new dependency or source module is proposed. The Cursor edits
  are mechanical consequences of its required top-level `samples` field.
  Tests are focused, but their all-keyed input misses finding 1, and the
  proposed outside-window case does not cover finding 2's missing-stop path.
- **Claude:** The four-file map, inline fixture, optional per-turn samples,
  and common helper are compact and reuse existing support. The principal
  four-phase test correctly mixes live unkeyed token rows with keyed tools,
  and its extra outside-stop tool row checks independent metric coverage.
  Finding 3 needs a focused regression. The plan also retains samples for
  Claude and routes any sampled shared turn through the new helper; keeping
  the attribution change gated to Codex would better match the issue's scope.
  Its map omits `docs/analytics.md`, whose Exact attribution section currently
  promises the old always-partial shared-turn behavior; a selected revision
  should include that small documentation update in its approved file map.
- **Codex:** No blocking finding. The five-file map covers implementation,
  existing tests, and the changed documentation contract. It reuses the
  existing per-record type and fixture seeds, introduces no product file or
  dependency, and limits sample retention/resolution changes to Codex. The
  rules handle both keyed and unkeyed paths, bound open windows, inspect
  phase uniqueness, preserve parser uncertainty, and conserve usage by
  replacing aggregate assignment with sample assignment. The proposed
  parameterized boundary/uncertainty cases remain focused on this issue.

Verification for this review is artifact and evidence validation: action
identity/digest, exported-plan hashes against the bound manifest, all three
pin citations, required nonempty sections, and concrete counterexamples
checked against the stated algorithms and existing code. No product suite or
unimplemented candidate test is claimed as run.

## Conclusion

Recommend the Codex plan at
`c3f3a2504e8c503f3ecb46c94caf761e107c1c45` for implementation.

Request revision of Muse's plan for findings 1 and 2, and Claude's plan for
finding 3. The implementation should preserve per-sample exactness without
accepting unbounded timestamps or allowing an unrelated ambiguous action to
move a record whose own owner is known.
