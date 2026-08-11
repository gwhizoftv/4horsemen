# coordination

Standalone **workflow driver** repository (issue 1). Not the test app.

The coordinator gives each agent one concrete action, accepts an exact pushed
commit SHA as that agent's completion intent, verifies the required artifact in
that commit, and advances only after the corresponding mechanical predicate
passes. Agents never interpret phase gates.

**The coordinator can never merge.** With owner policy it may open an unmerged
pull request; merging stays with the owner.

## Quick start

```bash
nvm use 26
pnpm install --frozen-lockfile
pnpm check                 # build, lint, typecheck, unit tests, four-agent canary
pnpm build && ./coord --help
```

## Running a workflow

Runtime state must live **outside every agent clone**. `--coord-root` is
required and is proven to be outside each configured clone before anything is
written — there is no default.

```bash
./coord start 1 \
  --profile consensus \
  --config config.example.json \
  --coord-root /Volumes/4TB-SOURCE/REPOS/coord/coord-runtime

./coord run --coord-root /Volumes/4TB-SOURCE/REPOS/coord/coord-runtime --issue 1
```

From inside an agent pane:

```bash
./coord next --coord-root /…/coord-runtime --issue 1 --agent claude
# … do the work, push, then:
echo <40-hex-sha> > /…/coord-runtime/issue-1/agents/claude/complete
```

`coord next` prints only that agent's own action, or `none yet`. Pushing alone
does not complete an action — the commit SHA in `complete` is the intent, and
the artifact is verified at that exact commit.

Owner controls: `coord drop <agent>`, `coord pause`, `coord resume`,
`coord restart-action --agent <agent>`, `coord abandon`, `coord answer`.

Full operator documentation, including the drop contract, recovery, tmux
policy, and finalization: [`docs/coord-driver.md`](docs/coord-driver.md).

## Layout

| Path | Purpose |
| --- | --- |
| `src/paths.ts` | control-root resolution, containment, symlink policy |
| `src/protocol.ts` | strict schemas for published artifacts |
| `src/steps.ts` | step/gate/evidence vocabulary, profiles, shared types |
| `src/state.ts` | operational state and crash-safe I/O |
| `src/action.ts` | the order/action boundary and completion channel |
| `src/mirror.ts` | bare mirror; the only place origin bytes enter |
| `src/evidence.ts` | `isSatisfied(action, submissionSha)` predicates |
| `src/machine.ts` | the pure reducer — imports only `steps.ts` |
| `src/tmux.ts` | pane creation, launch, nudge policy |
| `src/runLoop.ts` | polling orchestration and R7 finalization |
| `src/cli.ts` / `src/main.ts` | the supported product boundary |

`src/hash.ts`, `src/pinValidation.ts`, and `src/finalization.ts` came from the
frozen consensus-ai automation suite and are maintained here from now on.

Agent clones (siblings): `coordination-claude`, `coordination-codex`,
`coordination-cursor`, `coordination-antigravity`.
