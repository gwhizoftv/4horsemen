# Plan review — issue 98

Bound plans reviewed:

- Cursor: `4f96e513360d5ddf60d77b957336b5d61334a264`
- Claude: `cf42e129554604df5a61a5ca917157cc6deb9053`
- Codex: `208c3833c1815b78ab2496b2f4aab30de96aa416`

## Findings

### [P1] Cursor's start-time launcher refresh writes into agent clones

**Plan claim.** Cursor plan `4f96e513360d5ddf60d77b957336b5d61334a264`,
in the `src/setupWorkspace.ts` and `src/cli.ts` entries, says to regenerate each
issue-scoped launcher from coord start after the issue mailbox is created.

**Rule.** The coordinator must not write agent clones, and the installed
launcher plus post-merge regeneration must continue to have one deterministic
template rather than issue-dependent writers.

**Failure.** Following the plan makes every issue start mutate an untracked file
inside each agent clone, potentially while a prior harness or owner-customized
launcher still exists. A later post-merge regeneration has no issue argument
and can recreate a different launcher, so the same clone alternates between an
issue grant and an install-time grant depending on which writer ran last. This
both crosses the owner/agent boundary and recreates the launcher drift the
single template was introduced to prevent.

**Smallest correction.** Keep launcher generation install-time and
path-independent. At process launch, validate the already-set COORD_ISSUE and
combine it with a persisted absolute completesRoot and the fixed agent id; do
not rewrite the clone during start.

### [P1] Claude's agent-first tree grants historical and concurrent issues

**Plan claim.** Claude plan `cf42e129554604df5a61a5ca917157cc6deb9053`,
under “Segment order,” deliberately replaces the specified
completes/issue-N/AGENT/complete topology with
completes/AGENT/issue-N/complete so an install-time launcher can grant the
entire stable per-agent prefix.

**Rule.** The owner requirement fixes issue-first, agent-second containment and
requires a harness to receive only the current issue/current-agent drop, not an
agent's receipts for every issue.

**Failure.** With the proposed grant, an agent launched for issue B can replace
or erase its receipt for issue A. If issue A is still running, resumed, or
reused while that process remains available, the coordinator can observe intent
written by the wrong issue session. Wipe and operator tooling also receive a
layout that contradicts the specified per-issue subtree, so deleting an issue
is no longer one contained operation.

**Smallest correction.** Retain completes/issue-N/AGENT/complete. The generated
launcher can derive that exact directory at execution time from COORD_ISSUE;
that does not require re-rendering the launcher at coord start.

### [P1] The Antigravity permission repair is not on the installed upgrade path

**Plan claim.** Codex plan `208c3833c1815b78ab2496b2f4aab30de96aa416`
assigns removal of broad Antigravity non-workspace access to
`scripts/setup_antigravity.sh`, while its acceptance criteria require an
upgraded installation to have no such broad setting. The Cursor and Claude
plans likewise place Antigravity trust mutation partly in the standalone vendor
setup script without naming an installer-owned reconciliation function.

**Rule.** The normal install/onboard/reinstall path must idempotently establish
the narrow grant and repair previously installed broad permissions; a source
script that coord install never invokes is not an effective migration.

**Failure.** An existing workspace upgraded with coord install keeps
allowNonWorkspaceAccess enabled in the user Antigravity settings. Its new
launcher may name the narrow mailbox, but the retained global setting still
allows access outside that mailbox, including coord-runtime, so the integrity
goal remains false on the exact machines that need the fix.

**Smallest correction.** Put scoped Antigravity permission reconciliation in
the installer-managed settings path (for example the existing agent hook/settings
sync module), invoke it from coord install with the configured temporary/home
boundary, and test reinstall from a broad pre-change setting. The standalone
setup script may share that logic but cannot be the only caller.

### [P2] Cursor leaves standard harness grants conditional instead of mechanical

**Plan claim.** Cursor plan `4f96e513360d5ddf60d77b957336b5d61334a264`,
in `scripts/lib/launcher.sh`, says Codex should “prefer” a narrow writable root
when supported and Cursor may receive documentation instead of an implemented
extra-folder grant.

**Rule.** A mechanically complete plan must name a working, unattended launch
contract for every configured standard harness, and each contract must grant
the exact mailbox without granting coord-runtime.

**Failure.** The permitted interpretations include retaining Codex
danger-full-access and merely documenting a Cursor operator step. The first
still exposes coordinator state; the second leaves automated Cursor unable to
write complete. Either implementation can follow the plan literally while
failing issue 98.

**Smallest correction.** Bind the concrete supported commands: Claude add-dir;
Codex workspace-write plus add-dir; Cursor sandbox enabled plus add-dir; and
Antigravity sandbox plus add-dir, with argument-capture tests for paths and
spaces.

### [P2] Claude's explicit root has no authoritative installation input

**Plan claim.** Claude plan `cf42e129554604df5a61a5ca917157cc6deb9053`
adds an optional completesRoot to the generated coordinator config and says
install resolves an override from that field, but it does not add the field to
the workspace declaration or add a CLI/install option that supplies it before
the config is built.

**Rule.** A nested/shared workspace that needs a non-default mailbox must have
a typed owner input which is resolved, validated, and persisted by install;
hand-editing generated config cannot be the source of install-time authority.

**Failure.** Install constructs and overwrites the config from its arguments
and declaration. With no input route, the alleged override is unavailable on a
new install and is discarded on reinstall, so the nested layout the plan cites
as requiring an override can never reliably select it.

**Smallest correction.** Add an explicit completes-root option to onboard and
install (or deliberately permit it in the owner declaration), thread it through
InstallOptions/config construction, and store the resolved absolute value as a
required generated config field.

## Conclusion

None of the bound plans should be followed unchanged. Cursor's plan violates
the no-clone-write boundary and is noncommittal about two harnesses; Claude's
plan intentionally violates the required topology and omits a usable override
input. The Codex plan is closest to the requested issue-first, current-drop
design, but its Antigravity tightening must move onto the actual
install/reinstall path before selection. With that correction, a static
launcher can derive the exact current mailbox from validated launch-time issue
identity while the coordinator remains outside agent clones.
