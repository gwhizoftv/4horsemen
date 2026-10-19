# Issue 240 plan review

Protocol version: 1. Reviewed the four materialized plans bound to this action:

- Muse: `289ccb9f71ea759c72a8011fb9730e12c7b9df44`.
- Cursor: `b6795003b1eb3501e214dfb40041a278983b69c2`.
- Codex: `3926ba07d27b27512435ca07e4b0e87f6de18ff4`.
- Claude: `998ee7f73d1fbc36b3f5c5b956052ed0ef804249`.

Each citation refers to that pin's `.plans/issue-240/plan.md`. All four
materialized files matched the SHA-256 values in the bound manifest.

## Findings

1. **[P1] Codex and Muse — maintenance-only scope leaves the reported broken
   pane in place.** Codex's Reuse and Scope item 5 and Risks explicitly allow
   maintenance and launch to select different installations; Muse's Scope
   and Version snapshot divergence risk do the same. The issue's startup
   failure must be resolved without abandoning the existing contract that
   the updated, version-probed CLI is the one launched. With a healthy
   Claude beside Node 26 and the broken Claude shim beside product Node 16,
   both plans update and report the healthy copy, then their unchanged
   launcher executes the broken Node-16 copy and exits. The issue still
   pauses for an unavailable Claude terminal, now with an apparently healthy
   version snapshot. Changing documentation or the equality test does not
   repair that failure. This finding applies to my own Codex plan as well.
   Resolve the intended vendor executable consistently across maintenance
   and launch while preserving the product environment for product commands.

2. **[P1] Cursor — the proposed launcher PATH change also changes product
   commands.** The first file-map entry prepends coordination's Node after
   product nvm setup in the shared `launcher_environment`, but Reuse and
   Scope excludes changing product check Node selection. The product's
   selected Node must remain available to commands run by the agent; a
   vendor-resolution fix must not silently replace that development runtime.
   A generated launcher exports the modified PATH, performs its Corepack
   setup, and execs the harness without restoring PATH. Thus an agent in a
   Node-16 product that runs `node`, `npm`, or a Node-based product check
   receives Node 26. The existing `nvm use` call cannot protect it because
   the proposed prepend occurs afterward. The claim that only vendor CLI
   resolution changes is false. Resolve the vendor separately from the
   product PATH and include an assertion for a launched harness's child
   `node --version`, not just its own executable label.

3. **[P1] Claude — updater subprocesses still inherit the product Node.**
   Design item 1 resolves an absolute vendor command and optionally adds a
   Node interpreter for a Node shebang, then unconditionally runs the old
   nvm block; Design item 4 uses that same environment for maintenance.
   Agent updating must use coordination's runtime, including ordinary Node
   subprocesses launched by the updater. A shell vendor wrapper beside
   Node 26 containing `exec node updater.js "$@"` is executed directly
   after nvm has put Node 16 first, so the updater still runs under Node 16.
   A Node-shebang CLI explicitly started with Node 26 has the same problem
   if it spawns `node` or `npm` by name. The proposed shebang stub only
   demonstrates the top-level interpreter and misses both cases. Preserve
   product PATH for interactive launch, but give the maintenance child a
   supported Node PATH as well as the consistently resolved vendor command;
   add one wrapper/child-runtime assertion to the existing fixture.

4. **[P1] Muse — retaining the real-bash fixture unchanged can run a host
   updater.** The file map and Tests require the existing test at
   `test/cli.test.ts:348` to remain unchanged while production prepends
   `dirname(process.execPath)`. Process tests must remain confined to fake
   vendor executables. That fixture currently restricts PATH to its fake
   owner/pinned/home directories and system shell utilities, then delegates
   maintenance to real `runArgv` at line 371. On a normal nvm installation
   containing both Node and Codex in the same bin directory, the proposed
   prepend puts the real Codex ahead of every fixture command. Running the
   unchanged test then invokes the installed `codex update` and its version
   probe, rather than merely failing the expected log assertion. The new
   test's fake COORD_NODE does not isolate the older unchanged case. Adapt
   every real-maintenance fixture to use a fixture runtime, with a separate
   boundary assertion for the production runtime argument/environment.

