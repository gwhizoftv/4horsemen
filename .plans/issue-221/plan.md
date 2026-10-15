# Plan — issue 221: `coord onboard` ignores the registered runtime on repeat onboarding

## Problem summary

`onboard()` in `src/install.ts:798` picks the runtime with
`resolve(options.coordRoot ?? join(parent, "coord-runtime"))`. It never reads
the product's `coord.ownerWorkspaceConfig` locator. So a re-onboard without
`--coord-runtime` after a custom-runtime install creates
`<parent>/coord-runtime`, rewires every agent clone's `coord.workspaceConfig`
to it, and (after doctor passes) `recordOwnerWorkspace` replaces the owner
locator. The original runtime and its issue state are left behind.

Required precedence: explicit `--coord-runtime`, then the repository's
registered runtime, then the default `<parent>/coord-runtime` for first-time
onboarding.

## Exact File List to be changed or deleted

- `src/install.ts`: change runtime selection in `onboard()` (around line 798),
  and add `resolveWorkspaceFromProduct` and `OWNER_WORKSPACE_CONFIG_KEY` to the
  existing `./workspace.js` import block (around lines 61–68). No other function
  in this file changes.
- `test/onboard.test.ts`: add two regression cases to the existing
  `describe("coord onboard", …)` block, and add `agentCloneDirectory` to the
  imports (from `../src/setupWorkspace.js`).
- `docs/setup-workspace.md`: add one sentence after the `--coord-runtime`
  example (around line 89) saying that re-running `coord onboard` without the
  flag reuses the runtime the repository is already registered to.

No files are deleted.

## Exact file list to be created

None. Only this plan artifact (`.plans/issue-221/plan.md`) is new. No new
product, test, or fixture files are needed: the change is one expression plus a
small helper inside `src/install.ts`, and the tests join the existing
`test/onboard.test.ts`.

## Reuse and Scope

Reused, unchanged:

- `resolveWorkspaceFromProduct(productRoot)` (`src/workspace.ts`). It already
  reads `coord.ownerWorkspaceConfig` and checks that the path is absolute, that
  the config exists and parses, and that `config.coordination.productRoot` is
  this worktree. It returns a `WorkspaceLocation` whose `coordRoot` is the
  *outer* runtime for both layouts, through `workspaceLocationFromConfig`. A
  nested `…/workspaces/<project>/config.json` yields the shared outer root.
  `install()` then calls `selectWorkspaceLocation(coordRoot, project)`, which
  finds the existing nested config and keeps writing there. The shared-runtime
  layout therefore needs no special handling.
- `OWNER_WORKSPACE_CONFIG_KEY` and `localConfigGet` (already imported in
  `src/install.ts` from `./gitExec.js`). They tell "no locator" (first-time
  onboarding, so use the default) apart from "a locator that does not resolve"
  (refuse; see Risks).
- `install()`, `doctor()`, `recordOwnerWorkspace()`: unchanged. Once
  `coordRoot` is the registered runtime, the existing install path rewrites that
  same config and re-points clones at the same path. `recordOwnerWorkspace`
  then writes back the same locator value.
- Test helpers in `test/onboard.test.ts` and `test/support/workspaceFixture.ts`:
  `product()`, `makeProduct`, `silence`, `repoRoot`, `runCli`,
  `localConfigGet`, `nestedConfigPath`, `OWNER_WORKSPACE_CONFIG_KEY`. Also
  `agentCloneDirectory` from `src/setupWorkspace.ts`, to find each agent clone
  and read its `coord.workspaceConfig`.

Implementation sketch (in `src/install.ts`, next to `onboard`):

```ts
/** The runtime this product is already registered to, or null on first onboarding. */
const registeredCoordRoot = (productRoot: string): string | null => {
  if (localConfigGet(productRoot, OWNER_WORKSPACE_CONFIG_KEY) === null) return null;
  try {
    return resolveWorkspaceFromProduct(productRoot).coordRoot;
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} ` +
        "Pass --coord-runtime to choose the runtime for this onboarding explicitly."
    );
  }
};

