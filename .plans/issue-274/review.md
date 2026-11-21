# Plan Review — Issue 274

Reviewed bound plans:
- `codex` (`8d35e7358c6950d37273bc0ff44c1d78db76fae9`)
- `claude` (`13a88fdf0ae7ed34ddfbfbe266dd078ec20b46e5`)
- `antigravity` (`8b884baed15fc16f9fd34674772cd3a4362a2059`)

## Findings

### Claude (`13a88fdf0ae7ed34ddfbfbe266dd078ec20b46e5`)

1. **Plan claim (`Behaviour`, `Tests` items 3–4):** Invalid `--agents` inputs and resume roster mismatches exit with code `1` (`expects exit 1` / `returns 1`).
   - **Rule:** `runCli` (`src/cli.ts:1977-1980`) catches thrown `Error`s and returns exit code `2` for all CLI argument and validation failures.
   - **Concrete failure:** Following the plan writes tests asserting exit code `1` that fail against `runCli`'s actual return code `2`, or alters `runCli`'s catch block and breaks existing error tests in `test/cli.test.ts`.
   - **Smallest correction:** Specify and assert exit code `2` for all validation and resume-mismatch errors.

2. **Plan claim (`Exact File List`, `Risks and Mitigations`):** `selectAgents` runs at the top of `startIssue`, and the numeric resume check runs after `existing !== null`, without moving validation ahead of `assertNoManualSession` (`src/cli.ts:1345, 1663`).
   - **Rule:** Invalid `--agents` selections and numeric resume mismatches must fail before any interactive prompt or external side effect, including `assertNoManualSession` closing a live manual session and resetting clones.
   - **Concrete failure:** When manual mode is open and the owner runs `coord 274 --agents claude,typo` or `coord start 274 --agents claude,claude` (or a mismatched `coord 274 --agents ...` on an existing run), `assertNoManualSession` executes first — either reporting a misleading `Manual mode is active` error non-interactively or prompting and tearing down the live manual tmux/Terminal session and resetting clones before rejecting the bad flag.
   - **Smallest correction:** Validate `--agents` and check numeric resume roster matches before calling `assertNoManualSession`.

3. **Plan claim (`Behaviour`, `Exact File List`, `Tests` item 2):** `startIssue` computes `const roster = profile === "solo" ? selected.slice(0, 1) : selected`, so `coord start 1 --agents claude,codex --profile solo` succeeds and runs only `claude`.
   - **Rule:** When the owner explicitly passes `--agents` naming multiple agents, `coord` must not silently discard agents from that list; a multi-agent `--agents` selection conflicts with `profile: "solo"` and must fail closed.
   - **Concrete failure:** If `config.json` defaults to `"profile": "solo"` and the owner runs `coord 274 --agents claude,codex,antigravity`, `coord` silently drops `codex` and `antigravity` and launches only `claude` without any error.
   - **Smallest correction:** Reject `--agents` with more than one agent whenever the effective fresh-start profile is `"solo"`, explaining how to pass a single agent or `--profile reviewed|consensus`.

4. **Plan claim (`Exact File List`):** `parseAgentList` uses `.split(",").map((agent) => agent.trim()).filter((agent) => agent !== "")`, dropping empty comma-separated segments.
   - **Rule:** Malformed run-time `--agents` lists containing empty segments (such as `claude,,codex` or `claude,`) must be rejected rather than silently dropped.
   - **Concrete failure:** Running `coord 274 --agents claude,,codex` (an omitted id between commas) silently starts `["claude", "codex"]` instead of returning an error.
   - **Smallest correction:** Reject any empty trimmed token in run-time `--agents` selection rather than filtering empty tokens out.

5. **Plan claim (`Tests`):** Focused test commands run `pnpm exec vitest run --config vitest.config.ts test/cli.test.ts ...` (and `test/onboard.test.ts`, `test/install.test.ts`).
   - **Rule:** `vitest.config.ts:7-18` explicitly excludes `test/cli.test.ts`, `test/onboard.test.ts`, and `test/install.test.ts`; those suites belong to `vitest.system.config.ts`.
   - **Concrete failure:** Running the plan's focused Vitest commands finds zero test files and fails immediately.
   - **Smallest correction:** Use `--config vitest.system.config.ts`.

### Codex (`8d35e7358c6950d37273bc0ff44c1d78db76fae9`)

