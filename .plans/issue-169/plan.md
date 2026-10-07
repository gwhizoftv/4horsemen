# Issue 169 — Durable idle signal via mailbox `ready` file

## Problem

Agents already print `COORD-IDLE: waiting for the next coordinator action file`
after writing `complete` when `action.md` is unchanged. The coordinator uses that
line (plus vendor prompt scrape) to overrule a stale lifecycle `working` record
before the first nudge of the next action. In practice the pane scrape often
misses present-tense idleness: the sentinel scrolls out of the 40-line capture,
vendor chrome masks it, or hooks never deliver `Stop`, so delivery stays deferred
(`working` / `no-idle-sentinel`) even though the agent is waiting.

Issue 169's prescribed fix is a durable mailbox file beside `complete`, not a
stronger scrape. `foreground-mismatch` at Terminal open is a separate delivery
gate and is out of scope here.

## Exact File List to be changed or deleted

- `src/paths.ts` — add `ready` next to `complete` on `AgentRuntimePaths`; update
  the mailbox comment that today claims `complete` is the only agent-written
  runtime file.
- `src/action.ts` — add `parseReady` / `readReady` / `clearReady` mirroring
  completion parsing (`ready <actionId>` sole contents); extend git and response
  action footers so idle agents are told the absolute `ready` path and the
  write-then-`COORD-IDLE` sequence after an unchanged re-read.
- `src/runLoop.ts` — when building orders, pass `readyPath`; before a
  never-sent nudge against lifecycle `working`, accept a fresh matching `ready`
  file as idle authority (same dialog / owner-typing / turn-chrome vetoes as
  today); `clearReady` after a successful nudge send; clear `ready` wherever
  `clearCompletion` already runs for drop/retire/accept transitions that reset
  the mailbox drop.
- `src/agentLifecycle.ts` — persist `lastAcceptedActionId` (nullable UUID) on
  each agent entry when `markActionWorkflowComplete` succeeds; leave it set
  across the following `orderAgentAction` so the next action can match the
  ready file against the issue's "last accepted action" rule.
- `src/ownerControls.ts` — clear `ready` whenever owner recovery clears
  `complete` for an agent.
- `templates/product/AGENTS.protocol.md` — after the unchanged-`actionId`
  re-read, require writing `ready <actionId>` beside `complete`, then print
  `COORD-IDLE` (keep the sentinel; do not replace it).
- `docs/readiness-policy.md` — document the mailbox `ready` file as additive
  idle evidence for the stale-`working` / never-sent exception; keep scrape as
  veto and COORD-IDLE as secondary confirmation.
- `docs/coord-driver.md` — mailbox layout includes `ready`; agents may write
  `complete` and `ready` under the same per-agent drop (response path unchanged).
- `docs/repo-map.md` / `docs/setup-workspace.md` — one-line updates so the
  mailbox description names `ready` (no new grant: drop directory already
  covers the sibling file).
- `test/action.test.ts` — parse/read/clear cases for `ready <uuid>` and
  malformed forms; action body includes the ready-path idle instructions.
- `test/runLoop.test.ts` — extend/add cases: stale `working` + matching fresh
  `ready` for last accepted action delivers once and deletes `ready`; stale
  `ready` after a later hook event does not override; COORD-IDLE-only path
  still works; successful nudge without `ready` unchanged for ordinary idle
  hooks.
- `test/agentLifecycle.test.ts` (or the existing lifecycle test file if that
  name differs) — `lastAcceptedActionId` set on workflow complete and retained
  when a new action is ordered.

## Exact file list to be created

- `.plans/issue-169/plan.md` — this plan.

No new production modules: parsing belongs next to completion in `action.ts`,
and the path belongs on `AgentRuntimePaths`.

## Reuse and Scope

Reuse:

- `agentRuntimePaths` / `completeDir` — `ready` is `containedPath(completeDir, "ready")`;
  same mailbox grant, no install/sandbox change.
- `parseCompletion` / `readCompletion` / `clearCompletion` — copy the
  missing/malformed/valid shape for `ready <actionId>`.
- `deliver()`'s existing `staleWorking` gate and `staleOverride` lifecycle
  re-check — add a parallel authority path that does not require
  `requireIdleSentinel` when `readReady` matches `lastAcceptedActionId` and
  `stat(ready).mtimeMs` is strictly after `Date.parse(lastEventAt)` (or
  `lastEventAt` is null). Pane scrape vetoes (trust dialog, turn chrome,
  owner-typing, foreground mismatch) still apply; ready never clears a scrape
  blocker.
