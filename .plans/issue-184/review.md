# Issue 184 plan review

Protocol version: 1. Reviewer: codex.
Action: 6624c181-f678-4244-97e2-7b40382ae185.

Reviewed the exported plans at these exact bound commits:

- Claude: c4056f3e7dfdf9f614dfa5ebb7b005faf0b291fd.
- Codex: 7b72a1c74d198d6aba1ebf32fb66e954f08f86a4.
- Cursor: bb5e9f701556f3bcb49f2a4897a52b26c210c4c3.

The exported bytes match all three SHA-256 values in the bound manifest. The
findings below refer to those plans, including my own, rather than to an
implementation that has not been submitted yet.

## Findings

1. **[P1] All three plans — the update/version environment does not identify the installation that will launch.**
   Claude's “Risks and Mitigations” explicitly accepts the coordinator's PATH
   even when the launcher uses a different Node installation; its timed runner
   also prepends the home-local-bin directory for every vendor. Cursor's
   “Reuse and Scope” says non-Antigravity agents inherit the caller environment
   unchanged. Codex's implementation steps 2–3 likewise use the normal owner
   environment and only reproduce Antigravity's PATH adjustment. **Rule:** the
   issue requires updating the agents that will actually run and recording
   their versions, so updater, version probe, and launch must resolve the same
   vendor installation under the launch environment. **Failure:** the generated
   launcher sources nvm and runs `nvm use` when the clone has an .nvmrc
   (`scripts/lib/launcher.sh:335–344`). With Codex installed globally under both
   the coordinator's Node version and the clone's pinned Node version, every
   proposed direct updater can update installation A and persist A's version,
   then launch unchanged installation B. Suppressing B's startup check makes
   the missed update persist. Logging A is not a mitigation; none of the plans
   compares that record with B. Claude's unconditional PATH prefix can introduce
   the same mismatch even without nvm when a home-local executable shadows the
   inherited executable for a non-Antigravity vendor.

   Resolve maintenance through the same environment setup as the generated
   launcher, including the prepared issue branch's Node pin, while keeping
   updates exclusively at fresh start. Cursor's pre-branch-preparation placement
   must account for the pin changing when the issue branch is prepared. Add one
   fixture with two distinguishable vendor binaries and a stub nvm setup; assert
   that update, version collection, and the rendered launch choose the same
   binary. This correction also applies to the Codex plan; it is not approved
   unchanged.

2. **[P1] Claude and Cursor — the proposed timeout is not sufficient to finish the updater before proceeding.**
   Claude's new-file specification chooses `execFile` with `timeout` and its
   risk section treats that as a hard upper bound; every timeout test uses a
   stubbed result. Cursor's “Bounded spawn” specifies TERM, KILL after one second,
   then resolution, and its real test contains only one process. **Rule:** a
   timed-out update must stop its work before version collection and agent
   launch; a bounded update cannot wait forever or leave an installer changing
   the executable after startup continues. **Failure:** default `execFile`
   timeout sends TERM without a KILL escalation, so an updater handling TERM can
   keep the callback pending indefinitely. For either plan, terminating only
   the immediate process leaves an installer descendant alive: resolving lets
   launch race that descendant, while waiting for inherited output pipes can
   exceed the timeout. Cursor's single-process test cannot detect that case.

   Two harmless local Node probes confirmed the distinction: a child handling
   TERM remained pending 453 ms into a 150 ms `execFile` timeout and completed
   only after the probe explicitly sent KILL; a parent killed at 150 ms left
   its descendant printing output, and callback completion took 736 ms. These
   are process-behavior probes, not tests of an implemented updater. Specify
   bounded process-group cleanup and wait for termination/closure before moving
   on, with a real child-plus-descendant regression and cleanup on test failure.
   The Codex plan already specifies this requirement and regression.

3. **[P2] Claude and Cursor — the focused test commands exclude tests they claim to run.**
   Claude's “Tests” names `pnpm vitest run test/agentUpdate.test.ts test/install.test.ts`;
   Cursor's names the same default invocation with the CLI and state suites
   added. **Rule:** named verification commands must actually select their
   stated regressions. **Failure:** `vitest.config.ts:7–17` explicitly excludes
   both the CLI and install suites. Selecting those filenames without the
   system configuration does not override the exclusion, so the proposed
   focused checks omit the executed-launcher assertion and, for Cursor, the
   start-versus-resume assertions. Hook-owned broader checks are separate and
   do not make the focused command accurate.

   Split the commands by configuration: run the new updater and state tests
   with the default/fast configuration, and CLI/install tests with
   `--config vitest.system.config.ts`. Preserve the declared prepush e2e and
   coordinator final-check responsibilities; Cursor's statement that no e2e is
   required cannot waive the workspace's configured checks. A `pnpm exec vitest
   list` attempt during this review did not reach Vitest: pnpm attempted automatic
   dependency repair and refused removal of the modules directory without a TTY.
   I did not alter dependencies or treat that attempt as successful verification;
   the exclusion finding is based on the actual checked-in configurations.

4. **[P2] Claude and Cursor — incidental backticked references expand the enforceable file map beyond the declared scope.**
   Both plans' file-list sections enumerate a narrow map and their prose excludes
   tmux and hook work, but other sections backtick additional filenames and
   dotted identifiers. **Rule:** the selected plan's extracted approved paths
   must match the exact intended change/create map; read-only references belong
   in “Reuse and Scope” or must not be formatted as file-map tokens elsewhere.
   **Failure:** the existing `extractApprovedPaths` excludes only that reuse
   section, and treats other eligible backticked tokens as approved paths.
   Running it against the bound plans gives Claude 14 paths rather than its six
   intended paths, including `src/tmux.ts`, `src/codexQuota.ts`, and `.nvmrc`;
   Cursor gets 22 rather than nine, including `githooks/post-merge`,
   `src/setupWorkspace.ts`, and `start-codex.sh`. The selected scope gate would
   therefore permit changes to files those plans say are out of scope. Dotted
   identifiers such as `expected.codex` and `process.env.VITEST` also become
   spurious file entries.

   Move read-only file references into the reuse section and remove code-token
   formatting from incidental dotted identifiers outside it, then assert that
   `extractApprovedPaths` returns exactly the declared existing/new files.
   The same check on the Codex plan returns exactly its nine declared files.

## Conclusion

Request corrections before implementing any plan unchanged. All three need the
launch-environment correction in finding 1. Claude and Cursor additionally need
the timeout/descendant guarantee, accurate focused commands, and an exact
extractable scope map in findings 2–4.

All three otherwise stay centered on the issue: fresh-run updates for the
selected roster, warning-and-continue behavior, version recording, Codex startup
suppression, and reuse of the existing pane/output retention. Claude's journal
approach and the optional start-state fields in the other plans are both viable
storage choices; an optional field need not force a runtime format change.
The proposed new updater/test pair in Claude and Cursor is explained and has a
bounded responsibility; Codex instead extends existing runner and test seams.
Neither organization is itself a correctness blocker. Existing launcher argv,
CLI startup, and state fixtures are appropriately reused, with no dependency or
product-hook changes needed. Claude's tests need real timeout coverage, while
Cursor's real-process case needs a descendant; the remaining behavior cases are
focused on the requested change.

Review validation consisted of bound digest checks, source/configuration
inspection, the existing scope extractor, and two targeted subprocess probes.
No product suite or coordinator-owned verification was run or claimed.
