# Issue 166 — Python and Flutter onboarding without `--declare`

## Problem

`coord onboard` / `coord install` builds the workspace policy from
`proposeToolchainPolicy` in `src/setupWorkspace.ts`. That detector knows only
`Cargo.toml`, `go.mod`, `package.json`, and `Makefile`. A Python repository
(`pyproject.toml`, `requirements.txt`, …) or a Flutter/Dart repository
(`pubspec.yaml`) gets an empty proposal, so `buildWorkspaceConfig` throws
`Cannot infer finalization checks for <project>` and the owner has to write a
`--declare` file (the "special option" the issue mentions;
`docs/setup-workspace.md` documents it as the only Python path).

The issue asks for three things:

1. Python works with a plain `coord onboard <repo>`.
2. Flutter works with a plain `coord onboard <repo>`.
3. Where coord picks policy defaults, onboarding announces what they are and
   what they mean.

Today install prints nothing about the policy it wrote, for any language.

## Exact File List to be changed or deleted

- `src/setupWorkspace.ts`
  - Add an optional `notes?: string[]` field to `ProjectPolicyProposal`. These
    are the human-readable consequences of a proposed default. They are never
    written to the config.
  - Add two private detectors next to the existing ones:
    - `proposeDartPolicy(productRoot)`, triggered by `pubspec.yaml`. If the
      pubspec declares the Flutter SDK (`/^\s*sdk:\s*flutter\s*$/m`), the
      toolchain is `flutter`; otherwise it is `dart`.
      - Flutter: precommit `flutter analyze --no-fatal-infos`, prepush
        `flutter test`, finalization checks `flutter pub get` (named `install`)
        then `flutter test`.
      - Dart: precommit `dart analyze`, prepush `dart test`, finalization
        checks `dart pub get` (named `install`) then `dart test`.
      - Workflow-critical paths for both: prefixes `lib/`, `test/`; files
        `pubspec.yaml`, `pubspec.lock`.
    - `proposePythonPolicy(productRoot)`, triggered by any of
      `pyproject.toml`, `setup.py`, `setup.cfg`, or `requirements.txt`.
      - Runner: `uv.lock` means `["uv","run",…]`, `poetry.lock` means
        `["poetry","run",…]`, and anything else means `["python3","-m",…]`.
      - Test command: `<runner> pytest -q`.
      - Lint command: `<runner> ruff check .`, but only when Ruff is
        configured, meaning `ruff.toml` or `.ruff.toml` exists, or
        `pyproject.toml` contains `[tool.ruff`.
      - If lint is configured: verify is precommit `[lint]`, prepush `[test]`.
        Otherwise: precommit `[test]`, prepush `[]`.
      - Finalization checks: `poetry install` (named `install`, Poetry only),
        then lint (when configured), then test.
      - Workflow-critical paths: prefixes `src/`, `tests/`; files are whichever
        of `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`,
        `uv.lock`, `poetry.lock` exist.
  - Both detectors set `notes` to their consequences:
    - The runner chosen and the environment it needs. Plain `python3 -m` uses
      the interpreter on the PATH that coord and the agents inherit, so the
      venv must be activated first.
    - `pytest` exits non-zero when it collects no tests.
    - Ruff is used only because it is configured.
    - Flutter `analyze` runs with `--no-fatal-infos`.
    - Finalization runs `pub get` / `poetry install` because the checks run in
      a fresh detached worktree (`src/mirror.ts` `worktree add --detach`).
    - Any detector default can be overridden with `--declare`.
  - Restructure `proposeToolchainPolicy` as an ordered list of detectors:
    Cargo, Go, Node, Make, Dart/Flutter, Python.
    - It returns the first matching proposal that carries finalization
      `checks`.
    - If no match has checks, it returns the first match, which keeps today's
      refusal and error text unchanged.
    - If nothing matches, it returns the existing empty proposal.
    - This fall-through means a Python or Flutter repo that also ships a
      tooling-only `package.json` (prettier/husky) or a `Makefile` without a
      `test` target is no longer refused.
    - A `Makefile` with a `test` target still wins over Python/Flutter, so
      existing make-based workspaces regenerate the same config on reinstall.
  - Update the doc comment on `proposeToolchainPolicy` to state the
    first-with-checks rule.
- `src/install.ts`, step 7 summary (the `Installed ${project} for agents: …`
  block): announce the effective policy, using the same aligned style as the
  existing lines.
  - `toolchain        : <config.toolchain ?? "unspecified"> (declared |
    proposed — review, or override with --declare)`
  - `precommit        : <argv joined by space, comma-separated | none
    (explicit opt-out) | absent — hooks block until declared>`
  - `prepush          : …`
  - `finalization     : …`
  - One `note             : …` line per `proposal.notes` entry. Notes print
    only when the effective `checks` came from the proposal
    (`declared?.checks === undefined`), so a declared policy is never
    annotated with caveats about defaults it replaced.
  - `coord onboard` calls `install` with the same `log`, so the announcement
    appears during onboarding with no change to `onboard`.
