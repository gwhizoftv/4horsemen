# Issue 210 plan review

Reviewed bound plans: cursor `8cd4eddcec9193b82dbe8d5b417f827ed4ce1766`,
claude `887e8e7d863211f266068c837674cb7a72f3dfe2`, codex
`c284ace4ff9f7a5a5abb7269a220d173e8eacad5`.

## Findings

1. **Cursor plan, Tests §3 / Muse mapping.** The plan says the Muse section may
   cite public Muse Code docs for launch flags, grants, and related layers.
   The rule that must hold: every Muse claim that would drive a future
   launcher or `agentExecutables` edit must be labelled verified-from-local
   help/version (or explicitly open), because public prose omits argv hazards
   that break unattended coord. Failure if followed as written: an implementer
   can treat Muse like the existing four vendors, add `["muse","muse"]` to
   `agentExecutables` (`src/cli.ts:135-137`), and have fresh-start run
   `muse update`—which Claude's bound plan already shows locally starts a
   session with prompt "update" under the 180 s timeout—and can also assume
   `${coord_grant[@]}` / `--add-dir` works despite Muse lacking that flag
   (`scripts/lib/launcher.sh:40-45`). Smallest correction: adopt Claude/Codex
   verified-vs-open labelling and require local `muse --help` / `muse --version`
   (read-only) whenever the binary is present; call out update and writable-root
   grant as first-class Muse rows.

2. **Cursor plan, Reuse and Scope module list.** The plan inventories by naming
   known modules (launcher, trust, hooks, tmux, transcripts, …) without a
   reproducible search or completeness pass. The rule that must hold: the
   deliverable must account for every substantive vendor-tailoring site an
   implementer would hit when adding a CLI, including identity lists outside
   those modules. Failure if followed as written: sites Claude already anchors
   at the baseline—`src/cli.ts:135-180` (update/version),
   `src/productIgnore.ts:40-46`, `src/agentsProtocol.ts` Claude shim,
   `templates/product/gitignore.coordination.block`, doctor unsupported-vendor
   checks—can be omitted because they are not in Cursor's reuse bullet list,
   so the published checklist understates the real change surface. Smallest
   correction: require Claude/Codex-style baseline-pinned search method plus a
   completeness check that every non-test/docs hit is a row or a named false
   positive (`cursors` / `CursorsState`).

3. **Claude plan, Reuse and Scope recommendation.** The plan states the
   deliverable “will argue” for replacing duplicated vendor identity data with
   one `Vendor` union and `vendors` record, while behaviour stays in per-vendor
   modules. The rule that must hold: the architecture conclusion must follow
   the completed inventory and the stated cost criterion (sites removed versus
   lines added), and must be free to say “continue as is” when that criterion
   fails—as the issue text explicitly allows. Failure if followed as written:
   the implementer is committed to recommending the identity-table design
   before the cost count exists, so a honest continue-as-is outcome is
   structurally disfavoured even if the table adds more lines than it removes.
   Smallest correction: keep the cost criterion as the decision rule; write the
   recommendation section only after the inventory, and treat the identity table
   as a candidate with a status-quo alternative, not a pre-chosen argument.

4. **Codex plan, Tests (`pnpm check:docs`).** The plan runs `pnpm check:docs` as
   a regression check for shipped examples and agent-facing language. The rule
   that must hold: documentation validation for this issue must also prove
   baseline `path:line` citations and inventory completeness; `check:docs` does
   not read those citations. Failure if followed as written and `check:docs` is
   treated as sufficient factual proof: a report with wrong or drifted line
   anchors can still pass the script while misdirecting a later Muse
   implementation. Smallest correction: keep `check:docs` as optional prose
   hygiene, and treat the plan's own evidence audit (baseline range checks +
   re-run searches) as the required validation gate—same bar Claude states.

No findings on issue scope, new-file justification, or product-test restraint:
all three plans correctly keep this issue documentation-only, justify a single
`docs/issue-210-*.md` analysis file, and add no product tests. Cursor's
`docs/repo-map.md` row and Codex's `README.md` Documentation-table link are
both justified discoverability edits; Claude's create-only map is also valid
under issue 209's precedent. Filename differences (`…-extension.md` vs
`…-analysis.md`) are ballot conflicts, not rule breaks.

## Conclusion

Claude and Codex are mechanically stronger than Cursor: both pin the baseline,
demand searchable completeness, and force verified/open Muse labelling; Claude
already surfaces concrete Muse breakages (`update`, no `--add-dir`) that Cursor
would miss. Cursor's file map and continue-as-is default are fine, but its Muse
and inventory methods are incomplete as written. Claude should not pre-commit
the identity-table recommendation; Codex should not lean on `pnpm check:docs`
as inventory proof. Any selected plan should combine: docs-only deliverable +
baseline-pinned complete inventory + verified/open Muse map including update
and grant hazards + a cost-gated architecture choice that may still be
continue-as-is + optional one-line discoverability link.
