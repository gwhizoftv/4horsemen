# Issue 274 — Choose agents for an issue run

## Exact File List to be changed or deleted

- `src/cli.ts` — Accept the value-taking `--agents` option on numeric dispatch and explicit `start`, validate the selection, and pass the ordered agent records to fresh startup. Update the usage lines for both commands.
- `test/cli.test.ts` — Exercise selection through both public entry points, invalid lists and continuation of a saved issue.
- `docs/coord-driver.md` — Add `coord 42 --agents claude,codex,antigravity` in “Starting and running”. Explain the equivalent explicit start, the default roster, list order, the solo rule and how to repeat the command.

## Exact file list to be created

None. The CLI, its system test suite and the operator guide already cover issue startup.

## Reuse and Scope

1. Use `parseArgs`, the two `allowedFlags` lists and `resolveStart` for the existing command syntax, workspace lookup and profile resolution. Share one small CLI-local selection function between the two entry points. Given an explicit list and the configured agent records from `resolvedAgents`, split on commas, trim each token and look up each exact, case-sensitive ID. Return the complete resolved records in argument order. Reject an empty token (including an empty argument), a repeated ID after trimming, or an ID absent from the workspace config. Identify the offending ID or empty entry in the error. Validate before manual-session cleanup, GitHub access or issue creation. This also supports custom configured IDs.
2. In `startIssue`, retain all resolved agents for `resolveSafeCoordRoot`, `resolveSafeCompletesRoot` and stale workspace UI cleanup. Use the selected records for the issue roster. With the flag omitted, solo uses the first configured agent. Reviewed and consensus use all configured agents in config order. With the flag present, reviewed and consensus use the entire selection. A solo start accepts one named agent, including one other than the first configured agent. Reject a multi-agent solo request before side effects and explain how to select one agent or a multi-agent profile.
3. Reuse the existing `roster` consumers for launcher validation, account preflight, `prepareAgentIssueBranches`, check activation, `updateAgentVersions`, mailboxes, lifecycle initialization and `startEffects`. `initializeOperationalState` already freezes `agents` and `originalRoster`, and `initialCursors` derives `activeRoster` from that snapshot. Keep the selection in issue state. The installed agent configuration and the inputs to `automationDigestMaterial` continue to describe the whole workspace.
4. For numeric continuation, locate the existing runtime with `existingIssueRuntime` before any manual-session cleanup. Omission resumes as today. When a list is supplied, validate its IDs and compare its ordered IDs with `readStartState(paths).originalRoster` before entering `runIssue`. A match permits replaying the original command. A mismatch reports the saved roster and how to continue with `coord N`. Use the saved roster for this comparison even after a drop or a change to the configured default profile. Explicit `start` keeps its existing fresh-start requirement.

## Tests

- In `test/cli.test.ts`, use `setup`, `successfulStartGit`, `fakeLoop` and an injected `startEffects`. Table-drive a numeric consensus start with `cursor, claude` and an explicit solo start with `claude`. Assert the launch IDs, frozen agent records (including resolved roots), `originalRoster`, initial `activeRoster` and version keys all contain exactly the expected selection. Check order on the roster arrays and verify the fixture's config bytes remain intact. Existing fresh-start maintenance cases already cover both no-option defaults.
- In the same suite, table-drive unknown, repeated after trimming, empty argument, empty CSV field and multi-agent solo selections. Require exit code 2, a diagnostic specific to the error and no session cleanup, process runner calls, launch or issue runtime. These assertions distinguish selection errors from the baseline's generic unknown-option error.
- Extend the existing numeric continuation coverage with a run started with an explicit subset. The same ordered list resumes, a changed list or order fails before the loop, and a bare numeric invocation still resumes. Compare saved start bytes and check that fresh-start maintenance never runs during continuation.
- During implementation run `pnpm exec vitest run --config vitest.system.config.ts test/cli.test.ts`. The frozen product precommit and prepush checks are `pnpm run check:fast` and `pnpm run test:e2e`. The coordinator runs `pnpm run check` at the approved pin. Publishing this plan requires artifact validation only.

## Alternatives Rejected

Editing the installed config for one run would change future issue defaults and could leave them changed after a failed launch. Starting all agents and dropping some would already have prepared their clones and contacted their harnesses. The existing startup roster provides the required boundary before either effect.

## Risks and Mitigations

- Roster order affects which agent the workflow picks first. Resolve records in CLI order and verify the saved sequence with a request that reverses config order.
- Filtering the whole configuration would remove excluded clone roots from path containment checks and could leave a manual session partially cleaned up. Preserve the full configuration for workspace operations and pass the selection only to issue participation.
- Recomputing a roster on continuation could reintroduce a dropped agent. Compare any explicit request to the immutable original roster and let the existing run loop use its saved active roster.

## Conclusion

The owner can select configured agents for a single issue with either start command. Invalid selections fail before startup effects, and the durable issue snapshot preserves the chosen participants across restarts.
