# Issue 142 implementation comparison

Bound implementation pins:

- claude: `64ace635ff399b21a136cf1f8ced9c526346fa45`
- cursor: `da473de2bc7a3e5cc65651d28abb3704ce5f12fb`
- codex: `39d7179cb242b64f791dc4dc2e5aada3e9a23b4f`

## Comparison

### Claude and Cursor are the same product tree

On every product path in the approved map (`scripts/lib/launcher.sh`, `src/*`, `test/*`, `templates/product/AGENTS.protocol.md`), Claude `64ace635` and Cursor `da473de2` are byte-identical. Cursor adopted the selected Claude plan implementation (shim check mode, four-vendor `agentHookSync` guards, `src/shellGuard.ts`, join-only probe, lifecycle coverage with `refusalRan`, doctor/status/protocol). Treat them as one candidate for selection.

### Shared strengths (all three)

- Single Git policy remains in `write_git_wrapper` with `COORD_GIT_POLICY_CHECK=1` check mode; no TypeScript fork of status/diff/show rules.
- Four-vendor shell-tool hooks installed through existing `agentHookSync` (Claude/Codex `PreToolUse`/`Bash`, Cursor `beforeShellExecution`, AGY `PreToolUse`/`run_command`) with a `/bin/sh` prefilter before Node.
- `COORD_GIT_DELEGATE` stripped when asking the shim for a verdict; `git-guard` fails open on internal errors.
- Join accept journals containment coverage and logs a WARNING when `hook` is not `active`.
- `coord status` and doctor surface shim/hook health; protocol text describes instruction + guard limits; hermetic `hook-verify` stays out of scope.

### Codex diverges on probe placement, evidence, and splitter safety

Codex `39d7179c` follows the same architecture skeleton but changes the probe/evidence model and ships a thinner splitter and test matrix. The differences below are selection-blocking relative to the selected plan.

### Findings

#### 1. Codex appends the containment probe note to every non-join action

**Where:** `src/runLoop.ts:727` in codex `39d7179c` (`const containmentNote = stepId !== "R1.join" ? CONTAINMENT_PROBE_NOTE : ""`), while `src/steps.ts:100` already embeds `CONTAINMENT_PROBE_NOTE` on `R1.join` only.

**Rule:** The selected plan adds the containment probe instruction only to R1.join; probes repeat after session/config change, not before every action (efficiency goal of the issue).

**Concrete failure:** Plan, review, implement, and later actions all receive the probe text (inverted condition). Digests change and agents are told to re-run `git status` / `containment-probe` on every step, multiplying the redundant tool use this issue exists to stop. Join still gets the note from `STEP_DEFINITIONS`; every other step gets it from `orderInternal`.

**Smallest test:** Assert an ordered `R2.plan` action task does not contain `Containment check` / `containment-probe`, while `R1.join` does. Claude/Cursor already keep the note only on the join task (`steps.ts:104` in `64ace635` / `da473de2`).

#### 2. Codex can treat `$(git …)` as a real git invocation

**Where:** `src/shellGuard.ts:94–117` in codex `39d7179c` (lex treats unquoted `(` as an operator); collection around `206–210`. Contrast Claude `src/shellGuard.ts` dynamic-span handling and `test/shellGuard.test.ts:179` (`findGitInvocations("printf '%s' \"$(git status)\"", …) === []`).

**Rule:** The selected plan’s static splitter must mark `$` / backtick / `$(` command words as unanalyzable and allow them; never execute the text to classify it.

**Concrete failure:** A command such as `echo $(git status)` or `msg=$(git status)` can be denied even though `git` appears only inside command substitution. Agents performing legitimate shell composition then hit false denials.

**Smallest test:** Port Claude’s `$(git status)` allow-row into Codex’s `test/shellGuard.test.ts` matrix (today missing).

#### 3. Codex records `hookDenial` only for `git status --porcelain` in the clone

**Where:** `src/shellGuard.ts:259–260` in codex `39d7179c` (`probe = call.argv.join(" ") === "status --porcelain" && resolve(call.cwd) === resolve(input.clone)`; `recordContainmentEvidence` only when `probe`).

**Rule:** On any shim deny, record `hookDenial` (selected plan: deny → `recordContainmentEvidence` + journal). Coverage may use the join porcelain probe as the session’s proof that the harness honoured the deny, but evidence must not be gated on that argv alone.

**Concrete failure:** Denials of `git status`, `git diff`, or other refused reads never establish hook evidence. Unless the exact porcelain probe ran and was recorded, `containmentCoverage` stays inactive/unverified even when the guard is working.

**Smallest test:** Deny `git diff` under a session, then run a same-session probe; expect `hookDenial` present (Claude `test/shellGuard.test.ts` containment evidence cases).

#### 4. Codex coverage trusts an agent-reported `--tool-result` instead of harness behaviour

**Where:** `src/shellGuard.ts:275–296` and `src/steps.ts:83–90` in codex `39d7179c` (`--tool-result hook-denied|shim-refused|executed|unknown`). Claude/Cursor use in-process PATH resolution plus `--refusal-ran` when the expected refusal still executed (`src/shellGuard.ts` containment-probe / `src/agentLifecycle.ts:290–302` in `64ace635`).

**Rule:** Verify containment in the agent’s real shell tool; detect when a deny was emitted but not honoured. Do not let the agent’s self-label certify `hook=active`.

**Concrete failure:** An agent can claim `hook-denied` without a real refusal and appear contained, or omit honesty and leave coverage wrong—exactly the silent-misread problem the issue measured for PATH.

**Smallest test:** Prefer Claude’s suite: after a deny, probe with `--refusal-ran` / PATH bypass and assert `hook=inactive` (`test/shellGuard.test.ts:210–218` in `64ace635`).

#### 5. Codex Claude/Codex allow literal is `{}`, not empty output

**Where:** `src/shellGuard.ts:30–37`, `src/agentHookSync.ts` prefilter, and `src/cli.ts` git-guard allow path in codex `39d7179c`. Claude/Cursor `SHELL_GUARD_ALLOW` uses `""` for claude/codex (`src/shellGuard.ts:32–36` in `64ace635`).

**Rule:** Selected plan: Claude and Codex allow literal is empty (prefilter prints nothing / `:`), matching vendor “no objection” empty stdout.

**Concrete failure:** Vendors or docs that treat only empty stdout as allow may mis-handle a printed `{}`, diverging from the selected plan and from the Claude/Cursor install path.

**Smallest test:** Prefilter payload without `git` → empty stdout for claude/codex (Claude `test/agentHookSync.test.ts`).

### Ranking

1. **Claude `64ace635` / Cursor `da473de2` (tied)** — Best match to the selected plan: join-only probe, deny evidence for all refusals, `refusalRan` harness check, empty Claude/Codex allow, fuller splitter + matrix tests. Prefer either; they are the same product.
2. **Codex `39d7179c`** — Same skeleton, but Findings 1–4 break probe scope, static-analysis safety, and evidence honesty. Binding/mailbox extras are not enough to outweigh those defects.

### Selection recommendation

Select **Claude `64ace635ff399b21a136cf1f8ced9c526346fa45`** or **Cursor `da473de2bc7a3e5cc65651d28abb3704ce5f12fb`** (equivalent product). Do not select Codex unless Findings 1–4 are fixed and the probe/evidence model is realigned with the selected plan.
