# Plan review — issue 272

Bound plans reviewed:

- codex `f3c1cdcb1b4c7fe3349255dea5ceeac8aa8897b2`
- antigravity `8cbda15a6b23bb8dada9927ccd2ff935e860c924`
- claude `4cb22ad81efae1a6f6bee01c8682288ab6eeb728`

I checked the facts below against the baseline tree:

- Receipt key material is `v: z.literal(1)`, plus origin, inputs mode and identity, argv, policy, platform, arch, the `node` version string, probes, declared env digests and dependencies. It records nothing about PATH or which Node binary a child actually resolved.
- Baseline input identity in `tree-excluding-evidence` mode is the main tree. That is usually the tree the previous issue's finalization already verified and receipted.
- The launcher's product Node selection is .nvmrc through `nvm use`, and it is fatal when that fails.
- scripts/lib/node-runtime.sh promises to leave the product's Node selection unchanged.

## Findings

### F1. claude plan: receipt keys after the PATH fix (blocking, small correction)

- **Plan claim.** File List item 2 for the verification runner uses the effective `node` for the receipt key. Risks says "Earlier receipts keyed on the coordinator's Node simply miss".
- **Rule.** A receipt may certify only an execution that matches the key's runtime claim. A receipt written before this fix ran its children under the inherited PATH Node, whatever its `node` field says.
- **Failure.** In this very repository, the coordinator Node chosen by node-runtime.sh and the .nvmrc pin can both be v26.12.1. Every other key field is unchanged, so `receiptKey` produces the old key.
  - A pre-fix receipt, produced while pnpm's children actually ran Node 23, is a cache hit and is reported as `verification-reused`.
  - The very Node mismatch this issue fixes is then certified as green without rerunning.
  - Nothing in the plan's tests detects this.
- **Smallest correction.**
  - Bump the key material version: `v: 2`, both in `receiptKeyMaterialSchema` and in the material that `keyFor` builds. Alternatively, add an explicit runtime field such as the resolved node path or "inherited".
  - Add `src/verificationReceipts.ts` to the file list.
  - Add one assertion that a v1 receipt for otherwise identical material is a miss.

  Codex's plan already handles this case ("invalidate keys from before the PATH fix").

### F2. claude plan: owner evidence after a restart

- **Plan claim.** Evidence is shown through the machine's owner-action reason, logged by the run loop, and through the `owner-question` journal. `coord status` is not changed.
- **Rule.** Issue item 3 says "show the owner the evidence". An owner who reconnects after a coordinator restart must be able to see it.
- **Failure.** `renderIssueReport` only sets `needsAction` for a pending `ownerQuestion`. An owner who runs `coord status`, or opens the interactive menu ("Owner question: baseline-check-failure, round 1"), sees no command, excerpt or log paths. They have to tail coordinator output for the next tick's log line. The evidence is persisted but not shown on those surfaces.
- **Smallest correction.** Render `ownerQuestion.evidence` when present (command, both SHAs, excerpt, both log paths, and the answer command) in the issue report. That adds the issue-report module to the file list. Codex and antigravity both plan this.

### F3. codex plan: Node fallback for products without a pin

- **Plan claim.** Reuse and Scope, Toolchain: "For a Node project without an explicit pin, propagate the selected coordinator Node directory as the fallback for its checks."
- **Rule.** node-runtime.sh selects Node for coordination only, and "the product's Node selection can stay unchanged". A product with no pin keeps the Node its own environment provides.
- **Failure.** Take a Node product with no .nvmrc that relies on the owner's PATH Node 20 (for example, engines below 21, or native addons built for ABI 115).
  - Every candidate and final check now runs under coordination's Node 26 or later.
  - Native modules fail to load, or engine-strict installs refuse.
  - Agents are rejected for failures that their own hook runs, under Node 20, never show.
- **Smallest correction.** With no product pin, leave the inherited PATH untouched, which is the launcher's behaviour.

### F4. codex plan: hook scope and the new resolver file

- **Plan claim.** It changes the hook policy module so declared hook checks use the new resolver, and justifies the new `src/verificationEnvironment.ts` mainly by sharing it with hooks.
- **Rule.**
  - The issue's failure and acceptance test are about coordinator checks and finalization.
  - In automated mode, hooks already run inside a harness whose launcher has done `nvm use`.
  - A new file must be justified by in-scope reuse.
- **Failure.**
  - If the product pin is not installed, the plan's resolver "report[s] an unavailable requested version explicitly". That newly blocks owner-driven manual commits, from a shell where the owner's PATH Node previously ran the hooks fine. That is a regression outside the issue.
  - Without the hook consumer, the new file has a single caller, and its justification falls away.
- **Smallest correction.** Drop the hook policy change. Put the resolver in the verification runner.

### F5. codex plan: spawn ENOENT as comparable evidence

- **Plan claim.** "A true spawn ENOENT for the declared command with a valid worktree can identify the exact missing executable for comparison."
- **Rule.** The documented runner contract, in docs/coord-driver.md and the comment in the verification runner, is that "A coordinator launch error throws instead, and the submission is re-evaluated on a later tick".
- **Failure.** The existing run-loop test "selects the final profile … README.md" expects a finalization `spawn docs-check ENOENT` to reject the call twice and leave the cursors unchanged. Under the plan, that same launch error becomes a baseline comparison and an owner pause instead.
  - The contract changes without a docs update.
  - The plan leaves the existing test's fate unstated ("adapt existing assertions").
- **Smallest correction.** Keep launch errors on the throw path. The issue's "unavailable tool" case is a tool the check invokes, which exits non-zero with "command not found". It already reaches the comparison as ordinary output.

