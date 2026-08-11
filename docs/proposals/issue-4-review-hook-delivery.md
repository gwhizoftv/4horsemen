# Review of issue #4 — *Installable coordination deploy*

**Reviewer:** Claude
**Target:** issue #4 as of 2026-08-11
**Status:** supersedes my earlier `docs/proposals/portable-agent-setup.md`, which
duplicated #4 without knowing it existed.

## Position

**Adopt issue #4.** It is more complete than my draft on the things that matter
operationally — the managed `.gitignore` block, `--ignore-mode=exclude`, the
dry-run requirement, the product-side removal table, the `consensus-ai` naming
debt, and emitting the workspace config under `coord-root` rather than the
product tree. I am not restating any of that.

This review contributes:

1. **The two-mode rule** (§0) — owner-stated, agreed by Cursor, and worth
   recording in #4 as a non-negotiable because it decides several open questions.
2. **Evidence** that the drift #4 predicts has already happened (§1).
3. **A failure-mode analysis** of hook delivery its options do not consider (§2),
   including a verified defect where committed hooks would block every commit in
   a human's clone (§2a).
4. **A third option** for the hook fork (§3), plus answers to all five open
   questions (§4).
5. **Language support** (§4a) — the driver is language-agnostic, the hooks are
   not, and they fail open on a Rust or Go repo.
6. **Versioning** (§4b) — package identity and an install stamp.

---

## 0. The governing rule: one repo, two modes

Added after owner feedback and agreed with Cursor. **This should be stated in #4
as a non-negotiable, because it decides several of its open questions.**

> Coordination constrains **agents and the owner control plane**. It does not
> constrain the product's other developers. One developer must be able to work
> `testapp` from plain VS Code — no coordination, no Node, no new obligations —
> while another drives agents against the same repository.

Consequences, which the rest of this review is now written against:

| | Human clone of the product | Agent clone (`<product>-<agent>`) |
| --- | --- | --- |
| Hooks | **none** | branch ownership, commit prefix, `verify` |
| Identity config | none | `consensus.agentId`, `coord.installRoot` |
| Launcher | none | `start-<agent>.sh` |
| Day-to-day git | exactly as today | gated |

The enabling fact is that **git never activates hooks from a commit**.
`core.hooksPath` is per-clone *local* config, so committed hook files were always
inert for anyone who did not run setup. The problem was never that we constrained
other developers — it is that we put files in their tree that look like
obligations, and that any path which activates them turns their clone hostile
(see §2a).

Under this rule the target's permanent footprint can be **zero**:

| Artifact | #4 as written | Under the two-mode rule |
| --- | --- | --- |
| hook bodies / shims | committed to product | **`.git/hooks/` of each agent clone** — untracked by construction |
| `scripts/setup_*`, `lib/launcher.sh` | committed to product | coordination install only |
| `start-<agent>.sh` | clone, via product `.gitignore` | clone, via `.git/info/exclude` |
| agent tool ignores (`.claude/`, …) | committed `.gitignore` block | `.git/info/exclude` per clone |
| `verify` policy | — | coord-root workspace config |
| `AGENTS.md` | committed | opt-in `--commit-agents-md`; default untracked in clones |

So #4's `--ignore-mode=exclude` should be **promoted from fallback to default**,
and the managed `.gitignore` block becomes the opt-in for owners who want the
convention visible in the repo.

### The one footprint that cannot be zero — and why it is acceptable

`.plans/issue-N/`, `.signals/issue-N/`, and `.code-reviews/issue-N/` **must** be
committed and pushed. They *are* the evidence: the protocol is agents publishing
artifacts at exact commits and the coordinator reading blobs at those SHAs.

They are transient by design. R7 finalization is deletion-only cleanup of exactly
those prefixes, enforced by `verifyFinalization`, which rejects any change that is
not a deletion under the current issue's coordination paths. A developer on `main`
never sees them; they exist on agent branches during a run and are gone before the
merge-ready PR.

Worth stating in #4 explicitly — "does this litter my repo?" is the first question
a maintainer asks, and the answer is "only on agent branches, only until
finalization."

### What the rule does not solve, and should not

A human developer's commits are **ungated**. If someone pushes broken code to
`main`, that becomes the baseline the next `coord start` records. Coordination
cannot prevent this and should not try — it is the same exposure as any
repository. It does mean the recorded `baselineSha` is a snapshot of whatever
state `main` happened to be in, which belongs in the operator docs.

