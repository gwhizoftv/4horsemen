# Workflow algorithm — issue 382 (Cursor)

**Status: complete coordinator spec (proposal).** Not a registered `plan.md`.
Not authorization to implement until the owner accepts it.

This document is **self-contained**. Archived Cursor drafts are non-normative:
`workflow-algorithm-prior-pane-runner.md`,
`workflow-algorithm-rev2-file-nudge.md`.

---

# 1. Goals and non-goals

**Goal.** After start, the coordinator orders agent work, accepts a **submission
commit** as intent, verifies that commit contains the **required Git artifact**,
and advances gates — without agents inventing phase gates.

**Non-goals.** Unattended isolation; automatic merge; OS-enforced write
separation; quality judgment (peers and owner still own that).

---

# 2. Execution model

## 2.1 Premise

Harnesses prompt for permission frequently. Sessions stay interactive and
answerable. Headless/print is optional per harness, never the default.

## 2.2 Topology

```
Owner control plane
  terminal or tmux window "control"
    process: coordinator
    stdin/stdout: owner ↔ coordinator only

tmux session consensus-<n>
  pane per roster agent — interactive harness
  (recommended) window control — coordinator (persistence)

coord/
  mirror.git/
  issue-<n>/
    start.json
    cursors.json
    journal.jsonl
    agents/<agent>/
      action.md       # order: what artifact must appear
      complete        # submission: one line = commit SHA to evaluate
      render.log      # optional; human only
```

Coordinator uses `tmux` only as an external client to insert into **agent**
panes. Prefer running the coordinator under tmux so a closed laptop terminal
does not kill the driver.

## 2.3 The core contract (normative)

**Each action tells the coordinator exactly what Git artifact must result.**

Example `action.md` excerpt:

```markdown
---
actionId: issue-382:codex:R2.plan:1
stepId: R2.plan
agent: codex
requiredPath: .plans/issue-382/plan.md
evidence: plan-published
---

Publish your plan at:
.plans/issue-382/plan.md

When done, write your submission commit SHA (the commit that contains that
file on origin) as the sole contents of:
coord/issue-382/agents/codex/complete
```

**The completion file says:** “Evaluate **this commit** as my submission.”

Contents of `complete`: a single line, 40-hex git SHA (optional `commit `
prefix). No JSON. No empty file.

**The required-evidence check answers:** “Does this commit contain what this
action required?”

If `complete` contains `4ab89257…`, the coordinator:

1. Ensures that commit is reachable on `origin/issue-<n>/<agent>` (fetch into
   mirror if needed).
2. Runs the mechanical checks for this action **against that commit**, e.g.
   `git show 4ab89257:.plans/issue-382/plan.md`.
3. Specifically verifies:
   - the expected path exists in that commit;
   - it is the correct path;
   - it passes mechanical validation for this action;
   - any cited pin, input hash, round, or related commit field is correct.

**“Valid” means mechanically valid** per action + protocol schemas — not that
the work is high quality. Quality remains peer review and owner.

If validation fails, do **not** advance. Report something concrete, e.g.:

> Completion commit received, but `.plans/issue-382/plan.md` is missing.

Tip movement while the agent works is **liveness only**. Only a `complete` SHA
plus a passing check completes an action.

### Required evidence by action (summary)

| Action | Required evidence (mechanical) |
| --- | --- |
| Join | Valid join JSON at the join path with correct issue session, agent, baseline, common digest |
| Plan | `plan.md` exists with mechanically required sections |
| Plan ballot | Valid ballot JSON citing expected plans/reviews and input hash |
| Implementation | Ready signal valid; cites a pushed **product** commit within the approved file map; pin ≠ signal commit |
| Comparison | Comparison doc (and later ballot) cite the exact implementation pins |
| Revision | Revision-ready cites correct round and revision commit; pin ≠ signal commit |
| Consensus review | Ballot cites the exact revision pin and a valid disposition |

Full predicate table: §5.

## 2.4 Intent and proof (neither alone)

| `complete` has SHA? | Checks on that SHA | Coordinator |
| --- | --- | --- |
| no | — | Wait — working |
| no | (tip happens to look complete) | **Wait** — may still be mid-correction |
| no, harness dead, idle past threshold | tip/evidence complete | Advance or escalate (pushed-then-died escape) |
| yes | pass | Clear `complete`; advance agent cursor |
| yes | fail | Clear `complete`; rewrite action with concrete outstanding[]; re-order |

## 2.5 Channels

| Channel | Direction | Carries |
| --- | --- | --- |
| `action.md` | coordinator → agent | Order + `requiredPath` / evidence id |
| tmux insert | coordinator → agent pane | Short “read action.md” nudge |
| `complete` (file write) | agent → coordinator | Submission commit SHA |
| Poll `complete` (~1s) | coordinator | Detect intent |
| Origin | agent → everyone | Bytes at that SHA |

**No `coord done` required.** The agent creates `complete` with a shell write
(path given in `action.md`). A helper binary is optional sugar only.

**No `coord status` required.** Owner uses coordinator logs, `cursors.json`, or
tmux attach. A status command is optional UX later.

