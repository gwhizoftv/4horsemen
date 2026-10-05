# Comparison — issue 142 implementations

Bound implementation pins compared against baseline `6fbbe84`:
- claude `64ace635ff399b21a136cf1f8ced9c526346fa45`
- cursor `da473de2bc7a3e5cc65651d28abb3704ce5f12fb`
- codex `39d7179cb242b64f791dc4dc2e5aada3e9a23b4f`

All three worktrees were read from the bound paths.

## Comparison

### Cursor and Claude are the same product change

I compared every product path in cursor `da473de2` with claude `64ace635`
using `cmp`: `scripts/lib/launcher.sh`, all ten `src/` files,
`templates/product/AGENTS.protocol.md`, and all eight test files. They are
byte-identical. The pins differ only in coordination artifacts. Every finding
below labelled "claude" therefore applies equally to cursor. Selecting either
pin selects the same code.

### Scope, reuse, and files

All three implementations change exactly the approved path set. None touches
`src/state.ts`, consistent with the rejected amendment. All three use the same
approach:
- a shim check mode (`COORD_GIT_POLICY_CHECK`);
- one `src/shellGuard.ts`;
- guard hooks for all four vendors through the existing `agentHookSync`
  installer, marked with `AGENT_LIFECYCLE_HOOK_MARKER`;
- lifecycle-state containment evidence, a `gitShim` doctor code 23, a coverage
  suffix on the `coord status` line, a warning at join, and a rewritten
  protocol paragraph.

Differences:
- **Probe recording.** Claude and Cursor have `coord containment-probe` write
  the owner runtime directly. Codex has it write a mailbox inside the clone's
  `.coord/` directory, which the run loop ingests (`ingestContainmentProbe`).
- **Shell parsing.** Codex's static parser models subshell and pipeline scope;
  Claude's does not. Codex also bounds work: a 128 KiB input limit, an 8192-word
  limit, and an overall budget of 256 parsed segments.
- **Evidence.** Codex relies on the agent to report the tool result and CLI
  version (`--tool-result`, `--vendor-version`). Claude measures it with a
  `; coord containment-probe --refusal-ran` tail on the expected-refused
  command.
- **Test volume.** Claude adds one new test file (`test/shellGuard.test.ts`,
  the four-vendor matrix) and extends seven others. Codex extends the same
  files. Both add only focused coverage, and neither refactors unrelated code.

### Findings

**F1 — claude/cursor `src/shellGuard.ts:549` and `:569`. The probe cannot record from sandboxed harnesses.**
- *Rule:* evidence produced in the agent's shell tool must be writable from
  that tool's sandbox. Otherwise verification fails for exactly the agents the
  issue measured.
- *Failure:* `runContainmentProbe` writes `issue-N/agent-lifecycle.json` (plus
  its `.lock`) and `journal.jsonl` under the owner runtime. The generated
  launcher starts these harnesses sandboxed:
  - codex with `--sandbox workspace-write`;
  - cursor with `--sandbox enabled`.

  Each is granted only four paths: the completion mailbox, `responses/`,
  `inputs/`, and `worktrees/` (`scripts/lib/launcher.sh` `coord_grant`). From a
  Codex or Cursor shell tool, both `coord containment-probe` and the
  `--refusal-ran` tail therefore fail to write. Coverage stays `unverified` for
  those agents permanently, and a deny the harness ignored is never detected
  there. Cursor is the agent whose bypass the issue measured.
- *Smallest illustrative test:* run `runContainmentProbe` with the issue root
  `chmod 0500`. Assert that the observation still becomes visible in
  `coord status` after the next coordinator tick. This fails today. Codex's
  clone-local mailbox (`.coord/` is inside the workspace grant) would pass.

**F2 — claude/cursor `src/shellGuard.ts:322`. `cd` leaks out of subshells and pipelines.**
- *Rule:* the working directory a git call runs in must follow shell scoping.
  A `cd` inside `( … )` or one stage of a pipeline does not change the parent
  shell's directory.
- *Failure:* measured on the compiled pins with cwd `/Volumes`:

  | Command | claude result | codex result |
  | --- | --- | --- |
  | `(cd /tmp) && git status` | `/tmp` | `/Volumes` |
  | `cd /tmp \| true; git status` | `/tmp` | `/Volumes` |

  Run from the clone, claude therefore classifies `(cd /tmp) && git status` as
  targeting `/tmp`, and the guard **allows** a `git status` that actually runs
  in the clone. This is a false allow within the supported literal syntax.