A human merging to `main` mid-run does not invalidate anything, since agents work
from the recorded baseline; it just means a real merge at PR time. Normal, not a
defect.

---

## 1. The drift is not hypothetical — it has already occurred

Issue #4 says the parallel trees "will diverge." They already have, after
exactly one downstream project:

```diff
$ diff coordination/githooks/pre-push testapp/githooks/pre-push
21c21
< workflow_critical_prefixes=("scripts/" "githooks/" "src/" "test/")
---
> workflow_critical_prefixes=("scripts/" "githooks/" "src/")
```

Every other tracked file is byte-identical:

| File | coordination vs testapp |
| --- | --- |
| `scripts/setup_common.sh`, `setup_claude.sh`, `fresh-issue.sh`, `lib/launcher.sh` | identical |
| `githooks/pre-commit`, `commit-msg`, `post-merge`, `post-commit`, `lib/identity.sh` | identical |
| `githooks/pre-push` | **differs — one line** |

`testapp`'s pre-push does not treat `test/` as workflow-critical, so its e2e gate
does not fire for test-only changes. Nobody decided that; it is one line of
inherited difference in the single file that decides what gets gated.

**Why this matters for open question 2.** Option A (sync copies into the product)
is exactly today's mechanism plus a `--check` mode. It is defensible — with
`coord doctor --check` mandatory in product CI, this divergence would have been
caught. But the divergence *did* happen precisely because nothing forced anyone
to look, and Option A's correctness depends entirely on a check that a product
repo can decline to run. The evidence above is one project's worth of that
dependency failing.

**A refinement worth adopting regardless of which option wins:** this particular
divergence should not be drift at all. Whether `test/` is workflow-critical is a
*project fact*. Put it in the emitted workspace config —

```jsonc
"workflowCriticalPrefixes": ["src/", "test/", "scripts/", "githooks/"]
```

— and have the hook read it. Then coordination and testapp can legitimately
differ, the difference is declared and reviewable, and the hook body stays
identical everywhere. #4's file map already notes the product pre-push "should
call **product** checks"; this is the same idea applied to the gating list.

---

## 2. The failure mode #4's options do not analyse

`core.hooksPath` is all-or-nothing. **If it points at a directory that does not
exist, git runs no hooks and reports nothing** — no warning, no non-zero exit.

That is decisive for the "inject-mode" #4 lists as *discouraged* under hooks
point 3, and it is the unstated risk in Option B. A coordination checkout that
is moved, renamed, or not yet cloned turns every guard in the system off
silently: no branch-ownership check, no `check:fast`, no e2e gate, no commit-msg
prefix enforcement. The operator sees successful commits and pushes.

For this project that is the worst available failure. The entire driver is built
around never mistaking absence for success — transient fetch failures must not
become missing-artifact verdicts, a `complete` file must be parseable to count
as intent. Hook delivery should hold the same line.

#4 is right to discourage inject-mode. My point is that the *reason* is stronger
than "discouraged", and that it also rules out any design where the product's
hooks can become a no-op without saying so.

---

## 2a. Committed hooks are a loaded gun: `identity.sh` fails closed on a human clone

Cursor's review of the two-mode rule proposes gating enforcement on "am I an
agent?" — only enforce when `consensus.agentId` is set. That is the right
instinct, and the current code does **the exact opposite**.

`githooks/lib/identity.sh` ends by calling `consensus_load_identity` at source
time, and every hook body sources it as its first act. With `consensus.agentId`
unset:

```
HOOK BLOCKED: this clone has no local consensus.agentId; agent identity is unresolved.
  Hooks never fall back to a default identity.
  Fix: from the master repo run this clone's setup script (scripts/setup_<agent>.sh) …
```

The file's own comment states the intent: *"unresolved identity fails the hook
closed."* For an agent clone that is correct and should stay. For a human clone it
is the failure Cursor warns about, in its strongest form — **every commit
blocked**, with remediation instructions telling a developer who has never heard
of coordination to run an agent setup script.

Today this is latent, because humans do not set `core.hooksPath`. But shipping the
files into the product master means one `git config core.hooksPath githooks` — run
by a curious developer, a tooling default, a copied clone, or a future git
version — converts a working repository into a blocked one. That is a loaded gun
in someone else's tree, and it is a second, independent argument for §0's
zero-footprint placement.

