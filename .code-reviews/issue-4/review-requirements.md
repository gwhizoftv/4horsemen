# Revision requirements — Claude `issue-4/claude`

**Author:** Cursor  
**Target implementation:** `72db53ab67d2ac788ea682302e6492e98c531d88` (`origin/issue-4/claude`)  
**Recommendation:** keep Claude as the revision base; apply the blocking/required items below before treating issue #4 acceptance as met.

## Sources

- Cursor review of Claude: `.code-reviews/issue-4/review-claude.md`
- Cursor self-review / Codex review (negative checklist + ports):  
  `.code-reviews/issue-4/review-cursor.md`, `.code-reviews/issue-4/review-codex.md`
- Three-way compare (Claude / Codex / Cursor) on 2026-08-11
- Issue #4 acceptance criteria (two-mode footprint, install/uninstall/doctor, declared `verify`, language-agnostic hooks)

Claude and Codex branches did not publish issue-4 reviews; only Cursor’s `.code-reviews/issue-4/` set was available.

## Acceptance gate

| ID | Requirement | Class |
| --- | --- | --- |
| R1 | Wired agent clone with unset/cleared `consensus.agentId` must fail closed | **Blocking** |
| R2 | Missing top-level `verify` must stay undeclared; empty arrays only when explicit | **Blocking** |
| R3 | Non-executable `.git/hooks/*` must be diagnosed and repaired | **Blocking** |
| R4 | Empty `workflowCritical*` must not silence a non-empty `verify.prepush` | Required |
| R5 | Existing clean agent clones must sync (or explicitly refuse) on reinstall | Required |
| R6 | `--write-product --vendor` must not recreate the human-clone “loaded gun” | Required |
| R7 | Pre-push stdin spool must use exclusive tempfile creation | Required |
| R8 | Uninstall must match issue conservatism + opt-in delete flags with dirty/force | Required |
| R9 | Non-Node fixture: failing declared `verify.precommit` blocks agent commit | Required |
| R10 | Doctor distinct non-zero codes for the issue’s drift classes | Required |
| R11 | Reverse/replace tests that currently encode fail-open behavior | Required |

`pnpm check:fast` (and `pnpm check` before merge) must stay green on the revised tip.

---

## R1 — Fail closed when agent wiring remains but `agentId` is unset

**Defective code:** `githooks/lib/identity.sh` (unset → `CONSENSUS_AGENT_CLONE=false`); `githooks/pre-commit` / `pre-push` / `commit-msg` / `post-*` early `exit 0`; `test/hookSync.test.ts` asserting ungated commit.

**Rule:** Under revised Option C, hooks live only in agent clones. Hook presence + install wiring (`coord.installRoot` / `coord.cliEntry` / `coord.workspaceConfig`) means this is an agent clone. Missing `consensus.agentId` must block, not pass through.

**Failure:** `git config --local --unset consensus.agentId` on an installed shim clone skips branch ownership, commit prefix, and declared `verify`.

**Required change:** Treat “hooks/wiring present, identity missing” as fail-closed. Keep pass-through only if you can prove no coordination wiring exists (not merely empty `agentId`). Reverse the ungated test.

**Regression:**

```ts
it("blocks when agentId is unset but coord wiring remains", () => { ... });
```

---

## R2 — Do not record empty `verify` as an explicit opt-out

**Defective code:** `src/setupWorkspace.ts` `proposeProjectPolicy` Node path (~147–153) and Make path (~165–168); merge into emitted config via `buildWorkspaceConfig`.

**Rule:** Missing top-level `verify` fails closed. Only operator-authored `"verify": { "precommit": [], "prepush": [] }` may allow. “Found nothing to propose” stays undeclared.

**Failure:** `package.json` with only `"test"` (or Makefile with `test` but no `check`) installs `verify: { precommit: [], prepush: [] }`; hooks treat that as deliberate opt-out.

**Required change:** If proposed precommit/prepush are both empty, omit `verify` from the proposal/emitted config. Never coerce `undefined` → empty object at install time.

**Regression:** proposer unit test + install → agent commit blocked with undeclared-verify remediation.

---

## R3 — Detect and repair non-executable agent hooks

**Defective code:** `src/hookSync.ts` `writeCloneHooks` (skip `chmod` when bytes match); `inspectCloneHooks` (digest-only); doctor path that trusts `kind: "ok"`.

**Rule:** Coordination hooks that exist must be what git runs. Lost `+x` is fail-open and must be visible + repaired.

**Failure:** `chmod 0644 .git/hooks/pre-commit` → git skips the hook silently; reinstall no-ops; doctor reports healthy.