- *Smallest illustrative test:* add `"(cd /tmp) && git status"` to the deny rows
  of the matrix in `test/shellGuard.test.ts`.

**F3 — claude/cursor `src/steps.ts:79`. A restart mid-issue leaves no prompt to re-probe.**
- *Rule:* coverage must be re-verifiable after a harness restart. Repeating the
  probe for every action is not the fix.
- *Failure:* only the R1.join task carries the probe instruction. After a
  restart the session id changes, and `containmentCoverage` correctly returns
  `unverified`. No later action asks the agent to probe again; only the
  protocol text says to. Status therefore stays `unverified` for the rest of
  the issue, and the join-time warning never fires again.
- *Fix sketch* (a test cannot express it without a vendor restart): in
  `buildOrder`, append the probe note only when the agent's lifecycle
  `containment.probe.sessionId` differs from the current `sessionId`.

**F4 — codex `src/runLoop.ts:727`. The probe instruction is added to every action, not only after a session change.**
- *Rule:* the issue review says to repeat verification after a restart or
  configuration change, "not before every action". The code's own comment says
  the note is "conditional on a session/config change".
- *Failure:* the code is
  `const containmentNote = stepId !== "R1.join" ? CONTAINMENT_PROBE_NOTE : ""`.
  It is unconditional for every non-join step, and R1.join already includes the
  note through its task. Every plan, review, implement, ballot, and revise
  action therefore carries the eight-line probe request. An agent that follows
  it once per action adds a refused `git status` plus a `coord containment-probe`
  call to every action, which is the redundant tool use the issue exists to
  reduce.
- *Smallest illustrative test:* in `test/runLoop.test.ts`, assert that
  `buildOrder(..., "R2.plan", ...)` has no `"Containment check"` in its task
  when the lifecycle probe's session matches the current session.

**F5 — codex `src/shellGuard.ts:173`. Git after a control keyword is never checked.**
- *Rule:* a literal git invocation in a supported command must be classified.
  Unsupported syntax should cost precision, not hide later commands.
- *Failure:* when the head word is `if`, `while`, `for`, `{`, and similar,
  `dir = null` is set for the rest of the command. Every later segment then
  returns early. Measured: `if true; then git status; fi` yields no git calls,
  so the guard allows a clone `git status`. Claude finds it.
- *Smallest illustrative test:* add `"if true; then git status; fi"` and
  `"{ git diff; }"` as deny rows in codex's `test/shellGuard.test.ts`.

**F6 — codex `src/agentLifecycle.ts:57` and `:266`. Hook coverage depends on what the model reports, and is dropped without a session id.**
- *Rule:* "active" must rest on measured evidence and must be reachable for
  every supported vendor.
- *Failure:*
  - `hook=active` requires `--tool-result hook-denied` and a
    `--vendor-version` other than `unknown`, both typed by the agent. An agent
    that cannot see its CLI version, or misreads the tool output, leaves the
    agent permanently `unverified`.
  - `recordContainmentEvidence` returns state unchanged unless the entry
    already has a matching non-null `sessionId` (`:266`).
  - `guardShellRequest` records a denial only when the payload carries a
    session id.

  For a vendor whose lifecycle stream or guard payload lacks a session id
  (Antigravity's `PreToolUse` payload is unverified here), denials are never
  stored, so that vendor can never show `hook=active`.
- *Smallest illustrative test:* call `recordContainmentEvidence` on an entry
  with `sessionId: null` and a denial with a session. Assert that the evidence
  is retained, or that the status explicitly says "no session identity". Today
  it silently drops the evidence.

### Verdict

**Codex `39d7179c` is the stronger base.** It is the only design whose probe
evidence survives the Codex and Cursor sandboxes (F1), and its parser handles
subshell and pipeline scope (F2). Its two defects are each a few lines to fix:
F4 (make the per-action note conditional on a stale session) and F5 (control
keywords). F6 is a robustness gap rather than a false claim, because it fails
toward `unverified`.

**Claude `64ace635` and the identical cursor `da473de2`** have the stronger
parser matrix and measured, not self-reported, ignored-deny detection. However,
F1 makes their verification non-functional for the two sandboxed agents. F2 is
a false allow within supported syntax, and F3 leaves restarts unprompted.

I wrote `64ace635`. This assessment counts its defects against it.
