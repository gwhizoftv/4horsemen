# Issue 94: Cursor hook parity for lifecycle, tools, and token analytics

## Scope

Wire the Cursor CLI hooks we already rely on for nudge timing plus the
analytics hooks Cursor exposes but we never registered:

- `postToolUse` / `postToolUseFailure` — tool counts
- `afterAgentResponse` — turn-bound token usage when present on stdin
- keep existing `sessionStart`, `beforeSubmitPrompt`, `stop`, `sessionEnd`

Persist normalized usage into `journal.jsonl` as `agent-usage` events keyed by
`conversation_id` / `generation_id`, then teach `coord analytics` to aggregate
Cursor the same way Claude/Codex aggregate transcript turns (no `store.db`
scraping).

## Exact File Map

- `src/agentHookSync.ts` — register the three analytics hooks
- `src/agentEvent.ts` — parse Cursor usage payloads; journal `agent-usage`
- `src/cursorHookUsage.ts` — **created**; token extraction + journal aggregation
- `src/analytics.ts` — route Cursor agents through hook journal reader
- `src/state.ts` — allow `agent-usage` journal type
- `docs/analytics.md` — document Cursor hook-sourced metrics
- `test/agentEvent.test.ts`, `test/agentHookSync.test.ts`, `test/cursorHookUsage.test.ts`, `test/analytics.test.ts`
- `package.json`, `config.product.example.json` — version `0.0.16`

## Tests

- `pnpm check:fast` before commit

## Alternatives Rejected

- Scraping Cursor private DBs — forbidden by analytics design
- Overloading `agent-lifecycle` only — tool events are not lifecycle state transitions

## Risks and Mitigations

- Token field names may vary by Cursor version — accept several aliases; coverage stays `partial` when absent
- Duplicate token records on `stop` + `afterAgentResponse` — keep latest journal record per `generation_id`

## Conclusion

Ship managed Cursor analytics hooks, durable journal usage, and analytics parity so Cursor is no longer permanently `unavailable`.
