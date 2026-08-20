# Issue 76 implementation comparison

Bound implementation pins:

| Agent | SHA |
| --- | --- |
| cursor | `2857bc3ec2a2bc096a954299d454b67dea973fbf` |
| antigravity | `40647d94c0e4a1c6d9166b97fed9b9475b926ea5` |
| claude | `40157df58f5fe280e10c694e8579f004536c9928` |
| codex | `5402e1d02c8cca3dd9307281e242c4600dc2b83b` |

## Comparison

All four pins deliver `coord manual` / `coord detach manual` as a launch-only
lifecycle over `ensureSession` + `openOwnerAgentClients({ onlyMissing: true })`,
bump to `0.0.12`, and leave the automated workflow modules untouched. Cursor
(`2857bc3e…`) and Codex (`5402e1d0…`) both require `coord-manual-<group>`, clear
`COORD_ISSUE` with a tmux-valid argv, bound conflict checks to this workspace's
durable issue dirs, and tear down manual UI on uninstall with empty `issue-*`
lists. Claude (`40157df5…`) matches that architecture but ships a broken unset
argv that real tmux rejects. Antigravity (`40647d94…`) still allows a globally
unscoped `coord-manual` session and pins that behavior in tests, recreating the
cross-product collision called out in plan review.

### 1. Antigravity — unscoped flat `coord-manual` session name

**File.** `src/tmux.ts:470` (also `ownerTerminalWindowTitle` at `src/tmux.ts:254–256`);
pinned by `test/tmux.test.ts:62`.

**Rule.** Manual UI must always be `coord-manual-<workspace-group>`. Tmux session
names are machine-global; two flat products on one host must not share a session.

**Failure.** `sessionName("manual")` returns bare `coord-manual` when
`terminalTitleGroup()` is null/empty. Flat installs set `tmuxNamespace` to null
while still having a `terminalGroup`, but a controller constructed without
`titleGroup` (or any path that omits it) creates the unscoped name. Two products
then attach to the same panes; `coord detach manual` / uninstall for either can
kill the other's harnesses. The unit test at line 62 asserts the broken name as
expected, so the suite will not catch the regression.

**Test.**

```ts
it("refuses unscoped manual session names", () => {
  const runner = async () => ({ exitCode: 0, stdout: "", stderr: "" });
  expect(() => new TmuxController(runner).sessionName("manual")).toThrow(/workspace group/i);
  expect(new TmuxController(runner, null, null, null, undefined, "abc12def00").sessionName("manual")).toBe(
    "coord-manual-abc12def00"
  );
});
```

### 2. Claude — `COORD_ISSUE` unset argv is rejected by tmux

**File.** `src/tmux.ts:648`; pinned by `test/tmux.test.ts:880`.

**Rule.** A manual session must clear a stale `COORD_ISSUE` so panes cannot
resolve `coord next` / issue runtime. The tmux form is
`set-environment -u -t <session> COORD_ISSUE` (flags before the name).

**Failure.** Claude issues `["set-environment", "-u", "COORD_ISSUE", "-t", session]`.
Live tmux responds `too many arguments (need at most 2)` and leaves
`COORD_ISSUE` set. `ensureSession("manual", …)` then throws after create, or — if
the exit check were weakened — would leave the leaked identity in place. The
fake runner in the unit test returns success for any argv, and the assertion
locks in the invalid order, so CI stays green while production fails.

**Test.**

```ts
expect(calls).toContainEqual(["set-environment", "-u", "-t", session, "COORD_ISSUE"]);
// and/or spawn a real tmux session in an opt-in smoke and assert show-environment
// has no COORD_ISSUE after ensureSession("manual", …).
```

### 3. Antigravity — release metadata / root AGENTS drift

**File.** `package.json` is `0.0.12` at `40647d94…`, but
`config.product.example.json` remains `0.0.11`; `AGENTS.md` is unchanged vs
`origin/main` at this pin (unlike cursor/claude/codex).

**Rule.** Pre-1.0 ship metadata must stay aligned, and root agent instructions
must distinguish automated `action.md` work from owner-driven `coord manual`
scratch branches so operators and agents are not steered only by the issue path.

**Failure.** Following Antigravity alone, the example stamp contradicts the
package version operators copy from docs, and the tracked `AGENTS.md` still
reads as issue-only (`Branches: issue-<n>/<agent>` with no manual section), so
agents in a coordination clone keep asking for an issue number under manual UI.

**Correction.** Bump `config.product.example.json` to `0.0.12` and add the same
automated-vs-manual scoping the other three pins already ship in `AGENTS.md`.

### Relative strength

Prefer **Codex** (`5402e1d0…`) or **Cursor** (`2857bc3e…`) as the merge base:
mandatory grouped manual names, tmux-valid `COORD_ISSUE` clear, workspace-bounded
conflicts, and uninstall `includeManual: true`. Claude needs finding 2 fixed
before it is safe. Antigravity needs findings 1 and 3 fixed; as written it is
unsafe for multi-product hosts.