| Direction | Content | Wake |
| --- | --- | --- |
| Coordinator → agent | `action.md` | tmux insert (when nudge allowed) |
| Agent → coordinator | `complete` with SHA | **Poll only** — never `wait-for` |

### Rejected: `tmux wait-for`

`wait-for -S` toggles when no waiter is present (measured tmux 3.7b). Two
completion signals can wedge the next wait forever. Poll `complete`.

### Rejected: empty `complete` / tip-only verify

Evaluating “whatever tip is now” races intermediate pushes. The submission SHA
freezes which commit to judge.

### Rejected: publishing the completion receipt on the agent branch

A receipt that must be pushed fails in the same breath as a failed push of the
work. Keep `complete` on local `coord/` disk; the SHA inside points at origin.

## 2.6 Delivery modes and idle detection

| Mode | Order delivery | Intent |
| --- | --- | --- |
| **nudge** | Write `action.md` + tmux insert | Agent writes `complete` with SHA |
| **pull** | Agent reads next `action.md` (via `coord next` or reading the fixed path) | Same `complete` file |

**Idle detection blocks nudge**, not pull:

| Harness | Nudge |
| --- | --- |
| Claude Code (mid-turn can queue) | Allowed under supervision |
| Codex / Cursor / Antigravity | **Disabled** until idle fixtures pass — pull-only or owner types the nudge |

## 2.7 Loop

```
1. Coordinator writes action.md (requiredPath + instructions)
2. Nudge if allowed and idle; else await pull / owner
3. Agent works; may push many times
4. Agent pushes the commit that contains the required artifact
5. Agent writes that commit SHA into agents/<agent>/complete
6. Coordinator poll → fetch SHA → isSatisfied(action, sha)
7. Pass → clear complete, advance
8. Fail → clear complete, report concrete outstanding, re-order
```

## 2.8 Insertion rules

1. `load-buffer` + `paste-buffer` for text.
2. No insert while owner is typing in that pane.
3. Foreground process must be the harness.
4. Idle enough (§2.6).
5. Never workflow authority.

---

# 3. Minimal CLI surface

Only what the loop needs. **Not** required: `done`, `status`.

| Command | Who | Behavior |
| --- | --- | --- |
| `coord start <n> --profile …` | owner | `start.json`, cursors, journal, tmux agents, harnesses |
| `coord run` | owner | Main loop: poll `complete`, verify SHA, order, nudge, gates |
| `coord next` | agent (pull mode) | Print current `action.md` path/body for this agent; or “none yet” |
| `coord answer …` | owner | Signed owner decisions when auto path fails |
| `coord pause` / `resume` / `restart-action` / `abandon` | owner | Control |

**Home:** `automation/` (shared package with today’s automation CLI is fine).
**PATH:** `coord next` (if used) must resolve inside agent panes. Creating
`complete` does **not** require `coord` on PATH — only a writable path to
`coord/issue-<n>/agents/<agent>/complete` (absolute path in `action.md`).

Optional later: `coord done <sha>` as sugar that writes the file; `coord status`
as sugar over `cursors.json`. Neither is part of the protocol.

---

# 4. Operational files

## 4.1 `start.json`

```jsonc
{
  "issue": 382,
  "issueSessionId": "issue-382:<baselineSha>",
  "baselineSha": "<40-hex>",
  "profile": "solo" | "reviewed" | "consensus",
  "roster": ["antigravity", "claude", "codex", "cursor"],
  "baseBranch": "main",
  "maxRevisionRounds": 5,
  "prPolicy": "owner-only" | "coord-open-unmerged",
  "automationDigest": "<hex>",
  "automationDigestScheme": "v3",
  "trustedSourceCommit": "<40-hex>",
  "createdAt": "<ISO-8601>",
  "authority": { "kind": "owner", "ownerKeyId": "owner", "signature": "<base64>" }
}
```

## 4.2 `cursors.json`

```jsonc
{
  "issueCursor": { "gateId": "gate-2-plans", "round": null },
  "agents": {
    "codex": {
      "stepId": "R2.plan",
      "actionId": "issue-382:codex:R2.plan:1",
      "status": "ordered" | "running" | "intent" | "verifying" | "waiting-peer" | "waiting-input" | "paused" | "complete" | "failed" | "harness-gone",
      "attempt": 1,
      "delivery": "nudge" | "pull" | "both",
      "tmuxTarget": "consensus-382:codex.0",
      "submissionSha": null,
      "outstanding": [],
      "updatedAt": "<ISO-8601>"
    }
  }
}
```

## 4.3 `journal.jsonl`

Append-only events: `action-prepared`, `nudged`, `intent-seen` (with SHA),
`verify-result`, `gate-advanced`, `owner-answer`, `paused`, …

## 4.4 `action.md`

Must include at least:

- `actionId`, `stepId`, `agent`
- `requiredPath` — primary path to check via `git show <sha>:<requiredPath>`
- `evidence` — predicate id from §5
- Human instructions naming that path and the `complete` file path

## 4.5 `complete`

```
<40-hex-sha>
```

or

```
commit <40-hex-sha>
```

