# Issue 166 — Infer Python and Flutter policy on onboard

`coord onboard` and `coord install` refuse a tree they cannot give finalization
checks, and tell the operator to pass `--declare`. Python is documented as
declaration-only. A Flutter app (root `pubspec.yaml`, no Cargo/Go/Node/Make
marker) hits that refusal: `Cannot infer finalization checks`.

Detection stays a one-time tree read inside `proposeToolchainPolicy`. Hooks
keep executing the recorded argv and do not sniff language files. No new
dependency and no new product file.

## Exact File List to be changed or deleted

- `src/setupWorkspace.ts`
  - In `proposeToolchainPolicy`, after the `package.json` branch and before the
    Makefile branch, add Flutter and then Python. Cargo, Go, and Node stay
    first and still return immediately, so their proposals do not change.
    Makefile remains the generic fallback and no longer wins when a Flutter or
    Python marker matched.
  - Flutter matches only a root `pubspec.yaml` that contains a line
    `/^[ \t]*sdk:[ \t]*flutter[ \t]*$/m` (the `sdk: flutter` dependency form).
    A Dart package with no such line does not match. Proposal:
    - `toolchain`: `"flutter"`
    - `verify.precommit`: `{ name: "analyze", argv: ["flutter", "analyze"] }`
    - `verify.prepush`: `{ name: "test", argv: ["flutter", "test"] }`
    - `checks`: `{ name: "test", argv: ["flutter", "test"] }`
    - `workflowCriticalPrefixes`: `["lib/", "test/"]`
    - `workflowCriticalFiles`: `["pubspec.yaml", "pubspec.lock"]`
  - Python matches the first existing root marker in this order:
    `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`, `Pipfile`.
    Runner selection, first match, using text reads only (no TOML parser):
    1. `uv.lock` exists, or `pyproject.toml` contains `/^\[tool\.uv(\]|\.)/m`
       → prefix `["uv", "run"]`, `toolchain` `"uv"`. Reason prefers `uv.lock`
       when both are present.
    2. Else `poetry.lock`, or `/^\[tool\.poetry(\]|\.)/m` → prefix
       `["poetry", "run"]`, `toolchain` `"poetry"`. Reason prefers
       `poetry.lock`.
    3. Else `/^\[tool\.hatch(\]|\.)/m` → prefix `["hatch", "run"]`, `toolchain`
       `"hatch"`.
    4. Else no prefix, `toolchain` `"python"`.
    Commands, with that prefix applied to every argv:
    - precommit `{ name: "lint", argv: [...prefix, "ruff", "check", "."] }`
    - prepush `{ name: "test", argv: [...prefix, "pytest", "-q"] }`
    - checks: the same pytest argv only
    - `workflowCriticalPrefixes`: `["src/", "tests/"]`
    - `workflowCriticalFiles`: every path that exists among the marker list
      above, plus `uv.lock` / `poetry.lock` / `Pipfile.lock` when that file
      exists. Never invent a lockfile path that is absent. At least the
      matched marker is present.
  - Export `renderInferredPolicyNotice(proposal, appliedChecks): string | null`.
    Return null unless `proposal.toolchain` is `flutter`, `uv`, `poetry`,
    `hatch`, or `python`, and `JSON.stringify(appliedChecks)` equals
    `JSON.stringify(proposal.checks)`. Otherwise return one trailing-newline-free
    block, commands joined by single spaces:

    ```text
    Inferred <toolchain> policy defaults from <reason>.
      precommit: <argv or (none)>
      prepush: <argv or (none)>
      finalization: <argv>
      critical prefixes: <comma-separated, or (none)>
      critical files: <comma-separated>
    Pass --declare to replace these defaults. coord doctor reports a toolchain finding when the first argument is not on PATH.
    ```

    `<reason>`:
    - Flutter: `pubspec.yaml (sdk: flutter)`
    - Python-family: `<marker> using <toolchain> because <why>`
      where `<why>` is `uv.lock exists`, `pyproject.toml contains [tool.uv]`,
      `poetry.lock exists`, `pyproject.toml contains [tool.poetry]`,
      `pyproject.toml contains [tool.hatch]`, or
      `no uv, Poetry, or Hatch marker was found` for bare `python`.
    When the toolchain is `uv`, `poetry`, or `hatch`, append a final sentence:
    `Doctor checks only the first argument (<toolchain>); ruff and pytest still have to be available to that runner.`
    Bare `python` and `flutter` do not get that sentence, because their first
    argument is the tool doctor resolves.