### Proposed change

Separate *"is this an agent clone?"* from *"is this agent's identity valid?"*:

```bash
consensus_load_identity() {
  local id label
  id="$(git config --local --get "$consensus_agent_id_key" 2>/dev/null || true)"

  # Not an agent clone. Coordination has no business here.
  if [[ -z "$id" ]]; then
    CONSENSUS_AGENT_CLONE=false
    return 0
  fi

  CONSENSUS_AGENT_CLONE=true
  # …existing validation: malformed id or missing label still fails closed…
}
```

Each hook body then returns early when `CONSENSUS_AGENT_CLONE` is false, passing
through to whatever the product already does.

**This is defence in depth, not the primary mechanism.** With §0's placement the
hooks only exist in agent clones, so `agentId` should never be unset where they
run. The gate matters for the transition period, for `--vendor` mode, and for any
tree where hooks might end up shared — precisely the cases where a silent hostile
failure would otherwise be possible.

Note the residual trade if hooks *are* shared: an agent clone whose local config
got wiped would then pass through silently instead of blocking, losing every gate.
That is the silent-skip class again. **Placement resolves it**: hooks living in
`.git/hooks/` of an agent clone mean their presence *is* the signal, so unset
identity there remains a hard error while a human clone simply has no hooks at
all. You get both properties instead of choosing between punishing humans and
silently degrading agents — which is the strongest argument in this review for
§0's placement over #4's Option A.

---

## 3. Proposed answer to open question 2: Option C

#4 frames the fork as binary: vendor the files (A) or call `coord` from PATH (B).
There is a third shape that gets Option A's "files are present" property and
Option B's "one canonical body" property at once.

**Commit a generated shim per hook; keep the bodies central.**

```bash
#!/usr/bin/env bash
# Generated by `coord setup-workspace`. Do not edit.
# Bodies live in the coordination install; edit them there.
set -euo pipefail
install_root="$(git config --get coord.installRoot || true)"
if [[ -z "$install_root" || ! -d "$install_root/githooks" ]]; then
  echo "HOOK BLOCKED: coordination is not installed for this clone." >&2
  echo "  Expected install root: ${install_root:-<unset>}" >&2
  echo "  Run: coord setup-workspace --product $(git rev-parse --show-toplevel) …" >&2
  exit 1
fi
exec "$install_root/githooks/$(basename "$0")" "$@"
```

Scored against #4's own criteria:

| Property | A (sync copies) | B (PATH) | **C (shim)** |
| --- | --- | --- | --- |
| Files present in a fresh clone | yes | no | **yes** |
| One canonical body | no — *n* copies | yes | **yes** |
| Drift possible | yes (observed) | no | **no** |
| Missing install behaviour | works offline | varies | **blocks, with the fix printed** |
| Product commits to review | full hook diffs | none | **~15 lines, once** |
| Upgrade cost | *n*-repo PR train | none | **none** |

The `basename "$0"` dispatch means one shim body serves all five hooks, and it
contains no policy, so regenerating it after a coordination upgrade is a no-op
in practice. `coord.installRoot` is per-clone git config, which is what the
agent clones need anyway — different clones may point at different coordination
checkouts.

**The honest trade.** A and C optimise different resiliences. Option A means *a
contributor without coordination can still work*. Option C means *nobody can
work unguarded*. Which is correct depends on who clones the product repo:

- For `testapp` and any dogfood target — four known agents, coordination always
  present — **C is clearly right**, and its blocking message is a feature.
- For a product repo with outside contributors, **A is right**, because C would
  make `git commit` fail for someone who has never heard of coordination.

So: **C as the default, A available as `--vendor`**, stamped with the source
commit and flagged stale by `coord doctor`. That preserves #4's Option A intent
for the case that needs it without making every project pay for it.

### Revision after the two-mode rule: keep the property, move the file

Cursor objects that a fail-closed shim must not sit on the product's default
branch, because it "would punish every normal clone." **That objection is correct
about placement and wrong about the property**, and the two are separable.

The shim's value is that a missing install root **blocks loudly** instead of
silently disabling every gate (§2). That value is entirely about agent clones —
an agent whose install root vanished must not keep committing ungated. It says
nothing about human clones, which should have no hooks at all.

