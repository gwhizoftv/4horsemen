# Issue 210 plan review — Claude

Plans reviewed at baseline `cb7ed092cb8a5d15f651387651df7c631e4596e6`. Each was
read from its bound input file:

- cursor `8cd4eddcec9193b82dbe8d5b417f827ed4ce1766`
- claude `887e8e7d863211f266068c837674cb7a72f3dfe2` (my own; reviewed with the
  same rules)
- codex `c284ace4ff9f7a5a5abb7269a220d173e8eacad5`

Evidence gathered for this review:

- Line anchors read directly from the baseline tree.
- `test/verify-config.test.ts`, `test/agentLanguage.test.ts`,
  `src/agentLanguage.ts`, `src/evidence.ts` and `src/setupWorkspace.ts`, read to
  check validation claims.
- Read-only `muse --version` / `muse --help` output (Muse Code 1.4.7) from my
  planning action.
- One fetch of Meta's published hooks reference,
  `https://meta-models.github.io/muse-code-sdk/1.4/guides/extend/hooks/`.

I ran no product suite; this is a coordination-evidence artifact.

All three plans agree on scope: one new analysis document under `docs/`, no
runtime, schema, launcher or test changes, and Muse integration deferred to a
follow-up issue. That matches the issue, which asks to "assess" and
"document". None of them adds a dependency or speculative abstraction, and
each justifies its single new file by the `docs/issue-209-*` precedent. The
findings below concern the accuracy and completeness of what each deliverable
will say.

## Findings

### F1 — all three plans (shared constraint). Severity: medium (claude, cursor); low (codex).

**Plan claim.**
- claude, Tests §3: every verified Muse statement cites the exact local
  command whose output supports it.
- cursor, Risks: rows are marked "needs a live `muse --help` / first-run
  probe".
- codex, Report §4: "locally observed behavior … read-only help/version
  output may supplement the sources".

**Rule.** Every `docs/*.md` must not match `/\/Volumes\/|\/Users\/[A-Za-z]/`.
`test/verify-config.test.ts:367-385` ("ships release-preparation docs without
machine-specific paths …") reads every `docs/*.md` and `README.md` and asserts
this.

**Failure.** A report that records where the observation came from will
naturally contain an absolute path, for example the resolved Muse launcher
(`/Users/<owner>/.local/bin/muse`) or a clone path under `/Volumes/…`. That
fails `test:fast`. All three plans state that the new path is outside the
frozen documentation allowlist, so the pre-commit hook runs `pnpm check:fast`.
The implementation commit is therefore refused, or it reaches the coordinator's
final `pnpm run check` red.

**Plan-specific.** Codex's plan already runs `pnpm check:docs`, whose
"shipped examples" filter includes this exact test. Codex calls that only a
regression check, but it does catch this failure. The claude and cursor plans
name no check that would catch it before the hook does.

**Smallest correction.** State the rule in each plan's Tests section: write
home paths as `~/…` and never paste a resolved `/Users/` or `/Volumes/` path.
Run `pnpm check:docs` (or the single test) on the draft.

### F2 — claude plan, "Muse facts" and Tests §3. Severity: high (own plan).

**Plan claim.**
- Muse "verified" facts come only from local `--help`/`--version` output.
- Whether Muse runs hook commands, and in what JSON shape, is listed as
  *open*.
- Without hooks, Muse can run only with `delivery: "pull"`.

**Rule.** The issue asks for an analysis of adding Muse. When a versioned
primary vendor source documents a contract, the analysis must use it, labelled
as *documented* rather than *locally verified*, instead of reporting the
question as unknown.

**Failure.** Meta publishes a hooks reference. The fetched page reports:
- 17 events, including `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
  `Stop`, `StopFailure` and `SessionEnd`;
- a project file at `.muse/hooks.json`, honoured only in a trusted folder;
- a `PreToolUse` deny envelope,
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",…}}`,
  plus exit-2 blocking;
- a shell tool matched as `Bash` or `shell`.

Following my plan as written, the deliverable would tell the owner that Muse
hook support is unknown and steer them toward pull-only delivery. It would
then omit the concrete changes that hook support implies:
- `src/agentHookSync.ts:16-30` hook path, `:106-117` event table and the
  `plannedDocument` branch;
- `src/shellGuard.ts:30-45` request and response envelope;
- `src/productIgnore.ts:40-46` / `templates/product/gitignore.coordination.block:4-9`,
  which need `.muse/`.

The recommendation's file-and-line list would be wrong in exactly the seams
that carry the most risk.

**Smallest correction.** Add a *documented* evidence tier: a primary URL, the
version the page states and the access date. Move hooks from *open* to
*documented, unverified live*. Add the seams above to the Muse change map.

### F3 — codex plan, Report §4 provenance. Severity: low.

**Plan claim.** "The versioned site identifies Muse Code 1.4 and its
generating commit; record that provenance in the report."

**Rule.** Provenance recorded for a vendor contract must be the version the
cited page itself states. It must be compared with the installed CLI version,
which is Muse Code 1.4.7 (1.4.7-R6101.1) per `muse --version`.

**Failure.** The hooks page under the `/1.4/` URL reports that it covers Muse
Code 1.3.0. If the report records "1.4" for the hook contract because of the
URL segment, a reader would treat the payload shapes as matching the installed
1.4.7 when the page says otherwise. A future integration would then copy an
unverified contract into `agentHookSync.ts` and `shellGuard.ts`.

**Smallest correction.** Record the per-page stated version next to the
installed version, and flag any mismatch as *verify live before use*.

### F4 — codex plan, Reuse table, Identity row. Severity: low.

**Plan claim.** "`src/protocol.ts:10` (`agentIdSchema`)".

**Rule.** Every baseline anchor must land on the named symbol. The plan's own
evidence audit requires this.

**Failure.** At baseline, `src/protocol.ts:10` is `issueSchema`, and
`agentIdSchema` is at `src/protocol.ts:9`. Copied into the report, the
identity row would point readers at the wrong schema.

The other 34 anchors I sampled in this plan resolve correctly, for example
`src/cli.ts:142`, `src/agentHookSync.ts:293` and `src/tmux.ts:381`. The
`src/doctor.ts:354` anchor lands mid-call; the plan's "and following checks"
covers it.

**Smallest correction.** `src/protocol.ts:9`.

### F5 — cursor plan, Tests §3 (Muse layer checklist) and Reuse list. Severity: medium.

**Plan claim.** The Muse section maps these layers:
- launch flags
- harness process name
- nudge keys
- folder trust
- lifecycle hooks
- shell guard
- readiness/submit
- transcripts/usage
- install/onboard defaults

The Reuse list names the modules to inventory, and `src/cli.ts` is not among
them.

**Rule.** The issue asks for "all the places … that must be changed to add a
new agentCLI". The checklist must include every seam that dispatches on the
agent id.

**Failure.** The fresh-start maintenance step is missing. It is
`agentExecutables` / `updateAgentVersions` (`src/cli.ts:135-180`), and it runs
`<executable> update` and then `--version` for each agent. Muse has no
`update` subcommand, and `muse [OPTIONS] [PROMPT]` treats a bare word as a
prompt, so a naive entry makes `coord start` run `muse update`. That starts a
Muse session with the prompt "update" under a 180 s timeout instead of
updating.

Also absent:
- `AGENTS.md` instruction loading (`src/agentsProtocol.ts:182-215`, the
  Claude-only shim);
- ignored vendor directories (`src/productIgnore.ts:40-46`);
- the CLI's own vendor lists (`src/cli.ts:306-307`, `:1151`;
  `src/install.ts:873`).