// in onboard():
const coordRoot = resolve(
  options.coordRoot ?? registeredCoordRoot(productRoot) ?? join(parent, "coord-runtime")
);
```

Out of scope: the default runtime name, `install` (which already requires
`--coord-runtime`), `--completes-root` retention, the messages of
`resolveWorkspaceFromProduct`, and any migration or cleanup of runtimes that
earlier releases already split (such as the stale `4horsemen-runtime` the issue
describes).

## Tests

Both cases join the existing `describe("coord onboard", …)` in
`test/onboard.test.ts`, use `home: null`, `--agents claude` and the `solo`
profile like the neighbouring cases, and fail on the current baseline.

1. **"re-onboarding without --coord-runtime keeps the registered custom
   runtime"**
   - `product()`, then `runCli(["onboard", productRoot, "--coord-runtime", <workspaceRoot>/myserver-runtime, "--agents", "claude", "--profile", "solo"])` → 0.
   - Record `custom = <workspaceRoot>/myserver-runtime/config.json`. Assert the
     owner locator equals `realpathSync(custom)`, and record the claude clone's
     `coord.workspaceConfig` (clone path from
     `agentCloneDirectory(dirname(productRoot), "myserver", "claude")`).
   - Create a marker issue directory, `mkdirSync(<custom runtime>/issue-7)`, as
     stand-in issue state.
   - `runCli(["onboard", productRoot, "--agents", "claude", "--profile", "solo"])` (no flag) → 0.
   - Assert: `<workspaceRoot>/coord-runtime` does not exist; the owner locator
     and the clone's `coord.workspaceConfig` are unchanged; `custom` still
     exists; `issue-7` still exists. *Baseline failure:* the default runtime is
     created and both pointers move to it.
   - Explicit override still wins: onboard again with
     `--coord-runtime <workspaceRoot>/other-runtime` → 0, and the owner locator
     now points at `other-runtime/config.json`. This checks precedence
     explicit > registered.

2. **"re-onboarding a registered nested workspace keeps the shared runtime"**
   - `alpha = product("alpha")`, `beta = product("beta")`, `shared = alpha.coordRoot`
     (as in the existing shared-runtime case). Onboard both with
     `--coord-runtime shared`. Record `firstConfigBytes` of `shared/config.json`.
   - Re-onboard `beta` without the flag → 0.
   - Assert: the beta owner locator still equals
     `realpathSync(nestedConfigPath(shared, "beta"))`;
     `<dirname(beta.productRoot)>/coord-runtime` does not exist;
     `shared/config.json` bytes are unchanged (alpha's flat slot is untouched).
     *Baseline failure:* a default runtime is created beside beta and beta's
     locator moves to it.

Coverage that already exists and stays: first-time default onboarding plus
re-onboard (`"applies the happy-path defaults…"`); first-time explicit override
and shared nested layout (`"isolates the same issue number…"`); locator kept
after a failed doctor (`"keeps a valid locator…"`, which onboards twice with
no locator change and must keep passing).

During development I will run the focused file with
`pnpm vitest run test/onboard.test.ts`. The pre-commit hook owns the mandatory
`pnpm check:fast`. The coordinator owns the final suites.

## Alternatives Rejected

- **Fall back to the default when the registered locator is missing or
  invalid.** This is exactly the silent re-pointing the issue forbids. A moved
  or temporarily unmounted custom runtime would be swapped for a fresh default
  one. Refusing with a message that names `--coord-runtime` keeps the owner in
  control.
- **Read the locator with `localConfigGet` and derive the runtime from the path
  by hand.** This duplicates `workspaceLocationFromConfig`'s flat/nested logic
  and skips its validation that the config belongs to this repository.
  `resolveWorkspaceFromProduct` already does both.
- **Use the agent clones' `coord.workspaceConfig` as a second source.** The
  owner locator is the registration the issue names, and `onboard` already
  writes it. Clone locators can disagree after the very bug being fixed, and
  choosing between them adds policy with no requirement behind it.
- **Change `install()` to infer the runtime.** `install` requires
  `--coord-runtime` and has no default to fix. Changing it widens scope.
- **Rename the default runtime to `<project>-runtime`.** The issue explicitly
  puts the naming convention out of scope.

## Risks and Mitigations

- **Stale or foreign locator now blocks a flagless re-onboard.** Before this
  change, onboard silently moved to the default. Now it throws the
  `resolveWorkspaceFromProduct` message plus a hint to pass `--coord-runtime`,
  before `install()` touches anything. An explicit flag still bypasses the
  locator entirely, so recovery is one flag away. `uninstall` clears the locator
  through `clearOwnerWorkspace`, so a clean uninstall followed by onboard still
  gets the default.
- **Alias or symlinked product paths.** `resolveWorkspaceFromProduct` resolves
  through `worktreeRoot`, and `localConfigGet` runs `git -C` on the given path.
  Both work through the alias used in the happy-path test, which keeps passing.
- **Nested layouts.** `workspaceLocationFromConfig` returns the outer
  `coordRoot`, so `install` re-selects the same nested slot and never claims
  the flat slot of another product. Test 2 pins this.
- **Custom `--completes-root` from the first onboarding is not remembered.**
  The default mailbox is derived from the retained runtime, so it matches the
  original default. A non-default mailbox was already not retained before this
  change, and it is outside this issue. I will not change it.

## Conclusion

Make one precedence change in `onboard()`: explicit `--coord-runtime`, then the
runtime from the validated owner locator (via `resolveWorkspaceFromProduct`),
then `<parent>/coord-runtime`. A locator that exists but does not resolve
refuses, with a hint to pass `--coord-runtime`. Add two regression cases to
`test/onboard.test.ts`, one flat custom runtime plus an explicit override and
one registered nested workspace, and one documentation sentence. No new files,
dependencies, or abstractions beyond a private helper.