So Option C survives, relocated:

| | Original C | **Revised C** |
| --- | --- | --- |
| Shim location | committed to product `githooks/` | **`.git/hooks/` of each agent clone** |
| Human clone | file present, inert until hooksPath set — but hostile if ever set (§2a) | **file absent; nothing changes for them** |
| Agent clone | fail-closed | fail-closed, unchanged |
| Written by | `setup-workspace`, committed by a human | `setup-workspace`, never committed |
| Product diff | ~15 lines × 5 hooks | **none** |

`.git/hooks/` is the default hooks path, so no `core.hooksPath` config is needed
at all; it is untracked by construction; and `git pull` cannot clobber it, which
**removes the post-merge regeneration coupling for hooks entirely** — only
`start-<agent>.sh` still needs regenerating. That collapses #4's open question 2
further than any of A/B/C did: under this placement nothing lands in the product
tree either way, so the vendor-versus-link debate applies only to `--vendor`
mode, where an owner has explicitly asked for it.

This also resolves the post-merge/launcher coupling #4 flags in the same
question: under C the launcher template resolves from `$install_root`, so
`scripts/lib/launcher.sh` never needs to be synced into the product at all.
Under `--vendor` it is synced alongside the hook bodies, exactly as #4's
Option A describes.

---

## 4. Answers to the remaining open questions

**Q1 — commit synced `githooks/` on the product master vs inject-only per clone?**
Commit on the master. Under Option C what gets committed is the shim, not the
bodies, so #4's recommendation stands with a much smaller diff. Inject-only is
ruled out by §2: a per-clone injected path that goes missing is the silent-no-hooks
case.

**Q3 — TypeScript CLI subcommand vs bash?**
TypeScript, as #4 prefers. Two reinforcing reasons: the containment logic must be
*the same code* `coord start` uses (`resolveSafeCoordRoot` / `containedPath`), not
a bash reimplementation that can drift from it; and `pnpm check` then covers the
installer, which #4's acceptance criteria already require. Keep a thin
`scripts/setup-workspace.sh` façade for discoverability, mirroring the existing
`coord` wrapper.

**Q4 — allow `--clone-root`, or always siblings?**
Default to siblings (`<parent>/<product>-<agent>`), matching today's
`common_detect_repo`. Accept `--clone-root` but validate it with the same
containment rules as `--coord-root`: it must not be inside the product master,
inside `coord-root`, or contain either. Without that check `--clone-root` becomes
a new way to produce the layout `coord start` already refuses.

**Q5 — should ignore bootstrap patch `AGENTS.md` / editor excludes, or only `.gitignore`?**
Only `.gitignore` (plus `--ignore-mode=exclude`). `AGENTS.md` is project content
with a different lifecycle — #4 already has the right rule, generate only when
absent and never overwrite without `--force`. Editor excludes are per-developer
and do not belong to a repo-level installer.

---

## 4a. The installer is language-agnostic; the hooks are not, and they fail open

**This is the largest gap in #4 and it is not listed among its open questions.**

#4's premise is onboarding an arbitrary product codebase. The driver delivers on
that — nothing in `paths`, `protocol`, `steps`, `state`, `action`, `mirror`,
`evidence`, `machine`, `runLoop`, or `cli` knows what language the product is
written in. Evidence predicates check git paths and Markdown/JSON artifacts;
`checks[].argv` is already an explicit argument vector, so `["cargo", "test"]`
or `["go", "test", "./..."]` work today with no change.

The hooks do not.

```bash
# githooks/pre-commit:63
if [[ -f package.json ]]; then
  # …every project check lives inside this branch…
fi
exit 0
```

A Rust or Go product repo has no `package.json`. The hook runs the
branch-ownership and identity checks — those are generic and fine — and then
**exits 0 without running any project verification at all, silently.** No
warning, no "I do not know how to check this project type."

`pre-push:148` is the same shape: the e2e gate requires `-f package.json && -f
pnpm-lock.yaml` before it will run anything.

This is the same failure class as the missing-install case in §2, and as the
absent `test:e2e` script found during issue 1: **a guard that is skipped reports
success.** Onboarding a Go server under #4 as written would produce a workspace
that looks fully configured, enforces branch ownership correctly, drives the
whole R1–R7 workflow correctly, verifies evidence at exact commits correctly —
and never once compiles or tests the product locally.