An owner following the document would miss the one Muse difference that
misbehaves on the first `coord start`.

**Smallest correction.** Add "fresh-start update/version command",
"instruction-file loading" and "ignored vendor directories" to the layer
list, and add `src/cli.ts`, `src/install.ts`, `src/agentsProtocol.ts` and
`src/productIgnore.ts` to the inventory sources.

### F6 — cursor plan, Risks "Over-recommending a refactor". Severity: low.

**Plan claim.** Score "continue as-is" as the default "unless the Muse
analysis shows a fifth full harness is imminent and shares enough surface …".

**Rule.** The decision criterion must be one the inventory can actually
discriminate on.

**Failure.** The issue's first sentence already states the premise: "We want
to be able to add more model/CLI options to coord." The "imminent" half is
therefore satisfied before analysis begins. The criterion collapses to an
unquantified "shares enough surface". The conclusion would then rest on
judgement, not on the inventory the plan otherwise builds.

**Smallest correction.** Decide on a countable quantity: the per-vendor
touch-points to add one CLI today, compared with the one-time migration cost
plus per-vendor touch-points afterwards, both taken from the inventory.

### F7 — claude plan, Reuse and Scope (decision criterion). Severity: low (own plan).

**Plan claim.** "Recommend it only if it removes more duplicated sites than it
adds new lines."

**Rule.** As in F6, the criterion must compare like with like.

**Failure.** Sites and lines are different units. A registry that removes 12
duplicated vendor lists but adds 40 lines fails the test as written, even
though it shrinks the per-vendor checklist. The criterion can reject the
design it was meant to evaluate fairly, or be quietly reinterpreted.

**Smallest correction.** Use the same countable comparison as in F6.

### Scope, reuse, new files and tests (all plans)

- **Scope.** All three stay within the issue. None changes runtime code,
  schemas, hooks or tests, and future-integration file maps are explicitly
  non-binding.
- **Discoverability edits.** cursor's one-row edit to `docs/repo-map.md` and
  codex's one-row edit to `README.md` are both small and justified. Both files
  are on the documentation allowlist. The repo-map row respects that file's
  "no line numbers" rule (`docs/repo-map.md:7`). My plan adds no link. That is
  acceptable, but it leaves the report findable only by filename.
- **Tests.** All three correctly propose no new tests for a behaviour-neutral
  documentation change, and rely on hook classification rather than
  allowlist edits. Codex's `extractApprovedPaths` check (`src/evidence.ts:146`)
  exists as described. Cursor's claim that a later install proposal picks up
  tracked `docs/*.md` matches `proposeProjectPolicy`
  (`src/setupWorkspace.ts:287-305`).
- **New files.** Each plan creates exactly one new file and justifies it.

## Conclusion

All three plans are acceptable in scope and shape. None needs re-scoping, and
every finding is correctable within the planned deliverable.

**Best base: codex.** It is the most complete:
- a capability matrix that separates launch, lifecycle, containment,
  analytics and quota;
- primary, versioned Muse sources;
- a reproducible search method;
- the only validation step that would catch F1.

It needs F3 (per-page provenance) and F4 (one anchor).

**claude (my own plan).** It contributes two verified, concrete Muse hazards
the other plans do not name:
- `muse update` would start a session at fresh start (`src/cli.ts:135-180`);
- the launcher's "every vendor accepts `--add-dir`" invariant
  (`scripts/lib/launcher.sh:40-45`) does not hold for Muse.

These should carry into whichever plan is selected. However, F2 is a real
defect: my plan would have reported Muse hook support as unknown when Meta
documents it. Together with F1 and F7, it should not be selected unchanged.

**cursor.** Its plan is the thinnest. F5 omits the seam most likely to
misbehave first, and F1 and F6 also apply.

Recommendation: proceed with the codex plan. Apply F3 and F4, and add the two
Muse hazards from the claude plan to its Muse change map.
