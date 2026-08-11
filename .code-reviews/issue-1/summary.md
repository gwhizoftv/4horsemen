# Code Review Summary & Recommendation

**Reviewer:** Antigravity

After reviewing the branches `issue-1/claude`, `issue-1/cursor`, and `issue-1/codex`, I recommend adopting **Claude's codebase** (`issue-1/claude`) as the definitive foundation for the project.

## Why Claude's Codebase is the Best
1. **Architectural Purity & Insight:** Claude's branch is the most rigorously designed. Before writing any code, it caught a fundamental flaw in the original plan (the `machine.ts` pure state reducer transitively importing Git I/O through `evidence.ts`). Claude correctly inverted this dependency, pulling the effectful evidence evaluation into the `runLoop` and passing only the resulting observation into the pure reducer. (While Cursor and Codex also adopted this fix, they did so based on Claude's initial review).
2. **Boundary Validation:** Claude's implementation makes exceptional use of `zod` to validate all I/O boundaries. It doesn't just trust the CLI arguments, the JSON configs, or the disk reads—it parses and validates them strictly, which is critical for a coordinator orchestrating automated agents.
3. **Completeness:** It implemented the R7 finalization perfectly and correctly identified and fixed the silent failures in the legacy `package.json` scripts (where `test:e2e` was not actually running on the pre-push hook).

## Required Revisions Before Proceeding
If we adopt `issue-1/claude` as the baseline moving forward, I require the following three changes/additions drawn from the strengths of the other agents:

1. **Adopt Codex's Environment Variable Ergonomics:**
   Claude strictly requires `--coord-root` and `--issue` flags for every single command. Codex smartly recognized that this is tedious for operators and implemented `COORD_ROOT` and `COORD_ISSUE` environment variable fallbacks. We should merge this ergonomic improvement into Claude's CLI parser.
   
2. **Adopt Cursor's Dependency Injection for Tests:**
   Claude's `cli.ts` is nearly 600 lines long and handles a lot of orchestration directly, making it hard to test without real disk/Git effects. Cursor introduced a brilliant `CliDependencies` injection interface in its CLI parser, allowing the test suite to pass in mocked I/O and process runners. We should refactor Claude's CLI to use this pattern to guarantee the E2E tests remain deterministic and fast.
   
3. **Extract Orchestration out of `cli.ts`:**
   Because Claude is so thorough, its `cli.ts` file became overly dense. The actual execution of commands like `drop`, `restart-action`, and `abandon` should be extracted out of the CLI routing layer and moved into `runLoop.ts` (or a dedicated `operations.ts` file) so that the CLI module remains focused strictly on parsing arguments and formatting output.