- `test/verify-config.test.ts`: new cases (see Tests).
- `test/install.test.ts`: one new case (see Tests).
- `README.md`, "Supported languages" table:
  - Replace the Python row ("Explicit commands … no auto-detection yet") with
    the detected markers.
  - Add a Flutter/Dart row.
  - State that install prints the proposed policy and its notes.
- `docs/setup-workspace.md`, "Product languages":
  - Add `pubspec.yaml` and Python rows to the detector table in the new
    precedence order (Make before Dart/Flutter before Python).
  - Document the first-with-checks fall-through.
  - Replace the paragraph "Python works through an explicit declaration today;
    … not auto-detected" with the proposed Python and Flutter defaults. Keep
    the existing declaration example, reframed as how to override them.
  - Keep the `coord doctor` PATH note, which now names `uv`, `poetry`,
    `python3`, `flutter`, and `dart`.

## Exact file list to be created

None. All behavior goes into the existing detector module, the existing install
summary, and existing test files.

## Reuse and Scope

Existing code reused:

- `proposeToolchainPolicy` / `proposeProjectPolicy` (`src/setupWorkspace.ts`):
  the only sanctioned ecosystem-detection point, per its own doc comment. The
  new detectors live there, so hooks still never sniff the tree.
- `proposedVerify(precommit, prepush)`: reused so a detector never writes an
  empty-verify opt-out on the owner's behalf.
- The `CheckCommand` type, and the `has(relative)` / `existsSync` pattern
  already used by the Cargo/Go/Node branches.
- `makeTargets` for the Make detector. It is unchanged, and only its position
  in the ordered list matters.
- `buildWorkspaceConfig`: unchanged. Its refusal message still fires when no
  detector produced checks.
- `unresolvableCommands` and `coord doctor`'s `toolchain` finding: unchanged.
  They already report a missing `uv`/`poetry`/`python3`/`flutter`/`dart` on
  PATH at onboarding time.
- `writeProductAgentsProtocol`: already receives `proposal.toolchain`, so the
  `{{TOOLCHAIN}}` substitution now says `python`/`flutter` instead of the
  generic fallback.
- Named `install` finalization steps: the precedent is `config.example.json`
  (`pnpm install --frozen-lockfile`).

Existing tests and fixtures reused:

- `test/verify-config.test.ts`: the `mkdtempSync` temp-root pattern from
  "proposes non-Node argument vectors for non-Node trees".
- `test/install.test.ts`: the `product()` / `installOnce()` helpers, with
  `declarePath: undefined` so the Go fixture's own proposal is used. The
  output-capture pattern comes from "advertises owner-driven manual work after
  installation".
- `makeProduct` in `test/support/workspaceFixture.ts` is reused unchanged.

Out of scope:

