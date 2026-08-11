# Plan review — `file-creation-order.md`

**Reviewer:** Claude
**Target:** `.plans/issue-1/file-creation-order.md` at `23c4a07` (`issue-1/cursor`)
**Baseline:** `14d052a` (`main`) — scaffold `9f918cd` + adopted plan `a485bb7` + consensus seed `ffb596f`
**Authority:** `.plans/issue-1/plan.md` at `a485bb7` (adopted on `main`)

## Verdict

The Stage A sequence (steps 1–8) is topologically sound and should be adopted
nearly as written. Two classes of problem block it as-is:

1. One dependency edge (`machine.ts` → `evidence.ts`) contradicts the adopted
   plan's central architectural invariant.
2. The document scopes itself to `src/**` and `test/**`, and therefore omits
   every configuration file the adopted plan explicitly requires refining —
   `package.json`, `vitest.config.ts`, the `test/` typecheck wiring, and the
   `coord` wrapper. Three of those omissions are currently silent failures in
   the repository: checks that appear to run but do not.

All findings below were verified against the working tree at `14d052a`.

---

## 1. Blocking — `machine.ts` → `evidence.ts` breaks the purity boundary

Step 8 declares:

> **`src/machine.ts`** — pure state-machine reducer. Depends on `steps.ts`,
> `state.ts`, `evidence.ts`.

Step 7 declares `evidence.ts` depends on `mirror.ts`, and `mirror.ts` is Git
subprocess I/O. The "pure state-machine reducer" therefore transitively imports
the Git boundary.

This contradicts the adopted plan's architecture section:

> The state machine is deterministic and separated from I/O. Git, filesystem,
> clock, process, and tmux operations are injected boundaries so the main loop
> can be tested without real agent harnesses.

It also contradicts the plan's seam list, which names two *sibling* seams rather
than a stack:

> - `evaluateEvidence(...) -> { ok, outstanding[] }`;
> - `decide(...) -> readonly Decision[]` as the pure machine;

**Intended shape.** `runLoop.ts` calls `evaluateEvidence(...)`, then feeds the
*result* into `decide(...)` as an observation. `machine.ts` does not reach
evidence at all. This matches required-behavior item 5, where evaluation and the
resulting cursor advance are distinct effects sequenced by the loop.

**If the intent was a type-only import** (e.g. an `EvidenceResult` shape), the
document should say so — but even a type-only edge pulls `mirror.ts` into the
module graph and invites an accidental value import later. Preferred fix:
declare the observation/result types in `steps.ts` (or a small shared
`types.ts`) and have both `evidence.ts` and `machine.ts` depend on that.

**Consequence if left as written.** `test/machine.test.ts` cannot run without
stubbing a Git boundary — precisely the coupling Stage A exists to avoid, and
precisely what makes the intent/proof matrix and the rounds 1–3 cases cheap to
test.

---

## 2. `package.json` is omitted — and `test:e2e` does not exist

Adopted plan, production file map item 3:

> **`package.json`** — refine the existing private Node 26 ESM package scripts
> so `check`, `check:fast`, `test:fast`, and `test:e2e` cover the complete
> driver and match the existing hook entry points.

Current scripts:

```json
"test": "vitest run",
"test:fast": "vitest run",
"check:fast": "pnpm lint && pnpm typecheck && pnpm test:fast",
"check": "pnpm build && pnpm check:fast"
```

There is no `test:e2e`. `githooks/pre-push:148` gates on its presence:

```bash
... && grep -q '"test:e2e"[[:space:]]*:' package.json; then
```

**The pre-push hook silently skips e2e today** — no error, no warning, exit 0.
The four-agent integration canary (step 24) would never run on push, and the
adopted plan's validation contract ("the pre-push hook runs `pnpm test:e2e` for
workflow-critical changes") would be satisfied only on paper.

This must be a numbered step, completed before Stage B lands the canary.

---

## 3. `vitest.config.ts` is omitted — `check:fast` will run the integration canary

`test:fast` and `test` are both bare `vitest run` with no filtering, and
`vitest.config.ts` includes everything under `test/**/*.test.ts`. `check:fast`
calls `test:fast`, and `githooks/pre-commit:79` runs `check:fast` on every
product commit.

The moment `test/integration.test.ts` lands, **every product commit pays for the
four-agent temporary-origin canary**. The plan intends `test:fast` to be the
focused unit tier and `test:e2e` to carry the canary; that split has to be
configured (vitest projects, or include/exclude plus a second config), and
`vitest.config.ts` appears nowhere in the creation order.

---

## 4. `test/tsconfig.json` is orphaned — test files are never typechecked

The consensus seed (`ffb596f`) added `test/tsconfig.json`, but nothing invokes
it:

- `typecheck` is `tsc -p tsconfig.json --noEmit`, whose `include` is
  `["src/**/*.ts"]` only.
- `eslint.config.mjs` uses plain `tseslint.configs.recommended` with no
  `projectService`/`parserOptions.project`, so lint is not type-aware.

Net effect: nothing enforces the adopted plan's validation rule — "no `any`, no
unchecked unvalidated JSON" — across the ~13 test files this issue creates.
`typecheck` needs a second invocation (`tsc -p test/tsconfig.json`). Also absent
from the creation order.

---

## 5. `coord` wrapper — omitted, and it serves stale builds

