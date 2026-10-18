# Issue 238 — Plan review

Reviewed bound plans: cursor `906c261150c48bfe2671010c4a2b1ef6425d9b4d`,
muse `9ab54576c173c0b47da66e2cbe02c5122a3fd6af`,
claude `9f7d9207003e367a3fcc7df2f7c4ee7c5d5d1b7e`,
codex `baccd4b9c16a97f2f3715377d7d7d9521e18cc90`,
antigravity `0cc8e654282591984cea541cf79a18106ade04f1`.

Cross-checked against `src/setupWorkspace.ts:278`, `src/install.ts`
(`logProjectPolicy` at 268–313), and the existing Flutter cases in
`test/verify-config.test.ts` / `test/onboard.test.ts`. No product suite was
run for this evidence-only review.

## Findings

1. **Codex — Exact File List / `src/install.ts` (per-command four-way flag
   matrix and last-occurrence positive overrides).** The issue requires the
   shared Flutter `analyze` argv to gain `--no-fatal-warnings` and that the
   install explanation “reflect whether warnings are fatal.” A plan must stay
   within that issue and avoid speculative flexibility. If followed as written,
   the implementer builds a mini argv policy parser (four nonfatal-flag
   combinations, explicit positive counterparts, last-occurrence precedence,
   and per-command association when local and final differ) inside
   `logProjectPolicy`, far beyond the current single-sentence Flutter note at
   lines 307–308. Smallest correction: keep one flag-aware branch on whether
   effective Flutter analyze argv includes `--no-fatal-warnings` (muse / cursor
   / claude), and do not invent positive-flag precedence.

2. **Codex — Tests (declared-policy display table).** Plans must propose the
   fewest focused tests that fail before and pass after the change, preferably
   by extending an existing case. If followed as written, `test/onboard.test.ts`
   gains a combinatorial table (both flags, info-only, warning-only, neither,
   mixed local/final, explicit-positive override) whose failure modes are
   mostly display edge cases the issue does not require, while the argv pins in
   `verify-config` / onboard already prove the generator change. Smallest
   correction: update the two existing argv expectations; optionally add one
   Flutter `--declare` infos-only summary assertion in the same onboard case
   (claude / antigravity) to cover the warnings-still-fatal sentence.

3. **Antigravity — Reuse and Scope / `src/install.ts` names
   `reportVerificationPolicy`.** Reuse claims must name symbols that exist so
   the implementer edits the right function. There is no
   `reportVerificationPolicy` in `src/install.ts`; the Flutter explanation
   lives in private `logProjectPolicy` (line 268). Following the plan as
   written sends the implementer hunting a missing export and can stall or
   mis-patch `install`. Smallest correction: cite `logProjectPolicy`.

4. **Claude — Exact File List attributes line 278 to
   `proposeProjectPolicy`.** The edit site must be the function that owns the
   literal. Line 278 is inside `proposeToolchainPolicy`; `proposeProjectPolicy`
   only wraps that helper. Following the claim as written does not change the
   line number, but it mislabels the reuse surface and invites edits under the
   wrong name in review or later amendments. Smallest correction: say
   `proposeToolchainPolicy` (as muse / cursor / antigravity do).

5. **Cursor — Tests omit the warnings-fatal install branch after making
   `install.ts` conditional.** When the plan introduces a flag-conditional
   explanation, both sides of that conditional must stay proven or the unused
   sentence can rot unnoticed. Cursor updates argv expectations and only
   retargets the default (warnings non-fatal) summary substring; it never
   requires a declared `["flutter", "analyze", "--no-fatal-infos"]` path.
   Following that plan as written, a later edit that always prints the relaxed
   sentence would still satisfy the onboard assertion. Smallest correction:
   add the Flutter-only `--declare` infos-only summary check described in
   claude / antigravity inside the existing onboard case.

6. **Antigravity — Exact File List / `src/install.ts` adds a
   `--no-fatal-warnings`-without-`--no-fatal-infos` explanation.** The issue’s
   prescribed default carries both flags; the documented stricter override is
   analyze without those flags. A plan must not expand display cases the issue
   does not name. If followed, implementers add and may test a third wording
   for a non-generated argv shape. Smallest correction: handle “both flags”
   vs “infos only” (and optionally treat any warnings-fatal leftover with the
   existing sentence); drop the warnings-only-without-infos branch unless a
   declaration fixture truly needs it.

## Conclusion

All five plans agree on the product file map (`setupWorkspace.ts`,
`install.ts`, `verify-config.test.ts`, `onboard.test.ts`,
`setup-workspace.md`), the shared `analyze` object as the single generator
edit, unchanged `flutter test`, and no new product files. Muse is the clearest
minimal plan; claude’s declared-strict onboard branch is the best test
addition for the new install conditional. Prefer muse’s generator/docs scope
plus claude’s (or antigravity’s) one infos-only summary assertion. Reject
codex’s per-command flag parser and combinatorial display table as out of
scope. Fix antigravity’s `reportVerificationPolicy` name and claude’s
`proposeProjectPolicy` mislabel before implementation selection treats those
reuse claims as authoritative.