- `src/install.ts`
  - After `writeWorkspaceConfig` and before the `Installed ...` summary, call
    `renderInferredPolicyNotice(proposal, config.checks)` and, when non-null,
    `options.log` the block plus a trailing newline. Do not push
    `effects.changes`: the notice is not a mutation. This runs for `coord
    install` and for `coord onboard`, because `onboard` calls `install` with
    the same log and then runs doctor. Dry-run reaches the same summary, so it
    announces too. A `--declare` file that supplies `checks` makes
    `config.checks` differ from `proposal.checks`, so the notice is omitted and
    the declared argv is what gets written.

- `docs/setup-workspace.md`
  - In the product-languages table, insert two rows after `package.json` and
    before Makefile, in detector order: Flutter (`pubspec.yaml` with
    `sdk: flutter`), then Python (the marker list and uv/poetry/hatch/python
    argv above). Keep the “first matching detector wins” sentence. State that
    Makefile is only reached when the earlier rows did not match.
  - Replace the “Python works through an explicit declaration today” paragraph
    so inference is the default and `--declare` is the override when the
    recorded ruff/pytest or flutter commands are wrong. Keep a declaration JSON
    example as that override, not as the required path. Mention the onboard
    notice and that doctor still reports a missing `argv[0]`.
  - Extend the later sentence that lists ecosystems `(cargo, go, pnpm/npm/yarn, make)`
    to include flutter and python/uv/poetry/hatch.

- `test/verify-config.test.ts`
  - Extend the existing `installer proposals` suite. No new fixture helper.

- `test/install.test.ts`
  - Extend install coverage with a captured log. No new fixture module.

## Exact file list to be created

No new product, test, or documentation files. Detection stays in
`proposeToolchainPolicy`, which is already the only place ecosystem detection
is allowed. `js-yaml` remains a devDependency and is not imported.

## Reuse and Scope

- Reuse `proposeToolchainPolicy`, `proposedVerify`, `proposeProjectPolicy`,
  `ProjectPolicyProposal`, `buildWorkspaceConfig`, and `CheckCommand`. The
  documentation allowlist in `proposeProjectPolicy` is unchanged and still
  wraps whatever toolchain proposal came back.
- Reuse `install`'s existing `options.log` and the `onboard` → `install` →
  `doctor` order. Doctor's `toolchain` finding and `unresolvableCommands` stay
  the PATH check; this change does not install ruff, pytest, uv, poetry, hatch,
  or flutter.
- Reuse the installer-proposal tests in `test/verify-config.test.ts` and
  `installOnce` / `makeProduct("plain")` / `writeDeclaration` in
  `test/install.test.ts`.
- Out of scope: Dart packages that lack `sdk: flutter`; monorepos whose root
  marker is an earlier detector (`package.json`, `go.mod`, `Cargo.toml`);
  executing the product's tools during detection; changing hook bodies; reading
  a previous install's declared checks back on re-onboard (reinstall already
  rebuilds from this invocation's `--declare` or a fresh proposal).

## Tests

Focused commands the implementation runs while developing:

- `pnpm exec vitest run --config vitest.config.ts test/verify-config.test.ts`
- `pnpm exec vitest run --config vitest.system.config.ts test/install.test.ts`

`test/verify-config.test.ts` is in the fast tier. `test/install.test.ts` is in
the system tier. The precommit hook's `pnpm check:fast` covers both on the
product commit. These new cases fail before the change (Python and Flutter
proposals have no `checks`; install throws `Cannot infer finalization checks`)
and pass after it.

Add to the `installer proposals` suite in `test/verify-config.test.ts`:

- Root `pyproject.toml` only → `toolchain` `python`, precommit
  `["ruff", "check", "."]`, prepush and checks `["pytest", "-q"]`, critical
  files `["pyproject.toml"]`, prefixes `["src/", "tests/"]`.
  `renderInferredPolicyNotice` contains `no uv, Poetry, or Hatch marker` and
  does not contain `Doctor checks only the first argument`.
- `pyproject.toml` plus `uv.lock` → argv prefixed `uv run`, toolchain `uv`,
  notice says `uv.lock exists` and `Doctor checks only the first argument (uv)`.
- `pyproject.toml` containing a `[tool.uv.sources]` line and no `uv.lock` →
  same `uv` prefix, notice says `contains [tool.uv]`. A `[tool.uvicorn]` line
  does not select uv.