**Required change:** Always ensure execute bit on write; `inspectCloneHooks` returns a distinct non-ok kind (e.g. `not-executable`); doctor surfaces it; reinstall repairs.

**Regression:** chmod 0644 → doctor/inspect fails → reinstall restores `+x`.

---

## R4 — Empty critical-path lists vs declared `verify.prepush`

**Port from Codex:** `githooks/lib/verify.mjs` treats empty prefixes **and** empty files as “all paths critical.”

**Rule:** A non-empty `verify.prepush` must not become a no-op solely because `workflowCriticalPrefixes` / `workflowCriticalFiles` were omitted or empty. Prefer: empty both ⇒ always run prepush (Codex), or fail closed demanding an explicit critical-path policy.

**Required change:** Align Claude’s pre-push gating (`githooks/pre-push` + policy resolution) with that invariant. Add a regression where `verify.prepush = [{ argv: ["false"] }]` and critical lists are absent/empty → push blocked.

---

## R5 — Sync existing agent clones on install

**Port from Codex:** `src/setupWorkspace.ts` fetch/ff-only when clone exists, clean, and on shared branch.

**Rule:** Issue step “Create/sync” applies on reinstall, not only first clone.

**Required change:** On reinstall, fetch `origin/<baseBranch>` and fast-forward when safe; if dirty or diverged, refuse with remediation (unless an explicit force flag is designed and documented). Cover with an install regression.

---

## R6 — Keep `--write-product --vendor` from becoming a human loaded gun

**Port caution from Codex review:** copying identity-fail-closed bodies into product `githooks/` breaks humans who already use `core.hooksPath=githooks`.

**Rule:** Default and opt-in product writes must preserve §0: human clones without coordination identity must remain usable. Either refuse `--write-product --vendor` when it would activate hostile bodies, write inert shims only with explicit owner acknowledgment, or keep vendor bodies agent-clone-only.

**Required change:** Document and enforce the chosen policy in `src/hookSync.ts` / `src/install.ts` / `docs/setup-workspace.md`, with a human-clone commitability test.

---

## R7 — Exclusive pre-push stdin tempfile (if shim captures stdin)

**Port from Codex defect:** avoid `${TMPDIR}/coord-pre-push.$$.input`.

**Rule:** If Claude’s shim/wrapper spools pre-push stdin, use `mktemp` (exclusive create).

**Required change:** Audit `templates/hooks/shim.sh` and any pre-push wrapper; replace predictable paths.

---

## R8 — Uninstall completeness

Claude folds uninstall into install/CLI rather than a dedicated module (Codex has `src/uninstall.ts`). A separate file is optional; behavior is not.

