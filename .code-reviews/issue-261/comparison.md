# Issue 261 implementation comparison

Bound implementation pins:

- claude `217bc09ccd656ab932b5c5fdba76b48c292b2411`
- codex `4b1986e6a2a81ab956fb42371af2ce1af2ec8df4`

Both were read from the bound worktrees against the selected plan (codex `f1d01874ea5d2ccda3d0d07259113c9f9537c8ad`). Disclosure: I wrote the claude implementation. Findings below come from reading code at the pins; I ran no product suites for this comparison.

## Comparison

Both implementations deliver the same two halves of the issue:

- **Guided onboarding:** source-labeled discovery (scripts, existing ecosystems, CMake preset chains, Xcode shared schemes, SwiftPM), quote-aware command input, a timing choice mapped to `verify.precommit` / `checks`, saved settings taking precedence over detection, and the exact `Automated checks skipped: none configured.` message for an empty policy.
- **Reviewed check adoption:** an optional strict `checkProposal` on implementation/revision signals, a bound `check-proposal` input so reviewers see the proposal bytes, adoption limited to the authorized lineage, an amendment recorded in cursors, effective commands run at the final pin with an effective-policy digest bound into receipts and checked again before publication, and conditional `checkAdditions`/`adoptedChecks` records activated at a later issue's baseline by ancestry or matching blobs.

Neither adds a workflow phase, dependency, hook body or package-version change.

**Scope and reuse.**

- Codex is noticeably more compact: `src/projectChecks.ts` is 408 lines vs 734 and `src/checkAmendments.ts` is 86 lines vs 227. It reuses `proposeToolchainPolicy` in an exclusion loop to enumerate competing ecosystems instead of a parallel plan table, which is good reuse.
- Claude's extra size is in discovery breadth (top-level `check.sh`/`test.sh`, shebang/executable-bit handling, CMake build-only chains with hidden/condition handling) and in a more explicit activation status (`additionStatusAt` returns active/stale/pending with a witness).
- Both extend only existing test files and have near-identical test counts per file.
- Codex needed two plan amendments (`test/doctor.test.ts`, `test/hookSync.test.ts`) because install now writes empty local verification whenever `verify` was not supplied. Claude stayed within the original map: a partial declaration leaves `verify` undeclared unless one clear plan resolves it.

**Shared gap (not ranked as a finding).** The plan asks `src/doctor.ts` to inspect an active issue's frozen settings. Codex changes `inspectStartupAgent` (`src/doctor.ts:437-439`) to overlay `start.checks`/`start.verify`; claude leaves it unchanged. However, `checkClone` reads no verify/check fields. The command and undeclared-policy checks live in `checkDeclarations` (claude `src/doctor.ts:451`, codex equivalent), and in both pins that function still runs against the saved workspace config from `coord doctor`. So neither pin makes doctor report the in-flight issue's frozen commands, and codex's overlay currently has no observable effect.

## Findings

### 1. Codex: reinstall turns a legacy undeclared `verify` into an explicit opt-out

- **Location:** `src/projectChecks.ts:400-402` (codex), used by `src/install.ts:403-405`.
- **Rule:** the selected plan says "Missing `verify` in a manually authored old config still means undeclared, not an opt-out", and that keeping settings or reinstalling must preserve them. Detection or defaults must not overwrite a saved policy field.
- **Failure:**
  1. A workspace config was authored as `{ ..., "checks": [{ "name": "test", "argv": ["make", "test"] }] }` with no `verify`. Today its hooks refuse every agent commit until the owner declares a policy, and doctor reports `verifyUndeclared`.
  2. Running `coord install` again calls `resolveProjectChecks(productRoot, null, previous)`. `checks` comes from the saved config, so the function returns `verify: verify ?? { precommit: [], prepush: [] }`.
  3. `install` spreads that into `declared`, `buildWorkspaceConfig` takes `declared.verify`, and the rewritten config now contains `"verify": { "precommit": [], "prepush": [] }`.
  4. From then on, agent commits pass with no checks, and doctor no longer reports the missing declaration. The onboarding "keep" paths (`chooseProjectChecks`, lines 345 and 351) preserve `undefined` correctly; only the install path converts it.
- **Test sketch** (extend `test/install.test.ts`): install a plain product, delete `verify` from the saved config, run `installOnce` again without `--declare`, and expect `readConfig(configPath).verify` to be `undefined`.
- **Fix sketch:** return `verify` unchanged (possibly `undefined`) when `saved` supplies `checks`; default to empty lists only when nothing is saved and nothing is detected.

### 2. Codex: proposal validation accepts directory or symlink entry points that adoption later refuses

- **Location:** `src/evidence.ts:215` (codex) vs `src/checkAmendments.ts:32-45` (codex).
- **Rule:** a proposal accepted at submission and approved through review must be adoptable at finalization. The plan requires "tracked entry-point paths" with blob identities, so submission-time validation must apply the same ordinary-file rule that `recordCheckAddition` applies.
- **Failure:**
  1. `proposalErrors` only checks `mirror.readBlob(pin, path) !== null`. `BareMirror.readBlob` is `git show <sha>:<path>`, which exits 0 for a tree (it prints a listing) and returns the target text for a symlink.
  2. A signal with `"entryPointPaths": ["tests"]`, where `tests/` is a directory, is therefore satisfied at R4 and reviewed and approved as normal.
  3. At R7, `prepareCheckAmendment` calls `recordCheckAddition`. `entryBlob` matches only `100644|100755 blob`, so it throws "Check entry point must be an ordinary tracked file: tests".
  4. Every finalization attempt is then rejected with "Cannot adopt check proposal". The finalizer cannot correct it: only the selected lineage's signals are adopted, so the issue stalls at publication after reviewers already approved.
- **Contrast:** claude rejects a tree at submission (`src/evidence.ts:264`, covered by `test/evidence.test.ts:112`).
- **Test sketch** (extend `test/evidence.test.ts`): a proposal naming an existing directory at the pin is rejected, matching the finalization rule.
- **Fix sketch:** reuse `ls-tree`-based `entryBlob` (or the same mode check) in `proposalErrors`.

### 3. Codex, minor: entry points under a dot-directory are rejected

- **Location:** `src/evidence.ts:215` (codex).
- **Rule:** the plan accepts any safe, tracked, repository-relative entry point.
- **Failure:** `path.startsWith(".")` rejects `.ci/test.sh` or `.github/scripts/check.sh` even when tracked and safe. An agent adding a check script in such a directory gets a rejected signal and must move the script.
- **Fix sketch:** rely on `repositoryPathSchema` and the segment checks, and drop the leading-dot test.

### Assessment

- Both pins implement the full plan, without a separate approval phase, and with focused test coverage in existing suites.
- Codex is smaller and reuses the ecosystem detector more economically.
- Claude preserves undeclared policy, as the plan explicitly requires, and validates entry points with the same rule used at adoption. Those are the two correctness differences found, and both are user-visible failures in codex.
- On correctness I prefer claude `217bc09ccd656ab932b5c5fdba76b48c292b2411`. If codex `4b1986e6a2a81ab956fb42371af2ce1af2ec8df4` is selected, findings 1 and 2 are small, local fixes for revision.