- `poetry.lock` plus `pyproject.toml` → `poetry run`. `[tool.poetry]` without
  the lockfile does the same.
- `[tool.hatch.envs]` in `pyproject.toml` → `hatch run`.
- `requirements.txt` only → toolchain `python`, critical files
  `["requirements.txt"]`.
- `uv.lock` and `poetry.lock` together → uv wins.
- Flutter `pubspec.yaml` whose body has a `sdk: flutter` line → the flutter
  argv above, and the notice quotes `pubspec.yaml (sdk: flutter)` and
  `flutter analyze`.
- `pubspec.yaml` with only a Dart `sdk:` constraint → `checks` undefined,
  toolchain not `flutter`. `buildWorkspaceConfig` without `declared.checks`
  still throws `/Cannot infer finalization checks/`.
- `package.json` with a `test` script plus `pyproject.toml` → Node manager, not
  python. `go.mod` plus `pubspec.yaml` → `go`. `Cargo.toml` plus
  `pyproject.toml` → `cargo`.
- `pyproject.toml` plus a Makefile whose `test` target exists → python, not
  make.
- `renderInferredPolicyNotice(proposal, [{ name: "test", argv: ["true"] }])`
  is null for a Python proposal.

Add to `test/install.test.ts`, using `makeProduct("plain")`, a log array, and
`declarePath: undefined` so `installOnce`'s default declaration is replaced:

- Write `pyproject.toml`, install, expect exit via a returned config whose
  `checks[0].argv` is `["pytest", "-q"]`, and expect the joined log to contain
  `Inferred python policy defaults`.
- Write a Flutter `pubspec.yaml` on a second plain product, install, expect
  `checks[0].argv` `["flutter", "test"]` and log text `Inferred flutter policy defaults`.
- On a third plain product with `pyproject.toml`, pass `--declare` checks
  `[{ name: "test", argv: ["true"] }]` through `writeDeclaration`, expect
  `config.checks[0].argv` to equal `["true"]` and the log not to contain
  `Inferred python policy defaults`.

Do not spawn `flutter`, `pytest`, or `ruff` in tests. Doctor's PATH finding is
environment-dependent and stays covered by the existing unresolvable-command
test; the notice text is what this issue requires onboard to show.

## Alternatives Rejected

- Importing `js-yaml` or adding a TOML parser. Makefile detection is already a
  line regex; `sdk: flutter` and `[tool.uv]` are line markers of the same kind.
- Asking `python` or `flutter` to print their own scripts during install.
  Detection would start executing the product, and a missing tool would turn
  inference into the same hard failure `--declare` exists to avoid.
- Falling through Cargo, Go, or Node when those branches have no finalization
  checks. A `package.json` without `check` or `test` must keep failing closed
  until someone declares checks; silent fall-through to pytest would onboard
  the wrong ecosystem.
- Treating every `pubspec.yaml` as Flutter. `flutter test` on a Dart package
  fails doctor or the first commit.
- Installing ruff, pytest, or Flutter from onboard, or writing
  `"verify": { "precommit": [], "prepush": [] }` when they are absent. An empty
  verify is the operator's opt-out; a missing executable stays a doctor
  toolchain finding.

## Risks and Mitigations

- A Python or Flutter tree that also has a Makefile currently follows Make when
  the Makefile has any target. After this change the language row wins, so a
  repo whose real gate is `make test` records pytest or `flutter test` instead.
  The notice names every recorded argv and `--declare` replaces them. Cargo,
  Go, and Node still outrank both new rows.
- `uv.lock` outranks Poetry and Hatch when more than one marker is present, and
  a root `package.json` still outranks Python entirely. The notice states which
  marker won. Mixed monorepos keep the documented escape: `--declare`.
- `uv run` / `poetry run` / `hatch run` make doctor check only `uv`, `poetry`,
  or `hatch`. The extra notice sentence says ruff and pytest must still exist
  for that runner. Bare Python lists `ruff` and `pytest` as argv[0], so doctor
  catches those directly.
- Re-onboard without `--declare` rebuilds policy from the tree, including for a
  Python repo that was previously declared. That is the installer's existing
  rule for every ecosystem; the new notice makes the rebuilt Python or Flutter
  defaults visible instead of silent.

## Conclusion

Onboard of a Python tree or a Flutter app with `sdk: flutter` records
ecosystem argv and prints those defaults, including the `--declare` override
and the doctor PATH effect. Trees that already match Cargo, Go, or Node are
unchanged. Dart packages and unrecognized trees still fail closed until checks
are declared.