- `markActionWorkflowComplete`, `markActionInjected`, `decideLifecycleNudge`,
  `neverSentWorking` — ready only expands the never-sent + `working` exception
  described in the issue; it does not authorize duplicate sends after
  `idle-transition-already-used`.
- Existing COORD-IDLE helpers in `src/tmux.ts` — leave in place as additive
  evidence when the ready file is absent (older agents / partial protocol).
- Protocol lift via `agentsProtocol.ts` / `prepareAgentBranch.ts` — editing the
  template is enough; clones pick up the block on the next prepare/lift.
- Tests: fixture patterns in `test/runLoop.test.ts` around
  "lets a current COORD-IDLE overrule a stale working record…".

New surface limited to: one mailbox filename, a small parser, one lifecycle
field, delivery/clear call sites, protocol/docs, and focused tests. No new
dependencies.

## Tests

Commands (declared in this repository):

- Focused while developing: `pnpm exec vitest run test/action.test.ts test/runLoop.test.ts` (plus the lifecycle test file touched).
- Product commit gate: `pnpm check:fast` (hook-owned at commit; do not duplicate immediately before commit unless investigating).
- Full suite before PR when required: `pnpm check`.

Cases that fail before the change and pass after:

1. Lifecycle `working`, action never sent, pane without COORD-IDLE, `ready`
   names `lastAcceptedActionId` with mtime after `lastEventAt` → one nudge,
   journal notes ready-file override, `ready` unlinked.
2. Same setup but a hook event lands after `ready` was written → defer; no send.
3. `ready` names a UUID that is not `lastAcceptedActionId` → ignore; no override.
4. Existing COORD-IDLE override test still passes with no `ready` file.
5. `parseReady` accepts `ready <uuid>` / trailing newline; rejects empty,
   multi-line, and non-UUID forms.
6. Rendered action.md (git and response) mentions writing `ready` beside
   `complete` when the re-read is unchanged.

## Alternatives Rejected

- **Stronger pane scrape only** (larger capture, alternate sentinel parsing) —
  the issue already shows scrape is unreliable against scrollback and chrome;
  a durable file is the stated fix.
- **Treat any vendor idle prompt as enough to clear stale `working`** — would
  type into turns when Stop is missing but chrome is absent; readiness policy
  forbids scrape-as-authorization for duplicates and keeps the sentinel/ready
  exception narrow.
- **Rewrite lifecycle to `idle` when `complete` is accepted** — conflates
  workflow truth with observability; Stop/hooks would fight the rewrite on the
  next turn. Ready is explicit agent intent to receive the next nudge.
- **Put `ready` under the coord agent root beside `action.md`** — reopens the
  writable-grant problem the mailbox solved; sibling of `complete` stays inside
  the existing drop grant.
- **Fix `foreground-mismatch` at Terminal startup in this issue** — related
  operator pain in the issue body, but a different gate (`GateReason`) with a
  different fix; do not expand scope.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Stale `ready` from a previous wait lets a nudge through while the agent is mid-turn | Require mtime strictly after `lastEventAt`; any prompt-submit/Stop/working hook after the write invalidates it; scrape vetoes still apply |
| Agent writes `ready` before `complete` is accepted | Match against `lastAcceptedActionId` set only in `markActionWorkflowComplete`; a file naming the not-yet-accepted action does not authorize the *next* action's send |
| Protocol lag (agents that never write `ready`) | Keep COORD-IDLE override and normal idle-hook path; ready is additive |
| Forgetting to delete `ready` after send | `clearReady` in the same success path as `markActionInjected`; also clear with `clearCompletion` on drop/retire |
| Lifecycle schema bump / old `agent-lifecycle.json` | Default `lastAcceptedActionId` to `null` in Zod so existing state files load |

## Conclusion

Add a mailbox `ready <actionId>` file as durable idle evidence beside `complete`,
teach agents (protocol + action footer) to write it when a re-read shows no new
work, and let the coordinator use a fresh match against `lastAcceptedActionId`
to overrule stale lifecycle `working` for a never-sent next nudge—then delete
the file. Pane scrape remains a veto; COORD-IDLE remains secondary. Smallest
change that matches the issue's two-party contract without expanding into
startup `foreground-mismatch` work.