5. **[P2] Codex — skipping product nvm setup also removes discovery of a
   previously available CLI.** Reuse and Scope items 1–3 skip nvm entirely
   and search only the coordination bin plus the inherited PATH. Maintenance
   must continue finding an installed vendor when only its interpreter
   needs changing. For example, the caller uses Node 16, the clone pins
   Node 20 with its only installed Codex, and coord runs on Node 26 with no
   Codex in its bin. Today the helper finds the clone's Node-20 Codex; the
   proposed maintenance path sees neither that directory nor that executable
   and returns command-not-found for update and version. The unchanged
   launcher still finds and starts it. Separate vendor discovery from the
   Node used for maintenance and cover the existing fallback instead of
   testing only a vendor installed beside coordination's Node.

6. **[P2] Muse, Cursor, and Claude — their focused commands select the wrong
   Vitest configuration.** Each Tests section directs execution of
   `test/cli.test.ts` through the default/explicit `vitest.config.ts`;
   Claude also does so for `test/install.test.ts`. Required verification
   commands must actually include the intended tests. The checked-in fast
   configuration explicitly excludes both files, so these commands discover
   no target tests and cannot validate the regression. Use
   `pnpm exec vitest run --config vitest.system.config.ts test/cli.test.ts -t 'fresh-start agent maintenance'`
   and, where needed, the same system configuration for the install suite.
   Codex's proposed commands already select that configuration correctly.

7. **[P2] Muse, Cursor, and Claude — incidental backticked references expand
   their effective approved file maps.** Their Exact File List sections
   claim narrowly bounded edits, but other sections contain backticked
   read-only paths and dotted identifiers. The approved map must match the
   intended file list. The repository's `extractApprovedPaths` scans
   backticked tokens outside Reuse and Scope, and its actual output includes
   extra entries: Muse includes `.nvmrc`, `package.json`,
   `scripts/lib/node-runtime.sh`, and `start-claude.sh`; Cursor includes
   `.nvmrc`, `package.json`, and `scripts/lib/node-runtime.sh`; Claude
   includes `.nvmrc`, `scripts/lib/node-runtime.sh`, `githooks/lib/policy.sh`,
   `githooks/post-merge`, and `src/setupWorkspace.ts`. It also interprets
   dotted identifiers such as `process.execPath` as file paths. Selecting
   these plans would therefore authorize files their stated scopes exclude,
   including hook files in Claude's case. Move read-only path references
   into Reuse and Scope, use plain text for incidental dotted identifiers,
   and validate extractor output against the intended exact list. Codex's
   output matches its five declared paths.

Scope/reuse assessment: all four proposals extend existing CLI and launcher
code and existing test fixtures, avoid dependencies and new product files,
and preserve the existing update ordering and warning machinery. Those are
appropriate constraints. Muse's maintenance helper is small and justified;
Codex's helper argument is small and justified; Claude's command array is
justified by separating executable selection from the product environment.
Cursor's claimed isolation is not achieved by its proposed exported PATH.
The test additions are reasonably focused once the configuration and fixture
isolation issues above are corrected. Claude's expanded launcher behavior
is relevant to the reported pane failure, rather than unrelated cleanup.

Verification performed for this review: read the exact bound plans, checked
their manifest hashes, inspected the current helper/call site, existing
real-bash fixture, Vitest configurations, and documented runtime contract,
and ran the existing file-map extractor against all four plans. No product
suite was run; these are plan findings, not implementation test results.

## Conclusion

Revise all four plans before implementation. Claude's plan is the strongest
starting point because it preserves the product PATH while resolving the
same vendor for maintenance and launch, but its maintenance child runtime
must be corrected and its test commands/file map repaired. Cursor must fix
the product-environment leak. Muse and Codex must address the still-broken
launch path rather than redefine the version snapshot around it; Muse also
needs fixture isolation, and Codex needs vendor-discovery fallback coverage.
