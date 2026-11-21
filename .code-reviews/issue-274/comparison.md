## Comparison

I recommend the **Codex implementation** at `ff24cca4b8e2c496c0f7633004b264509b5d015d`. Both fresh-start commands enter the same function, which resolves agent roots once, validates the requested roster and only then checks for a manual session. The numeric continuation path compares the ordered selection with the saved original roster. Its regression test exercises a real agent drop and a subsequent change to the default profile.

**Claude** at `c8e84f7dec019326ec15a8bc78e1e06cbe9b5e92` supplies the most specific input diagnostics. An empty field reports its position, and an unknown ID reports the config path and available IDs. Its tests check maintenance calls as well as launches. The fresh-start path resolves all agent roots once for selection and again for workspace operations.

**Antigravity** at `76c894beac6c031d3b19ba299f38031df6323de9` has the most complete continuation test. It observes the foreground loop running exactly once after a drop and a profile change, and checks the prompt boundary on a mismatch. Its two command handlers repeat the flag lookup, root resolution, selection and fresh solo validation. The shared startup function then resolves roots again.

All three implement the issue's unknown-ID and duplicate-ID rules, preserve CLI order, and retain every configured clone for workspace containment and cleanup. Each uses the existing roster for branch preparation, maintenance, durable state and launches. Product edits stay within the same three approved files. All reuse the CLI fixtures and add focused cases without new product files, dependencies or schema changes.

### Review findings

1. `docs/coord-driver.md:256` (Antigravity). Each example for starting issue 42 must work from the state left by the preceding commands in its shell block. The preceding `coord 42` freezes the default roster. Executing the next line with a three-agent subset against the default five-agent workspace then reports a roster mismatch. Present the subset invocation as an alternative first command.
2. `docs/coord-driver.md:280` (Claude). Continuation instructions must identify the numeric command. The guide previously offers `coord start 42 --agents …`, so an owner following “repeat the original command” after an explicit start receives the existing-runtime error. Show `coord 42 --agents …` as the replay form.
3. `test/cli.test.ts:409` (Codex) and `test/cli.test.ts:305` (Claude). A successful numeric continuation must enter the foreground loop. Returning zero immediately after a matching explicit selection would leave the owner without a runner while both tests still passed their exit-code, maintenance and snapshot assertions. Count calls to the injected loop's `run` method for the matching invocation, as Antigravity does at `test/cli.test.ts:2568`.

The issue journal records successful product-hook runs of `pnpm run check:fast` and `pnpm run test:e2e` for all three submissions. Codex's earlier path-limited commit attempt failed when Git fixtures inherited its temporary index. A normal staged commit passed on the same index tree. This comparison used the three bound worktrees and the recorded results.