Presence of a parseable SHA = intent. Malformed `complete` → clear it and
re-order with “complete must be a commit SHA”.

## 4.6 Restart recovery

| State | Rebuild |
| --- | --- |
| Issue cursor | Earliest gate whose denominator fails over origin (evidence wins over stale file) |
| Agent cursor | `action.md` present ⇒ that action outstanding; `complete` with SHA ⇒ `intent` / re-verify; no `action.md` ⇒ idle, mint next action for role |
| Journal | Keep appending |

---

# 5. Evidence predicates (`isSatisfied`)

## 5.1 Evaluation target

```
isSatisfied(action, submissionSha) -> { ok, outstanding[] }
```

Always evaluate **blobs in `submissionSha`**, not “current tip” (except the
pushed-then-died escape, which may inspect tip when there is no submission).

```
fetch submissionSha into mirror (must be on origin/issue-<n>/<agent>)
blob = git show <submissionSha>:<requiredPath>   # or missing
```

Failed fetch / unknown SHA → outstanding: `submission-not-on-origin`.

## 5.2 Mechanical checks (every origin-backed action)

1. Expected file exists in `submissionSha`.
2. Path equals `action.requiredPath` (and any secondary paths the evidence id lists).
3. Schema / section rules for that evidence id pass.
4. Referenced pins, input hashes, rounds match the action’s bound inputs.

## 5.3 Per-step predicates

Paths use today’s templates; semantics are normative.

### R1 Join — `join-published`

- Path: `.signals/issue-{issue}/joined-{agent}.json`
- Valid join JSON; session/agent/baseline/digest match `start.json`

### R2 Plan — `plan-published`

- Path: `.plans/issue-{issue}/plan.md`
- Required sections non-empty (file map, tests, alternatives/risks, conclusion —
  exact heading list in coordinator constants)

### R3 Review — `review-published`

- Path: `.plans/issue-{issue}/review.md`
- Required sections non-empty

### R3 Plan ballot — `plan-ballot-published`

- Path: `.plans/issue-{issue}/ballot-{agent}.json`
- Valid ballot; cites expected plan/review set; `inputSetHash` matches action

### R3 Verification / selection

- Verification JSON agrees with recomputation when retained
- Selection artifact has automated or owner authority citing `inputSetHash`

### R4 Implement — `implementation-pinned`

- Path: `.signals/issue-{issue}/implementation-ready-{agent}.json`
- Valid signal; `implementationCommitSha` = `pin` exists in history of this
  branch; `pin !== submissionSha` (signal commit is not the product pin);
  `baseline..pin` paths ⊆ approved file map

### R5 Compare / ballot

- Compare doc at required path; ballots cite each implementation pin and shared
  `inputSetHash`

### R6 Revision / consensus ballot

- Revision-ready cites round `k` and `revisedBranchHead`; pin ≠ signal commit
- Consensus ballot cites that pin; disposition ∈ `approve|revise|escalate`

### R7 Finalize

- Final head verifies against approved consensus SHA; deletion scope; checks green

### Profile filters

| Profile | Implementers | Skip |
| --- | --- | --- |
| `solo` | one agent | R3 R5 R6; use solo checks |
| `reviewed` | one designated | solo checks |
| `consensus` | all active | solo checks |

---

# 6. Steps and gates

| Step id | evidence id |
| --- | --- |
| `R0.bootstrap` | local advisory only |
| `R1.join` | `join-published` |
| `R2.plan` | `plan-published` |
| `R3.review` | `review-published` |
| `R3.plan-ballot` | `plan-ballot-published` |
| `R3.verify-selection` | verification (if retained) |
| `R3.publish-selection` | selection published |
| `R4.implement` | `implementation-pinned` |
| `R5.compare` | compare published |
| `R5.compare-ballot` | compare ballot |
| `R5.reviser-auth` | reviser authorized |
| `R6.revise` | `revision-pinned` |
| `R6.ballot` | consensus ballot |
| `R6.declare` | consensus declared |
| `R7.finalize` | finalization verified |

Gates: `gate-1-join` … `gate-7-finalized` as denominators over the profile.

---

# 7. Coordinator verbs

| Verb | Means |
| --- | --- |
| **Order** | Write `action.md` with `requiredPath` + evidence id; optional nudge |
| **Watch** | Poll `complete`; liveness |
| **Verify** | Parse SHA from `complete`; `isSatisfied(action, sha)` |

Never write agent clones.

---

# 8. Interrupts

Escalation; owner answer; amendment; owner attach for permissions; pause/resume/
restart-action/abandon; capability-loss notify (no silent roster shrink).

---

# 9. Implementation sequencing

1. Poll + SHA verify + `action.md`/`complete` paths for all agents (pull or
   owner-typed nudge).
2. Idle fixtures before enabling automatic nudge on non-Claude harnesses.
3. Coordinator under tmux for canaries.

---

# 10. Acceptance for this spec

- Every action names a `requiredPath` and evidence id.
- `complete` carries a submission commit SHA; verify uses that commit, not tip.
- Failure messages name the missing/invalid artifact concretely.
- `coord done` and `coord status` are **not** required.
- Nudge enablement is gated on idle measurement (§2.6).
