# Issue 106 — Make tmux stdin EPIPE non-fatal

## Exact File List to be changed or deleted

- `src/tmux.ts` — harden `runTmux` so an `EPIPE` emitted by the child stdin
  stream while ending the tmux command input is handled as an expected,
  non-fatal pipe closure. Preserve rejection for spawn failures and unexpected
  stdin errors, and preserve the existing stdout/stderr collection and close
  result.
- `test/tmux.test.ts` — add a focused `runTmux` boundary test using the
  existing Vitest test setup to simulate a child whose stdin emits `EPIPE`,
  proving the returned promise settles normally rather than producing an
  unhandled stream error.

## Exact file list to be created

- `.plans/issue-106/plan.md` — this implementation plan; no product files,
  new dependencies, fixtures, or additional abstractions are needed.

## Reuse and Scope

The implementation reuses the existing `runTmux` function and `TmuxRunner` /
`TmuxResult` contracts in `src/tmux.ts`. `TmuxController` and all of its
callers remain unchanged: they should continue to receive the same close-code,
stdout, and trimmed stderr result for successful and failed tmux commands.

The regression case joins `test/tmux.test.ts`, reusing its Vitest `describe` /
`it` / `expect` setup and the existing `TmuxResult` typing. The test will mock
only the `node:child_process.spawn` boundary with an EventEmitter-shaped fake
child and stdin, so it can deterministically emit `EPIPE` without depending on
the host tmux installation or timing. No new file or helper is justified; the
fake is local to the one boundary test.

## Tests

- Add one test in `test/tmux.test.ts` that starts `runTmux` with a fake child,
  emits an `EPIPE` from `child.stdin` during `end`, then emits the normal
  `close` event. It must resolve with the close result and must not reject or
  surface an unhandled error. This fails against the current implementation,
  which has no stdin error listener, and passes once `EPIPE` is handled.
- Run `pnpm check:fast` before committing (the repository's declared
  pre-commit suite).
- Run `pnpm check` before publication/final acceptance, as required by the
  repository workflow.

## Alternatives Rejected

- **Catch around `child.stdin.end(...)` only.** Stream write errors are emitted
  asynchronously, so a synchronous `try`/`catch` cannot prevent the unhandled
  `error` event that crashes the coordinator.
- **Ignore every stdin error.** This would hide genuine spawn/pipe failures and
  make tmux failures harder to diagnose; only the expected `EPIPE` code should
  be non-fatal.
- **Change `TmuxController` callers or add retry logic.** The failure occurs at
  the `runTmux` child-stream boundary; retrying a tmux operation would broaden
  scope and could duplicate side effects.
- **Use an integration test with a real tmux server.** It is timing- and
  environment-dependent and cannot reliably force the stdin pipe to close at
  the relevant point; a mocked child boundary tests the exact failure mode.

## Risks and Mitigations

- **Risk: an unexpected stdin error is accidentally swallowed.** Mitigation:
  branch specifically on the Node error code `EPIPE`; retain rejection for
  other stdin errors and the existing child `error` handler.
- **Risk: the new listener changes normal command completion.** Mitigation:
  attach it before `stdin.end`, leave close-event result construction
  unchanged, and assert the normal close result in the regression test.
- **Risk: the test mock masks unrelated child-process behavior.** Mitigation:
  keep the mock local to `runTmux`, model only the streams and events that
  `runTmux` consumes, and run the full fast and acceptance suites.

## Conclusion

Handle only stdin `EPIPE` at the `runTmux` stream boundary and cover it with a
deterministic regression test in the existing tmux test file. This prevents a
closed tmux pipe from terminating the coordinator while preserving normal
result handling and visibility of other failures.