6. **Plan claim (`Reuse and Scope` item 2):** Multi-agent `solo` rejection is placed inside `startIssue` ("In `startIssue`, ... Reject a multi-agent solo request before side effects"), while `Tests` requires "no session cleanup" for multi-agent solo selections.
   - **Rule:** In `src/cli.ts:1345` and `src/cli.ts:1663`, `assertNoManualSession` runs before `startIssue` and can prompt to tear down a live manual session and reset clones; fresh-start multi-agent `solo` validation must execute before `assertNoManualSession`.
   - **Concrete failure:** With a manual session open, running `coord start 1 --profile solo --agents claude,codex` (or fresh `coord 1 --profile solo --agents claude,codex`) reaches `assertNoManualSession` before `startIssue`, either reporting `Manual mode is active` instead of the multi-agent solo error or closing the manual session on confirmation before failing, contradicting the plan's own "no session cleanup" test assertion.
   - **Smallest correction:** Validate the fresh-start multi-agent `solo` constraint before `assertNoManualSession` (in `coord start` and in the `existing === null` path of numeric `coord <issue>`), keeping it off numeric continuation.

### Antigravity (`8b884baed15fc16f9fd34674772cd3a4362a2059`)

7. **Plan claim (`Exact File List` — `resolveStart`):** Rejects `selectedAgents !== null && profile === "solo" && selectedAgents.length > 1` unconditionally inside `resolveStart`, before numeric `coord <issue>` checks `existingIssueRuntime`.
   - **Rule:** An existing issue's profile and roster are frozen in `start.json`; replaying the exact original `coord N --agents a,b` command to resume that issue must compare against the saved `originalRoster` and must not fail merely because `config.json`'s default `profile` was later changed to `"solo"`.
   - **Concrete failure:** After starting issue 1 under `consensus` with `coord 1 --agents claude,codex`, changing `config.json`'s default `profile` to `"solo"` causes `coord 1 --agents claude,codex` to fail in `resolveStart` with the multi-agent solo error instead of resuming the existing run.
   - **Smallest correction:** Move the multi-agent `solo` check out of `resolveStart` and apply it only on fresh starts (in `coord start` and in the `existing === null` branch of `coord <issue>`, still before `assertNoManualSession`).

8. **Plan claim (`Tests`):** Lists `pnpm test:fast test/cli.test.ts` as the focused implementation test command.
   - **Rule:** `pnpm test:fast` runs `vitest.config.ts`, which excludes `test/cli.test.ts` (`vitest.config.ts:9`); `test/cli.test.ts` runs under `vitest.system.config.ts` (`pnpm test:system`).
   - **Concrete failure:** Running `pnpm test:fast test/cli.test.ts` matches zero test files and fails.
   - **Smallest correction:** Run `pnpm exec vitest run --config vitest.system.config.ts test/cli.test.ts`.

### Scope, Reuse, New Files, and Test Focus Evaluation

- **Scope:** All three plans stay strictly within issue #274 (`src/cli.ts`, `test/cli.test.ts`, plus one concise doc file — `docs/coord-driver.md` for Codex/Antigravity, `README.md` for Claude), with no schema changes, no config mutation, and no unsolicited changes to `coord manual` or downstream commands.
- **Reuse:** All three plans reuse `parseArgs`, `allowedFlags`, `resolveStart`, `resolvedAgents`, `startIssue`'s existing `roster` pipeline, `existingIssueRuntime`, and `test/cli.test.ts`'s `setup`/`successfulStartGit`/`fakeLoop` fixtures. Codex's design also avoids widening `StartResolution` for unrelated callers (`attach`, `detach`, `manual`, `auth`) while preserving continuation after a default-profile change.
- **New files:** All three plans create zero new product or test files, properly justified.
- **Test focus:** All three plans extend `test/cli.test.ts` with a small, focused set of table-driven/targeted tests rather than adding a new test file. Codex's plan is the only one that names the right Vitest config (`vitest.system.config.ts`) and tests no-session-cleanup on invalid selections.

## Conclusion

- **Codex (`8d35e735`)** is the strongest and most mechanically accurate plan: it gets the exit code (`2`), strict empty-token rejection, multi-agent `solo` rejection, continuation invariance after default-profile changes, and `vitest.system.config.ts` command right. It has only one minor ordering issue to tighten during implementation: moving the fresh-start multi-agent `solo` check ahead of `assertNoManualSession` so it matches its own "no session cleanup" test requirement.
- **Antigravity (`8b884bae`)** shares the same strong core design and file map, with two small corrections needed (moving the multi-agent `solo` check from `resolveStart` to fresh-start paths only so continuation survives a config default-profile change, and using `vitest.system.config.ts`).
- **Claude (`13a88fdf`)** has five concrete issues (wrong exit code `1`, validation after `assertNoManualSession`, silently slicing multi-agent `--agents` under `solo`, silently dropping empty CSV entries, and wrong Vitest config).

Recommend selecting **Codex (`8d35e735`)** (with the minor pre-`assertNoManualSession` ordering adjustment for the fresh-start multi-agent `solo` check during implementation).