### Node assumptions, enumerated

| Location | Assumption | Effect on a Rust/Go product |
| --- | --- | --- |
| `githooks/pre-commit:63-135` | `package.json` + pnpm/npm/yarn lockfile | all checks skipped, exit 0 |
| `githooks/pre-push:148` | `package.json` + `pnpm-lock.yaml` + `test:e2e` script | e2e gate never fires |
| `githooks/pre-push:22` | `workflow_critical_files` are Node manifests | `Cargo.toml`/`go.mod` changes not workflow-critical |
| `scripts/setup_common.sh:80` `common_ensure_node_version` | `.nvmrc` + nvm in the **product** | noise or wrong toolchain; irrelevant to the product |
| `scripts/setup_common.sh:246-249` `common_detect_project` | sniffs `package.json` for react / react-native | no project type detected |
| generated `AGENTS.md` (`setup_common.sh:188`) | "For pnpm repos, use pnpm…" | instructions that do not apply |

Note the split: `common_ensure_node_version` is legitimate for the **coordination
install** (the driver runs on Node 26) and wrong for the **product**. #4's
installer must not conflate them.

### Whose tests are these? Three tiers, only one of which coordination owns

#4 does not state this anywhere, and it is the first question an operator asks.
**Coordination adds no tests to the target repository.** It runs the target's
own, at two distinct tiers that are easy to conflate:

| Tier | Whose tests | Where it runs | On failure |
| --- | --- | --- | --- |
| 1 | **coordination's** (`coordination/test/`) | the driver's own repo | blocks coordination's commits. Never installed into a target. |
| 2 | **target's**, via hooks (`verify`) | the agent's clone, working tree as-is | blocks that agent's commit or push |
| 3 | **target's**, via `checks[].argv` | throwaway worktree at the exact final commit | **blocks PR creation** (required behavior 13) |

Tiers 2 and 3 run the same product suite and answer different questions. Tier 2
is fast feedback in a dirty worktree and can be defeated by uncommitted state or
a stale dependency tree. Tier 3 is hermetic — materialised from the mirror at the
exact commit consensus approved, with results journaled — and is the one that
gates publication. Both should exist; neither substitutes for the other.

### The coupling being removed: coordination currently dictates script *names*

The reason this needs saying is that today the hooks do not run "the target's
checks" — they run **scripts the target must name coordination's way**:

```bash
# githooks/pre-commit
grep -q '"check:fast"[[:space:]]*:' package.json   # then "check", then lint/typecheck/test
# githooks/pre-push
grep -q '"test:e2e"[[:space:]]*:' package.json
```

`testapp` has a `check:fast` script because the hook looks for that literal
string, not because the project chose the name. That is coordination reaching
into the target's build configuration, and it is undocumented.

It has already failed in practice. **`testapp` has no `test:e2e` script at all**,
so its pre-push e2e gate cannot fire — independently of the
`workflow_critical_prefixes` divergence in §1. One onboarded repo, two unrelated
silent skips, neither visible to the operator.

### Proposed change: declare verification, and fail closed without it

Move project verification out of lockfile sniffing *and out of script-name
matching* into the emitted workspace config, where `checks[].argv` already lives.
The target keeps whatever script names, Makefile targets, or bare binaries it
already uses; coordination stops having an opinion.

```jsonc
{
  "project": "myserver",
  "toolchain": "go",
  "verify": {
    "precommit": [
      { "name": "vet",  "argv": ["go", "vet", "./..."] },
      { "name": "test", "argv": ["go", "test", "./..."] }
    ],
    "prepush": [
      { "name": "build", "argv": ["go", "build", "./..."] }
    ]
  },
  "workflowCriticalPrefixes": ["cmd/", "internal/", "pkg/"],
  "workflowCriticalFiles": ["go.mod", "go.sum"],
  "checks": [
    { "name": "test", "argv": ["go", "test", "./..."] }
  ]
}
```

The hook body then becomes ecosystem-neutral: read the declared argv, run each
in order, block on the first non-zero exit. `checks` (finalization, run by the
coordinator in a throwaway worktree) and `verify` (local, run by hooks) stay
separate because they answer different questions at different times.

Three rules make this safe:

