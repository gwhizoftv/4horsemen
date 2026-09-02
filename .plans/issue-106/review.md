## Findings

1. **Claude plan — `src/tmux.ts` change, stdin error handler:** The handler
   must make only the reported `EPIPE` race non-fatal while preserving a
   distinguishable failure for unexpected stdin errors. As written, the plan
   says the handler records every stdin error and neither rejects nor otherwise
   branches on the error. If a future tmux invocation receives `EBADF`,
   `ERR_STREAM_DESTROYED`, or another genuine pipe failure while the child exits
   successfully, `runTmux` would resolve the close result and callers could
   treat the operation as successful, silently masking the delivery failure.
   Branch on the error code: handle `EPIPE` without rejecting, and preserve a
   rejection or equivalent explicit failure path for other codes; add the
   corresponding focused assertion if that behavior is retained.

The Codex and Cursor plans otherwise stay within issue 106, reuse the existing
`runTmux` boundary and `test/tmux.test.ts` support, justify their file scope,
and propose focused regression coverage. Cursor's additional use of ignored
stdin for calls without input is a compatible hardening improvement because all
current production calls omit the optional input; either that improvement or a
listener-only fix can satisfy the issue once the non-`EPIPE` behavior is made
explicit.

## Conclusion

Revise the Claude plan's all-errors-swallowed behavior as noted above. With that
correction, the peer plans agree on the minimal product/test boundary:
`src/tmux.ts` handles the stdin race and `test/tmux.test.ts` proves a child
closing before input does not crash the coordinator. The plan is otherwise
ready for implementation and the required `pnpm check:fast` / `pnpm check`
verification.