**Rule (issue #4):** Conservative default clears agent hook wiring / exclude / launchers / installRoot config; removes managed product ignore only if install wrote it; deletes workspace config entry. Opt-in `--delete-clones` refuses dirty unless `--force`; `--wipe-runtime` / `--delete-coordination` only with recorded ownership.

**Required change:** Confirm each path with tests; close any gap vs the issue table. Extract `src/uninstall.ts` only if it clarifies ownership—do not churn for style.

---

## R9 — Non-Node verify acceptance test

**Rule:** Rust or Go fixture onboards; failing declared `verify.precommit` blocks **agent** commit; human clone unaffected.

**Required change:** Add fixture coverage (can live under `test/install.test.ts` or `test/verify-config.test.ts`) using argv like `["false"]` or a tiny failing script—no package.json sniffing.

---

## R10 — Doctor exit taxonomy

**Rule:** Distinct non-zero reporting for missing install root, bad hooks (including not-executable), stale vendor stamp, missing launcher, missing/malformed identity, missing argv[0] on PATH, config incompatible with `coord start`.

**Required change:** Extend `src/doctor.ts` + `test/doctor.test.ts` for R1/R3 codes; keep messages actionable.

---

## R11 — Test suite honesty

**Required change:**

- Reverse ungated-`agentId` assertion in `test/hookSync.test.ts`.
- Add proposer/install tests for R2.
- Add executable-bit tests for R3.
- Add prepush empty-critical test for R4.
- Keep `test/support/workspaceFixture.ts` as the shared harness; do not fork per-test git setups without cause.

---

## File map for revisions

### Modify (required)

| Path | Revision work |
| --- | --- |
| `githooks/lib/identity.sh` | R1: fail closed when wiring present and `agentId` unset/malformed |
| `githooks/pre-commit` | R1: stop treating unset identity as human pass-through when agent-wired |
| `githooks/pre-push` | R1 + R4: same identity rule; empty critical paths must not skip declared prepush |
| `githooks/commit-msg` | R1: same identity rule |
| `githooks/post-commit` | R1: same identity rule (reminder may no-op only after identity validated) |
| `githooks/post-merge` | R1: same identity rule |
| `githooks/lib/policy.sh` | R2/R4: ensure undeclared vs empty verify semantics stay honest at the CLI boundary |
| `src/setupWorkspace.ts` | R2, R5, R6: proposal omit empty verify; sync clones; safe write-product/vendor policy |
| `src/hookSync.ts` | R3, R6, R7: chmod always / not-executable drift; vendor placement; tempfile if applicable |
| `src/doctor.ts` | R3, R10: surface not-executable + identity/wiring inconsistencies |
| `src/install.ts` | R5–R8: wire sync/uninstall/doctor gates; no empty-verify coercion |
| `src/cli.ts` | Help/flags only if uninstall/sync/force semantics change |
| `templates/hooks/shim.sh` | R1/R7: fail closed if identity/install root wrong; exclusive tempfile if stdin spooled |
| `docs/setup-workspace.md` | Document two-mode, missing vs empty verify, vendor/write-product dangers, sync behavior |
| `test/hookSync.test.ts` | R1, R3, R11 |
| `test/install.test.ts` | R2, R5, R6, R8, R9 |
| `test/verify-config.test.ts` | R2, R4, R9 |
| `test/doctor.test.ts` | R3, R10 |
| `test/support/workspaceFixture.ts` | Shared helpers for the new regressions |

### Modify (optional / only if touched by above)

| Path | Notes |
| --- | --- |
| `src/hookPolicy.ts` | If verify proposal / schema helpers move with R2 |
| `src/state.ts` | Only if schema needs finer “verify present but empty” typing |
| `src/productIgnore.ts` | If uninstall/managed-ignore edge cases change |
| `src/runLoop.ts` | Only if journaling which tier blocked finalization (issue acceptance) is in scope |
| `config.product.example.json` | Show explicit empty verify vs omitted verify correctly |
| `README.md` | Point at revised two-mode / install docs |
| `scripts/setup_*.sh` / `scripts/setup_common.sh` | Keep deprecated façades accurate; no new product-vendored hook path |

### Keep as-is (unless revision forces a touch)

| Path | Role |
| --- | --- |
| `src/gitExec.ts` | Fine as shared git helper |
| `templates/product/AGENTS.md` | Opt-in product template |
| `templates/product/gitignore.coordination.block` | Opt-in managed ignore |
| Driver core (`action`, `mirror`, `machine`, `finalization`, …) | Orthogonal to issue #4 unless R7 journal tier is pulled in |

---

## Missing files

Relative to issue #4’s proposed file map and/or stronger peer implementations. **Not all must be added**—prefer behavior over file count.

| Missing path | Status on Claude tip | Requirement |
| --- | --- | --- |
| `src/uninstall.ts` | **Missing** (uninstall likely inlined in `install`/`cli`) | Optional extract; **behavior** of R8 is required either way |
| `githooks/lib/verify.mjs` | **Missing** (Claude uses `policy.sh` + CLI) | Optional; if not added, R4 must still hold in bash/CLI policy path |
| `templates/hooks/shim.sh` stdin `mktemp` pattern | Shim exists; confirm exclusive tempfile | R7 if stdin is spooled |
| Non-Node product fixture under `test/fixtures/` (or inline temp Go/Rust tree) | **Missing as a durable fixture** | R9 — inline `mkdtemp` is acceptable; a checked-in fixture is optional |
| `.code-reviews/issue-4/review-*.md` on Claude’s branch | **Missing on Claude remote** | Process only — publish/acknowledge peer reviews when revising |
| Issue #4 journal proof: tier-2 pass + tier-3 fail | Not evidenced in install work | Out of scope for install-only revision unless explicitly pulled in; track as residual acceptance item |

### Do not add

| Path | Why |
| --- | --- |
| Product-tracked `githooks/` by default | Violates zero product-master footprint / §0 |
| New `consensus-ai` naming in templates | Issue hygiene non-goal |
| Hook bodies that sniff `package.json` / lockfiles | Explicitly removed; do not regress |

---

## Out of scope for this revision (track separately)

- Full four-agent E2E of R1–R7 on a non-Node product (beyond install/hook verify).
- Auto-start of `coord run` from install.
- npm publish / package-manager distribution of coordination.
- Reworking issue #1 driver semantics unrelated to install/hooks.

## Done when

1. R1–R3 blocking items fixed and regressions green.  
2. R4–R11 required items fixed or explicitly waived in the revision notes with owner agreement.  
3. `pnpm check:fast` passes; default `coord install` still leaves product `git status` empty.  
4. Human fresh clone of the product (no coord) still has no coordination hooks and no Node obligation.