1. **No declaration is an error, not a skip — in an agent clone.** If `verify`
   is absent the hook blocks and says so. Opting out must be explicit —
   `"verify": { "precommit": [], "prepush": [] }` — so that a product with no
   local checks is a recorded decision rather than an accident of file layout.
   Per §0 this governs **agent clones only**; a human clone has no hooks and is
   unaffected whether or not `verify` exists.
2. **`coord doctor` preflights the toolchain.** Verify `argv[0]` resolves for
   every declared command at install time, not at the operator's first commit.
   The existing "pnpm-lock.yaml exists but pnpm is not available" block is the
   right instinct — generalise it and move it earlier.
3. **Keep lockfile sniffing only as a scaffolding default.** `coord
   setup-workspace` may *propose* `verify` for a recognised ecosystem (pnpm,
   cargo, go, make) and write it into the config for review. The hook itself
   must never sniff.

`common_ensure_node_version` then applies to the install root only, the
`AGENTS.md` template takes its build guidance from `toolchain`/`verify` instead
of hardcoding pnpm, and `common_detect_project`'s react sniffing either becomes
a config field or goes away.

### What this deliberately does not do

Nothing here requires that new product code **arrives with tests**. An agent can
implement a feature with no new tests and every tier above passes trivially,
because the target's existing suite still goes green.

That is by design, and the adopted plan says so under its risks: *"Mechanical
validity can be mistaken for quality. Keep the distinction explicit in output and
require plan review, comparison, ballots, or owner decisions according to
profile."* Whether a change is adequately tested is an R3 review, R5 comparison,
and R6 ballot judgement. No evidence predicate can decide it, and one that tried
would be measuring the wrong thing.

If mechanical pressure is wanted there, the correct shape is a **target-declared
check**, not a coordination-invented rule:

```jsonc
{ "name": "coverage", "argv": ["./scripts/coverage-gate.sh", "--min", "80"] }
```

Ownership stays where it belongs: the target sets its own quality bar,
coordination runs it and blocks on a non-zero exit. This is the same principle as
the rest of §4a — coordination supplies the mechanism, the product supplies the
policy.

### Answer to "is this suitable for a Rust or Go repo?"

**The driver: yes, today, unchanged.** The coordination protocol is about git
commits, published artifacts, and argv — none of which is language-specific. The
operator's machine needs Node to run `coord`; the product does not.

**The setup and hook layer: not yet, and it would fail quietly rather than
loudly.** Everything in this section is what stands between the current state and
a truthful yes. None of it is deep — it is roughly one hook rewrite plus config
plumbing — but it must land before a non-Node repo is onboarded, or the
onboarding will look successful and be hollow.

---

## 4b. Versioning: package identity and the install stamp

#4 mentions "package display strings should be coordination-native" under naming
debt. Two concrete decisions belong in it.

### Package identity

All four branches still carry the scaffold's identity:

```json
"name": "@consensus-ai/coordination",
"version": "0.0.0"
```

`@consensus-ai` is stale provenance — the adopted plan makes this a standalone
repository and "the forward path". `0.0.0` is a placeholder.

Proposed: rename to `coordination` (or `@gwhizoftv/coordination` if a scope is
wanted later) and set `0.1.0` when issue 1 merges. The package stays
`private: true`; this is about honest identity and having something for the stamp
below to reference, not about publishing.

**Not proposed: adopting a package manager for distribution.** Coordination has
one runtime dependency (`zod`), the consumers are local clones on one machine,
and the interface is still being revised. More importantly, the target repo must
never be made to depend on a Node toolchain — a Go repo whose `git commit`
requires `pnpm install` is precisely the coupling #4's non-goals reject. The
install-root indirection keeps the operator's install and the product's reference
to it separate; that separation is what should be preserved, and it is what makes
adopting a package manager later a one-line change to how `installRoot` resolves.

### Install stamp

Record what a product was installed against, in the emitted workspace config:

```jsonc
"coordination": {
  "installRoot": "/Volumes/4TB-SOURCE/REPOS/coord/coordination",
  "version": "0.1.0",
  "commit": "8c2ab24…",
  "installedAt": "2026-08-11T17:40:00Z"
}
```

This lives in the **coord-root workspace config, not the product tree**. An
earlier draft of this review argued for committing project policy so it would be
versioned with the code it verifies; §0 retires that argument. The policy governs
agents only, and agent work is already gated by tier 3 — hermetic, at the exact
approved commit, owner-controlled — so tier 2 is fast feedback rather than the
authority. Keeping it out of the product also means no agent can supply argv that
the coordinator or another agent's clone will execute, which removes a privilege
escalation that a committed `verify` would have opened.

