# Issue 169 — implementation comparison (cursor)

## Comparison

Bound implementation pins:

- codex `d6fd390286105a45df6420b062b7b9e817302c5a`
- cursor `86b34cf1f4c5f9fbe318dc4aaed349b6dac601f5`
- claude `a92952226156e51a12144a8425c10d5be4b136fd`

All three implement the mailbox `ready <actionId>` handshake beside `complete`, bind eligibility to a durable last-accepted action id, require receipt mtime strictly after a hook-freshness floor, keep scrape vetoes, teach Codex file-proof sends that do not need COORD-IDLE at the pane tail, allow writing `ready` when `action.md` is already missing after accept, and consume the receipt after a successful nudge rather than on workflow accept. None opens a broad message-only stdout rewrite beyond receipt-aware override logs. They diverge on where hook receipt lives, which observation kinds advance it, how cleanup is identity-safe, and whether amendment retirement deletes `ready`.

### Approaches

**Claude (`a9295222`).** Hook receipt on the lifecycle entry; advances for activity hooks only (skips both `status` and `telemetry`). Single predicate `readyReceiptProvesIdle`. Identity-checked `readReadyReceipt` / `clearReadyReceipt`. Tmux `proof: "ready-file"` with composer-anchored Codex checks and a dedicated `composer-draft` reason. Policy documents the full receipt contract.

**Codex (`d6fd3902`).** Same lifecycle `hookReceipt` shape with O_NOFOLLOW / identity-safe read and clear (64-byte cap). File-proof tmux via `source !== "ready-file"` sentinel requirement. Strongest low-level receipt I/O. Advances hook receipt for every kind except `telemetry` (still advances on Antigravity `status`).

**Cursor (`86b34cf1`).** Splits freshness into cursor fields (`hookReceiptAt` / `hookReceiptSequence`) updated from `observeAgentLifecycleWithResult` for every non-`telemetry` kind. Exports `isReadyReceiptEligible` / `parseReady`. Dedicated Codex file-proof helpers in tmux. Clears ready by last-accepted action id after any successful send; also unlinks `ready` during amendment retirement and agent drop.

### Shared strengths

- Never-sent `working` / `unknown` reach deliver only with sentinel or a fresh matching receipt (all three gate `unknown` on ready in `maybeLifecycleNudge`).
- `lastAcceptedActionId` set on Git and response acceptance.
- Protocol + action footers instruct `ready` then COORD-IDLE, including the missing-`action.md` case.
- No product files outside the approved map.

### Findings

1. **cursor `86b34cf1` — `src/runLoop.ts:2002`.** Rule: a ready receipt must survive until a successful next-action nudge (or intentional drop), not be deleted when retiring peer amendment ballots. Failure: `retireAmendmentActions` unconditionally `unlinkSync(runtime.ready)`, so a requester who wrote `ready` for the just-accepted implement/revise action can lose the receipt before the amendment-ballot nudge. Codex and Claude leave `ready` alone in that path. Smallest fix: remove the ready unlink from retirement; keep consume-on-send only. Test: accept an amendment request with `ready <A>` present, retire peers, assert `ready` still exists and still authorizes the next ordered nudge.

2. **cursor `86b34cf1` — `src/agentLifecycle.ts:688` (via `advanceHookReceipt` in `src/state.ts`).** Rule: status-bar / telemetry renders must not raise the freshness floor that invalidates `ready` (Claude documents this; `kind: "telemetry"` is never activity). Failure: every non-`telemetry` observation advances cursor hook receipt, including Antigravity `status`, so a post-idle status render can make a valid Claude/Cursor receipt look stale. Claude (`src/agentLifecycle.ts:732–734`) skips both `status` and `telemetry`. Smallest fix: exclude `status` the same way as `telemetry`. Test: write eligible `ready`, observe a `status` event, assert eligibility still holds.

3. **codex `d6fd3902` — `src/agentLifecycle.ts:704–707`.** Rule: same as finding 2. Failure: hook receipt advances for all kinds except `telemetry`, so `status` after `ready` can stall file-proof delivery. Smallest fix: mirror Claude’s `status || telemetry` skip.

4. **cursor `86b34cf1` — `src/runLoop.ts:1199–1202` and `src/action.ts:449–453`.** Rule: cleanup must remove only the observed authorizing receipt, not a replacement written mid-send. Failure: after send, `clearReady(..., lastAccepted)` re-reads by action id only; a newer same-UUID file written during the send can be deleted without having authorized it. Codex/Claude bind clear to the observed identity. Smallest fix: capture identity at deliver entry and pass it to clear. Test: swap `ready` identity after reserve, assert the replacement survives.

5. **cursor `86b34cf1` — `src/tmux.ts:1114`.** Rule: a Codex composer mismatch under file proof is not a missing idle sentinel. Failure: `composerMismatch` returns `no-idle-sentinel` even when `proof === "ready-file"`, so journals mislabel owner-draft refusals. Claude uses `composer-draft`. Smallest fix: return `composer-draft` for file-proof composer failures. Test: file-proof nudge with a non-empty owner draft asserts reason `composer-draft`.

6. **cursor `86b34cf1` — `src/action.ts:19` (`READY_MAX_BYTES = 512`).** Rule: ready is a tiny one-line marker, not a streamable blob (codex/claude cap at 64). Failure: a padded file up to 512 bytes can pass the size gate. Smallest fix: lower the cap to 64 and assert oversized rejection.

7. **codex `d6fd3902` — `src/runLoop.ts:1983` and claude `a9295222` — `src/runLoop.ts:1992`.** Rule: `lastAcceptedActionId` on amendment begin should name the requester’s just-completed implement/revise action so a receipt written for that action remains eligible. Failure: both set `decision.request.actionId` (the amendment-request artifact). If an agent wrote `ready` naming the implement action id still on the cursor, the ballot nudge will not match. Cursor (`src/runLoop.ts:2023–2030`) uses the requester’s `cursor.actionId`. Smallest fix: set from the requester cursor action id when non-null. Test: ready names implement action A; begin amendment; assert `lastAcceptedActionId === A` and the next nudge uses the receipt.

### Ranking

1. **Claude `a92952226156e51a12144a8425c10d5be4b136fd`** — Correct hook-receipt exclusions, identity-safe consume, composer reason code, and complete policy; fix amendment `lastAcceptedActionId` source (finding 7).
2. **Codex `d6fd390286105a45df6420b062b7b9e817302c5a`** — Best receipt I/O and solid file-proof tmux; fix `status` advancing hook receipt and amendment id source.
3. **Cursor `86b34cf1f4c5f9fbe318dc4aaed349b6dac601f5`** — Handshake shape is right and Codex tmux helpers are useful, but amendment retirement deletes `ready`, hook receipt advances on `status`, consume is not identity-bound, composer reason is wrong, and the ready size cap is loose.

**Merge guidance:** Prefer Claude’s lifecycle hook-receipt model and eligibility predicate; take Cursor’s requester-cursor amendment binding; keep Codex/Claude identity-based clear and the 64-byte cap; do not take Cursor’s `retireAmendmentActions` ready deletion.