- `scripts/setup_common.sh` (the legacy setup scripts' own type sniffing).
- Node-proposal hermeticity (no install step).
- Multi-language monorepo heuristics.
- New hook or doctor behavior.
- Any version bump.

## Tests

All new cases fail before the change: the detectors don't exist, the
fall-through returns `checks: undefined`, and install prints no policy lines.
All pass after it.

New cases in `test/verify-config.test.ts`, in the existing
`describe("declared verification")` block next to "proposes non-Node argument
vectors for non-Node trees":

1. **"proposes Python checks from pyproject, requirements, uv and Poetry
   markers"**, using temp roots:
   - `requirements.txt` only:
     - toolchain is `python`.
     - `verify.precommit[0].argv` is `["python3","-m","pytest","-q"]`.
     - `verify.prepush` is `[]`.
     - `checks` is `[test]` only.
     - `notes` mentions the PATH/virtual-environment requirement.
   - `pyproject.toml` with `[tool.ruff]` plus `uv.lock`:
     - precommit is `["uv","run","ruff","check","."]`.
     - prepush is `["uv","run","pytest","-q"]`.
     - `workflowCriticalFiles` is `["pyproject.toml","uv.lock"]`.
   - `pyproject.toml` plus `poetry.lock`: `checks[0].argv` is
     `["poetry","install"]` and the last check is
     `["poetry","run","pytest","-q"]`.
2. **"proposes Flutter or Dart checks from pubspec.yaml"**:
   - A pubspec with `flutter:\n    sdk: flutter`:
     - toolchain is `flutter`.
     - precommit is `["flutter","analyze","--no-fatal-infos"]`.
     - checks are `[["flutter","pub","get"],["flutter","test"]]`.
   - A pubspec without the Flutter SDK: toolchain is `dart` and the test check
     is `["dart","test"]`.
3. **"falls through a detector that found no finalization checks, without
   reordering ones that did"**:
   - `package.json` with only a `lint` script, plus `pyproject.toml`:
     toolchain is `python`.
   - `Makefile` with a `test:` target, plus `pyproject.toml`: toolchain is
     still `make`.
   - `Makefile` with only `check:`, plus `pubspec.yaml`: toolchain is
     `flutter`/`dart`.
   - The existing "proposes nothing it cannot recognise" case keeps
     `test/support` as unknown. The existing "omits verify when nothing was
     recognized" case still sees `make` for a `test`-only Makefile.

New case in `test/install.test.ts`, under `describe("coord install — emitted
config")`:

4. **"announces the proposed policy it wrote"**:
   - Run `installOnce(product(), { declarePath: undefined, log: capture })`
     and assert the output contains:
     - `toolchain        : go (proposed`
     - `finalization     : go build ./..., go test ./...`
   - Re-run with the default declared `installOnce` and assert the output says
     `(declared` and contains no `note ` line.

Checks to run while implementing:

- Focused runs:
  - `pnpm exec vitest run --config vitest.config.ts
    test/verify-config.test.ts`
  - `pnpm exec vitest run --config vitest.system.config.ts
    test/install.test.ts`
  - `pnpm build` first, because the install fixtures call `ensureBuilt()`.
- `pnpm check:docs`, because README and setup docs change.
- The commit hook owns `pnpm check:fast`; it isn't duplicated manually.
- The coordinator owns final `pnpm check`.

## Alternatives Rejected

- **Making Python/Flutter detection run before `package.json`/`Makefile`.**
  This silently changes the regenerated config for existing workspaces whose
  `Makefile` has a working `test` target. Reinstalling rebuilds the config from
  the proposal. The fall-through rule fixes the refused cases without changing
  any case that works today.
- **Bare `pytest` as `argv[0]`, so doctor can resolve it.**
  - It fails whenever pytest lives only inside a venv that isn't on PATH.
  - `python3 -m pytest` follows whichever interpreter is active.
  - `uv run` / `poetry run` handle their own environments.
  - The notes tell the owner which environment is assumed.
- **Always proposing Ruff (or flake8/mypy) for Python.** That is speculative
  policy, and it blocks every commit in repos that don't use those tools. Ruff
  is proposed only when the repo has configured it.
- **Plain `flutter analyze`.** Its default treats info-level lints as fatal,
  which would block commits on existing style noise in an onboarded app.
  `--no-fatal-infos` keeps warnings and errors fatal.
- **Writing `verify: {precommit: [], prepush: []}` for languages with no cheap
  linter.** The existing `proposedVerify` contract forbids signing an opt-out
  for the owner, so the test command serves as the precommit instead.
- **Adding a separate `--python` / `--flutter` flag or a template declaration
  file.** That is exactly the "special option" the issue wants removed.
- **Putting the policy summary in `onboard` only.** `coord install` writes the
  same config and deserves the same announcement, and `onboard` already
  forwards `install`'s log.

## Risks and Mitigations

- **Ordering regressions for mixed-marker repos.**
  - Risk: proposals change for repos that previously detected successfully.
  - Mitigation: a detector that produces checks still wins in the existing
    order, and only previously refused repos change outcome. Test 3 pins both
    directions.
- **The Python environment isn't on the agents' or coordinator's PATH.**
  - Risk: precommit, prepush, and final checks fail with `No module named
    pytest`.
  - Mitigations:
    - An onboarding note says which interpreter and environment are assumed.
    - Doctor still resolves `python3`/`uv`/`poetry`.
    - uv projects are self-provisioning via `uv run`.
- **No tests collected (pytest exit 5) or no `test/` directory (`flutter
  test`).**
  - Risk: finalization fails.
  - Mitigation: an onboarding note states the requirement and points to
    `--declare` for an override.
- **Flutter or Dart SDK resolution in a fresh worktree.**
  - Risk: tier-3 checks run in a detached worktree with no `.dart_tool`.
  - Mitigation: the explicit `pub get` install step makes this hermetic
    instead of relying on implicit resolution.
- **Poetry venvs keyed by project path.**
  - Risk: the fresh worktree has no installed environment.
  - Mitigation: a `poetry install` finalization step.
- **Summary noise or format drift.**
  - Risk: the new lines clutter or break the install output.
  - Mitigation: the new lines reuse the existing aligned-label style. Only
    tests that already capture output are affected, and test 4 pins the format.

## Conclusion

Add Python (`pyproject.toml` / `setup.py` / `setup.cfg` / `requirements.txt`,
with uv/Poetry/plain runners) and Flutter/Dart (`pubspec.yaml`) detectors to
the existing single detection point. Let a detector that yields no finalization
checks fall through to later ones, without disturbing any detection that
already works. Make `coord install` / `coord onboard` print the effective
toolchain, verify, and finalization commands, plus the consequences of proposed
defaults.

The change touches two source files, two existing test files, and two docs.
It creates no new files, adds no dependencies, and needs no `--declare` for
either language.