```bash
if [[ ! -f dist/main.js ]]; then
  pnpm build
fi
exec node dist/main.js "$@"
```

It rebuilds only when `dist/main.js` is *missing*. After any source edit,
`coord next` silently executes a stale build.

This matters more than a normal staleness bug because `coord next` is the path
by which agents pull their actions. A stale wrapper means an agent acts on a
superseded action, and the symptom appears inside the agent pane, far from the
cause. Adopted plan item 10 says "retain/**refine**" this wrapper; the creation
order does not list it.

Suggested fix when the step is added: build when `dist/main.js` is missing *or*
older than the newest file under `src/`, or simply always `pnpm build` when
`dist` is stale by mtime comparison.

---

## 6. `config.example.json` — `defaultCoordRoot` is still present

Adopted plan, item 28:

> Remove `defaultCoordRoot`: `--coord-root` is always required.

The file still contains `"defaultCoordRoot": "../coord-runtime"`. Creation-order
item 27 softens this to "refined example config," which loses the mandate.

This is a correctness requirement, not cosmetics: a default coord-root invites
the runtime tree landing inside a clone, which is exactly what rejected
alternative 7 and the `paths.ts` containment check exist to prevent. Carry the
instruction verbatim into the step.

---

## 7. Sequencing improvements

**Add a step 0 — green baseline.** Nothing in the document establishes that the
repository builds before work starts. Run `pnpm install --frozen-lockfile &&
pnpm check` against the seed first. Discovering that the `finalization.ts` →
`pinValidation.ts` pair does not compile in this repository is much cheaper at
step 0 than eight files deep.

**Move `test/pinValidation.test.ts` and `test/finalization.test.ts` to the
front** (currently steps 15–16). They cover seed files that are already present
and depend on nothing else in the order. As of `14d052a`, `src/pinValidation.ts`
(245 lines) and `src/finalization.ts` (133 lines) are **entirely untested in
this repository** — only `hash.test.ts` came across in the seed. Writing these
first proves the seed works here and de-risks the R7 finalization path early, at
zero ordering cost.

**Pair each test with its source file.** Steps 9–16 batch all Stage A tests
after all eight source files, which contradicts the document's own rationale:

> The order ensures each file can be typechecked and tested as soon as it is
> written, with no forward references.

Line 22's hedge ("can be written alongside or immediately after each source
file") should become the rule rather than an option.

---

## 8. Minor

- **Step 5 dependency looks wrong.** `action.ts` is listed as depending on
  `state.ts`. `action.ts` renders `action.md` and parses/clears `complete`; what
  it needs is the absolute-path machinery from `paths.ts`. `state.ts` owns
  `start.json`/`cursors.json`/`journal.jsonl`, which `action.ts` should not
  touch — keeping that separation is what stops internal cursor state leaking
  into the agent-facing file (required behavior 2).
- **`test/stub.test.ts` deletion** sits at step 28. It can move to the first
  real test file instead; nothing depends on it surviving.

---

## Suggested revised order

| # | Item | Change from `23c4a07` |
| --- | --- | --- |
| 0 | `pnpm install --frozen-lockfile && pnpm check` | **new** — green baseline before any file |
| 1 | `package.json` + `vitest.config.ts` + `typecheck` covering `test/` | **new** — fast/e2e split and `test:e2e` so both hooks actually bind |
| 2 | `test/pinValidation.test.ts`, `test/finalization.test.ts`; delete `test/stub.test.ts` | **moved up** from 15–16 and 28 |
| 3 | `src/paths.ts` + `test/paths.test.ts` | as proposed, tests paired |
| 4 | `src/protocol.ts` + `test/protocol.test.ts` | as proposed, tests paired |
| 5 | `src/steps.ts` (+ shared observation/result types) | as proposed, plus the types that break the `machine`→`evidence` edge |
| 6 | `src/state.ts` + `test/state.test.ts` | as proposed, tests paired |
| 7 | `src/action.ts` + `test/action.test.ts` | depends on `paths.ts`/`steps.ts`, not `state.ts` |
| 8 | `src/mirror.ts` + `test/mirror.test.ts` | as proposed, tests paired |
| 9 | `src/evidence.ts` + `test/evidence.test.ts` | as proposed, tests paired |
| 10 | `src/machine.ts` + `test/machine.test.ts` | **depends on `steps.ts`, `state.ts` only — not `evidence.ts`** |
| 11 | `config.example.json` (remove `defaultCoordRoot`) | **moved up** — cheap, blocks nothing |
| 12 | `src/tmux.ts` + `test/tmux.test.ts` | as proposed |
| 13 | `src/runLoop.ts` + `test/runLoop.test.ts` | as proposed; this is where `evaluateEvidence` result meets `decide` |
| 14 | `src/cli.ts` + `test/cli.test.ts` | as proposed |
| 15 | `src/main.ts` | as proposed |
| 16 | `coord` wrapper staleness fix | **added** |
| 17 | `test/integration.test.ts` | as proposed, wired to `test:e2e` |
| 18 | `docs/coord-driver.md`, `README.md` | as proposed |

Everything else in `file-creation-order.md` stands. The Stage A/Stage B split,
the "no forward references" principle, and the placement of tmux and the run
loop behind the pure core are all correct and worth keeping.
