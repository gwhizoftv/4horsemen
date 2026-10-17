# Issue 235 implementation comparison

Bound implementation pins:
- codex `4c4dd97e1d9c54e597e725ec8f899baac010e992`
- cursor `5abfee0b150079ae6114db59a496907596639a22`
- claude `f0bd6aa4dda49e87de79992939f70a047f5f4ff7` (this agent's own pin, judged by the same rules)

## Comparison

All three pins follow the selected plan and touch the same 17 product paths,
all inside the approved map. Each one:
- adds `DEFAULT_AGENTS` with Muse fifth, used for both CLI and programmatic onboarding;
- generates `delivery: "both"`;
- adds `hasTerminalDeliveryAdapter` and stops doctor reporting Muse's missing lifecycle mapping;
- recognizes `muse-bin-*` as Muse's process;
- adds a `museComposer`/`museTurnChrome` adapter with three refusal codes and their `DEFERRAL_RATIONALE` entries;
- extends the pre-send recapture to Muse;
- requires the full rendered prompt for Muse submit-only recovery;
- keeps Muse out of the "queued mid-turn" Enter allowance.

None adds a file, a dependency, hooks or a refactor. The tests extend existing files.

Material differences:

| | codex | cursor | claude |
|---|---|---|---|
| Pending prompt accepted | current prompt, with or without the resend prefix | **only the variant matching the current send** (F1) | both variants |
| Pending state changes between captures | defers (`promptPending(latest) !== submitOnly`) | types the prompt again (F3) | types the prompt again (F3) |
| Footer check | exactly one footer line, which must start `muse-` | at most one line after the rule | at most one line after the rule |
| Escape repair | only the `Escape,Enter` submit pair | only the `Escape,Enter` submit pair | strips Escape from prelude and submit (F4) |
| Frozen-roster / re-onboarding test | yes | no | no |
| Doctor test keeps shim/launcher failures for Muse | yes | no | no |
| Five-agent onboarding test timeout | **none; exceeds 15 s** (F2) | 60 s | 45 s |
| Live verification | blocked by a tmux socket permission; reproduction recorded | not attempted; deferred to the owner (F5) | run: real Muse through the real `coord start`/`coord run` loop, JOIN→plan→implement→finalize, plus terminal scenarios |

Investigation run for this comparison (no product suites):
- A probe script ran each pin's built `TmuxController.nudge` against captured
  Muse panes. Each pin was built in a scratch copy with `tsc`.
- Codex's `test/onboard.test.ts` was run in a scratch copy under its own
  `vitest.system.config.ts`.

### Findings

**F1 — cursor `src/tmux.ts:1263` and `:218`: a resend can never submit the original prompt still sitting in the composer.**
- **Rule:** submit-only recovery must recognize this action's current prompt with or without the `RESEND_PREFIX`. The watchdog resend (`deliver(..., "resend")` passes `{ resend: true }`) exists exactly for a prompt typed earlier whose Enter was lost.
- **Failure:** `renderedPrompt` is rendered with the current `options.resend` flag, and `museComposerHoldsPrompt` requires an exact match. The original send leaves `❯ Read and execute coordinator action <id> digest <d> at <path>` unsent. The pane goes quiet, and the watchdog's one resend is refused with `muse-composer-not-ready`, sending no keys. The action is never submitted, and the owner gets a draft message for text coord itself typed.
- **Reproduction:** the probe gives cursor `{"status":"busy","reason":"muse-composer-not-ready"}` with 0 keys; codex and claude both return `sent` / `pending-prompt-submitted`.
- **Smallest test:** in `test/tmux.test.ts`, a pane with `musePane("", renderNudgeText("/a", id, digest))` and `nudge(..., { resend: true })` should produce `{ status: "sent", detail: "pending-prompt-submitted" }` and no `-l` key.

**F2 — codex `test/onboard.test.ts:203` and `:299`: the five-agent onboarding tests exceed the system-tier timeout.**
- **Rule:** every test in the required `pnpm check:fast` / `pnpm check` must finish inside its configured limit. `vitest.system.config.ts:17` sets `testTimeout: 15_000`.
- **Failure:** default onboarding now creates five clones and each test onboards twice. Run alone on this machine, "applies the happy-path defaults…" took 17.7 s and "adds Muse on default programmatic re-onboarding…" took 15.1 s, and both failed with `Test timed out in 15000ms`. Coordinator final checks at this pin are likely to fail or flake.
- **Correction:** give both tests an explicit timeout, as cursor (60 s) and claude (45 s) did for the happy-path test.

**F3 — claude `src/tmux.ts:1296` and `:1305`, and cursor (same code path): the batch is not re-chosen when the composer changes between captures.**
- **Rule:** the decision between typing and submit-only must come from the final validated capture.
- **Failure:** the first capture shows an empty composer, so `submitOnly` is false. The final recapture shows this action's full prompt already typed, for example by a concurrent explicit reminder. `proofRefusal` exempts that pending prompt, so the batch types the prompt again after the existing copy and submits the doubled, concatenated text. The probe confirms claude and cursor both send literal text in this case; codex defers with `muse-composer-not-ready` at `src/tmux.ts:1296` (codex).
- **Smallest test:** captures `[musePane(""), musePane("", current)]` should give `busy` with no `send-keys`. This is low-likelihood, and codex's guard is the fix.

**F4 — codex `src/tmux.ts:384–396`, cursor `src/tmux.ts:410`: a configured Escape prelude still reaches Muse.**
- **Rule:** Escape interrupts a running Muse turn, so no Muse key path should send it.
- **Failure:** only the exact `["Escape","Enter"]` submit pair is repaired. A hand-written `nudgePrelude: ["Escape"]` or `nudgeSubmit: ["Escape"]` passes through. Automatic sends happen only when the pane is idle, but `remind()` bypasses readiness, so an owner reminder during a turn sends Escape and interrupts it. Claude strips Escape from both prelude and submit, with a test.
- **Smallest test:** `resolveNudgeKeys({ id: "muse", nudgePrelude: ["Escape"], nudgeSubmit: ["Escape", "Enter"] … })` should equal `{ prelude: [], submit: ["Enter"] }`.

**F5 — cursor `docs/setup-workspace.md:172`: live verification is neither performed nor reported as blocked.**
- **Rule:** the issue requires the tested Muse version and live results to be recorded. If live verification hits a concrete blocker, the blocker's reproduction and the missing capability must be reported. The deliverable must not be silently reduced.
- **Failure:** cursor records only `muse --version` and calls live publication "an owner acceptance step". The issue's acceptance criteria for JOIN plus two actions, Git and private-response publication, drafts, running turns and restart are unaddressed, with no blocker given.
- **By contrast:** codex records a concrete blocker with a reproduction (`docs/setup-workspace.md:206`, codex). Claude records live results (`docs/setup-workspace.md:184`, claude):
  - In a disposable workspace whose GitHub origin was redirected to a local bare repo, the real `coord start` and `coord run` drove Muse through JOIN, plan, implement and finalize to an accepted final pin with no hooks. Only the stubbed PR creation failed.
  - Muse completed a private response with `response <id>` plus `ready`.
  - A Git action was sent on a ready receipt.
  - Running-turn and owner-draft refusals held.
  - A pending prompt was submitted without retyping.
  - After a kill and relaunch, a single resend completed the action once.

### Scope and reuse

All three stay inside the issue and reuse the same helpers (`paneLines`,
`renderNudgeText`, `injectionGate`, `typeAndSubmit`, `safetyFixture`,
`installOnce`), with no new modules.

Codex's extra tests are focused and valuable: the frozen-roster and
re-onboarding test, the doctor check that keeps shim and launcher failures for
Muse, and a Muse resend-over-pending run-loop case. They are the only coverage
of F1's behavior at run-loop level. Codex also changes the exported
`pendingPromptInComposer` signature (an optional `expectedPrompt`), while
claude and cursor keep a private Muse helper; both are acceptable.

Cursor adds `muse: "Muse"` to `KNOWN_AGENT_LABELS`, a cosmetic, in-scope
change. Its `config.example.json` Muse entry omits `harnessProcess`, which
matches the other examples, but a copied entry would then accept any foreground
process.

### Ranking

1. **claude:** the only pin with live verification against real Muse and
   the real coordinator loop. F3 is its one confirmed defect: low-likelihood,
   with a 3-line fix taken from codex.
2. **codex:** the most robust adapter (closes F3, has the strongest tests),
   but F2 makes the required suite fail on this machine and live acceptance
   is recorded as blocked.
3. **cursor:** F1 breaks the watchdog's lost-Enter recovery for Muse, and F5
   leaves live acceptance unaddressed.
