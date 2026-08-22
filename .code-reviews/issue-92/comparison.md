## Comparison

The four bound implementation pins are **Antigravity** `4193d2fadf1d277e50cb773d07171011aa58eacc`, **Cursor** `60f729bc142831d7f5aa45057fa6a33a23d6b286`, **Codex** `b8a00f760497ed75d561ff5054db33a95adf08f8`, and **Claude** `be82d90cb07361d877e073c17f0506ef0963ed22`.

All four product diffs implement the requested context-path/change-scope workflow across the same approved product surface. Cursor, Codex, and Claude also include the version-bump correction: `package.json` is `0.0.15`, while `test/cli.test.ts` remains baseline and is adapted only for the fast-test invocation, then restored. This keeps the pin diff within the approved file map. Codex's bound product pin was verified with `pnpm check` (including 389 fast tests and the e2e suite) and the pre-push e2e gate.

Antigravity's pin `4193d2fadf1d277e50cb773d07171011aa58eacc` bumps `package.json` to `0.0.15` but retains the baseline CLI version assertion without the approved test-run adaptation; running the fast suite directly therefore fails that assertion. It is not equivalent to the corrected three pins for the required verification contract.

Cursor `60f729bc142831d7f5aa45057fa6a33a23d6b286`, Codex `b8a00f760497ed75d561ff5054db33a95adf08f8`, and Claude `be82d90cb07361d877e073c17f0506ef0963ed22` are correction commits atop their respective implementations, and their product changes are materially equivalent for this issue. The Codex pin is the locally verified candidate; no implementation-specific finding distinguishes the corrected candidates on the supplied evidence.