`coord doctor` compares `commit` against `git -C $installRoot rev-parse HEAD` and
reports an upgrade nobody reviewed. That is the property a lockfile would give,
obtained without a registry — and if coordination is ever published, `version`
becomes the semver and nothing else in the design changes.

This directly mitigates the risk centralisation creates: with one canonical hook
body, a bad coordination update reaches every onboarded project at once. The
stamp makes that upgrade visible and, with `--pin`, opt-in. Without it, "which
coordination is `testapp` running against?" has no answer — the same class of
problem as the `pre-push` divergence in §1, one level up.

---

## 5. Additional acceptance criteria to add to #4

#4's list does not currently assert the property §2 is about:

- [ ] With `coord.installRoot` unset, or set to a missing directory, a commit and
      a push in an onboarded product clone are **blocked** with a message naming
      the remediation command — never silently unhooked.
- [ ] `coord doctor` exits non-zero for each drift class separately: missing
      install root, unset hooks path, stale shim, missing launcher, missing
      identity config, and (in `--vendor` mode) hook bodies differing from the
      install.
- [ ] `coord setup-workspace` run twice produces no diff on the second run
      (#4 implies this for the ignore block; it should hold for the whole
      installer).
- [ ] The hook gating list is read from the emitted workspace config, and
      `coordination` and `testapp` can declare different values without editing
      any hook body.
- [ ] A test asserts the workspace config emitted by `setup-workspace` is
      accepted by `coord start` without modification — the two consumers cannot
      drift apart.
- [ ] **A non-Node product repo onboards end to end.** A Rust or Go fixture gets
      agent clones, hooks, and a config; a commit that fails the declared
      `verify.precommit` is **blocked**. This is the criterion that would have
      caught §4a.
- [ ] A product repo with no `verify` declaration **blocks** commits with a
      message naming the fix; an explicit empty `verify` allows them.
- [ ] `coord doctor` fails when a declared `argv[0]` is not on PATH, at install
      time rather than at first commit.
- [ ] No hook body branches on `package.json`, a lockfile name, or any other
      ecosystem marker — **and none greps the target for a script name.** A
      target whose checks are `make test` or a bare binary is verified exactly
      like a pnpm one.
- [ ] Tier 2 and tier 3 are separately observable: a target whose `verify` passes
      but whose `checks` fail in the clean worktree **blocks PR creation**, and
      the journal shows which tier failed.
- [ ] `testapp`'s pre-push e2e gate demonstrably fires after migration. It cannot
      today — no `test:e2e` script exists — so this is a regression test for the
      script-name coupling, not a hypothetical.
- [ ] The emitted config records the coordination version and commit, and
      `coord doctor` reports a drifted install root.
- [ ] **A human clone of an onboarded product is unaffected.** Clone the product
      normally, without running any coordination command: `git commit` and
      `git push` behave exactly as before onboarding — no hooks, no Node
      requirement, no "coordination is not installed" message. This is the
      executable form of §0 and should be the first test written.
- [ ] `setup-workspace` leaves **no tracked file** in the product master by
      default. Onboarding produces an empty `git status` in the product.
- [ ] With hooks present but `consensus.agentId` unset, the hooks pass through
      rather than blocking (§2a); with `agentId` set but malformed, they still
      fail closed.

---

## 6. One correction to #4's file map

The `githooks/post-merge` row says regeneration "must resolve launcher template
from a known coordination install path **or** from a copied
`scripts/lib/launcher.sh` under product." Worth making explicit: under Option C
the first branch is the only one, and under `--vendor` the second is. There is no
configuration in which both are live, and a design where post-merge tries one and
falls back to the other would reintroduce exactly the ambiguity — *which copy is
authoritative* — that this issue exists to remove.

---

## 7. Sequencing

Agreed with #4's *Related* section: this is orthogonal to issue #1 and should
land after the driver revisions merge. One dependency worth noting in the other
direction — `revise-requirements-codex.md` R5 requires digest inputs to be
issue-parameterised and resolved relative to the config file. `setup-workspace`
emits that config, so whichever lands second should confirm the two agree on
where digest material is read from.