### F6. codex plan: pause and resume as the owner retry control (non-blocking)

- **Plan claim.** On a match, use `setPaused` and advise `coord resume`. Add a separate pending-retry cursor record.
- **Rule.** Reuse the existing owner decision surface when one fits. Owner questions already carry typed answers, validation, the interactive menu and journal events.
- **Failure.** A generic pause gives no answer choice such as abandon, and no `coord answer` evidence binding. It also needs a new cursor record and resume-time revalidation code, which the owner-question path already provides. This is more new state than the issue needs.
- **Smallest correction.** Model the match as an owner question with `retry` and `abandon` answers, as claude and antigravity do.

### F7. antigravity plan: reimplemented version resolution in a new toolchain module

- **Plan claim.** The new toolchain module parses .nvmrc, .node-version and package.json engines with its own `parseNodeVersionSpec` and `satisfiesNodeSpec`. It then scans COORD_NODE, PATH, NVM_DIR versions and the running executable for a match.
- **Rule.**
  - The product's Node must be selected the way the launcher selects it, with nvm interpreting .nvmrc. The two must not disagree.
  - No semver dependency is planned.
- **Failure.**
  - An .nvmrc of `lts/*` or `node` is an nvm alias that the parser cannot satisfy, and the plan's hook change throws `HookPolicyError` in that case. Every commit in such a product is then blocked, although the launcher's `nvm use` started the agent on the right Node.
  - An `engines.node` range such as `>=18` now chooses some installed Node for products that never pinned one. That has the same behaviour-change problem as F3.
- **Smallest correction.** Ask nvm (`nvm which` in the worktree) when .nvmrc exists. Otherwise inherit PATH. Drop the engines and .node-version parsing and the hook change.

### F8. antigravity plan: baseline receipt reuse (blocking)

- **Plan claim.** Risks: "receipt reuse still skips already-verified cached baseline commands".
- **Rule.** The baseline comparison must actually execute under the candidate's current environment. A receipt recorded before the shared tool disappeared says nothing about the baseline today.
- **Failure.** Suppose the failed command is cacheable. The frozen baseline is usually the previous issue's merged final tree, so its success receipt already exists.
  - The baseline is reported as `verification-reused`, which is a pass.
  - The candidate is routed to agent correction for a missing tool it cannot install.
  - This is exactly acceptance test 3 ("candidate and baseline require the same unavailable tool"), and it fails.
- **Smallest correction.** Strip `cache` from the baseline prefix, so the baseline never reads, joins or writes receipts. Codex and claude both do this.

### F9. antigravity plan: unresolvable toolchain treated as a failed check

- **Plan claim.** File List for the verification runner says it will "emit a clean failure result when a project-declared toolchain cannot be resolved". The Tests section says it "fails before modifying receipts".
- **Rule.** A coordinator environment fault is not a rejected agent submission. That is the existing launch-error contract.
- **Failure.** Say the owner's nvm lacks the pinned Node.
  - Every R4 or R6 candidate is rejected and reissued to the agent.
  - The agent cannot install Node, so it burns revision rounds against a fault only the owner can fix.
  - The baseline comparison that would reach the owner exists only in finalization.
- **Smallest correction.** Throw, with a remedy naming the pinned version, as the existing launch-failure path does.

### F10. antigravity plan: scope and focus

- **Plan claim.** It adds two new source files, changes the interactive and issue-report modules, and adds a `test/cli.test.ts` case and a `test/verify-config.test.ts` hook case.
- **Rule.** The plan should make the fewest focused tests and files that the issue requires, and justify every new file.
- **Failure.**
  - The CLI test re-exercises `applyOwnerAnswer` plus `runTick`, which the run-loop retry test already covers, so it adds a slow end-to-end path with no new coverage.
  - The hook test and the hook change are outside scope (see F7).
  - The diagnostics module's only justification is the size of `runLoop`. Its helpers fit in the verification runner, which owns the failed results.
- **Smallest correction.** Drop the CLI and hook tests and the hook change. Fold the diagnostics helpers into the verification runner. The interactive summary is optional.

### F11. antigravity plan: skipping verification on any pending owner question (non-blocking)

- **Plan claim.** `runTick` will "skip submission verification … while a non-terminal ownerQuestion is pending".
- **Rule.** Gate only the submission whose re-verification the question is holding.
- **Failure.** A ballot-escalation question pending at R6 would also freeze evaluation of unrelated completions. That widens an existing owner flow's behaviour without need.
- **Smallest correction.** Scope the skip to the new kind and to R7.

### Cross-plan scope assessment

All three plans keep the core behaviour on the shared runner, reuse `runVerification`, `runArgv`'s env option, `gateFixture` and the existing test files, and strip caching from (or never cache) the baseline prefix, except antigravity (F8). Claude adds no files. Codex adds one, justified mainly by an out-of-scope consumer. Antigravity adds two.

## Conclusion

- **claude** (`4cb22ad8`): acceptable with corrections.
  - F1 (bump the receipt key version, plus one test) is required before implementation.
  - F2 (render the evidence in the issue report) is recommended.
- **codex** (`f3c1cdcb`): workable, but F3 changes Node selection for unpinned products and F4 and F5 expand scope. Its F1-style receipt invalidation is correct and should be adopted.
- **antigravity** (`8cbda15a`): not acceptable as written. F8 defeats acceptance test 3, and F7 and F9 introduce regressions outside the issue.

I prefer the claude plan amended with F1, borrowing codex's receipt invalidation and the issue-report evidence rendering from codex and antigravity.
