# Issue 257 plan review

Protocol version: 1. Reviewed the coordinator's exported plans directly:

- Claude: `200ca23013a8a94bf29759b68b9595d91547c24b`.
- Codex: `1db91964c3920092fd1a74bd081a0ad6f4e7dc15`.

Both plans address the frozen issue's OpenCode/OpenRouter request and reasonably
choose opt-in, attended pull delivery while a real OpenCode terminal is
unavailable. Neither needs a direct OpenRouter client or a new lifecycle system.

## Findings

### 1. [P1] Claude's permission replacement discards unrelated owner restrictions

**Plan claim:** Exact File List item 1, launcher_command (line 38), plus Risks
and Mitigations (line 141), replaces an existing OPENCODE_PERMISSION value with
a new object containing only external_directory grants.

**Rule:** Adding access to coordinator artifacts must preserve unrelated
owner-configured tool rules. Supporting a new harness does not require deleting
its existing bash/edit restrictions, and documentation of that deletion does not
preserve the policy.

**Concrete failure:** An owner starts with
`OPENCODE_PERMISSION='{"bash":"deny","edit":"deny"}'` and no equivalent
config-file rules. On an automated issue, the proposed assignment removes both
denials from the environment inherited by OpenCode. Those tools fall back to
their ordinary defaults rather than the owner's restrictions. Keeping
config-file permissions, as the plan notes, cannot preserve rules supplied only
through the environment. OpenCode documents permissive defaults for most tools
and explicit deny behavior in its [permission reference](https://opencode.ai/docs/permissions/).

Smallest correction: retain the existing permission environment and let the
owner approve the external paths in this attended mode. If generated grants
remain, define and test an actual merge that preserves unrelated keys and
explicit denials, with a non-destructive path for malformed input.

### 2. [P2] Claude leaves explicit owner reminders on the wrong key path

**Plan claim:** The Scope decision and Exact File List's “Unchanged on purpose”
entry for src/tmux.ts (line 59) defer all terminal work because delivery is pull;
the setup changes add only the OpenCode label and delivery selection.

**Rule:** A supported participant selectable in the existing owner reminder
menu must receive the literal action text and its appropriate default submit
key. Pull delivery disables automatic nudges, not explicit owner reminders.

**Concrete failure:** RunLoop.reminders includes every configured agent, and
TmuxController.remind calls resolveNudgeKeys even for pull agents. With the
planned generated OpenCode configuration and an ordinary non-vim prompt, the
current code returns prelude `["a"]` and submit `["Escape", "Enter"]`. A focused
injected-runner reproduction sent the literal `a`, then a space plus the action
text, then Escape and Enter, and reported success. The message is already
corrupted by the added letter; Escape also invokes OpenCode's interrupt binding.
The upstream [keybinding reference](https://opencode.ai/docs/keybinds/) identifies
Return as submit and Escape as interrupt. No live-screen assumption is needed
to show the coordinator sends the wrong default keys.

Smallest correction: add OpenCode's empty prelude/Enter defaults and avoid the
generic vim fallback, with an owner-reminder case in the existing tmux tests.
A full automatic readiness adapter can remain deferred.

### 3. [P2] Claude's directory conversion does not preserve literal path scope

**Plan claim:** Exact File List item 1 (line 38) turns each directory into a
JSON key ending in /** after escaping only backslash and quote, asserting that
the grant covers the same four directories “and nothing wider.” Risks and
Mitigations (line 140) acknowledges wildcard characters but only documents them.

**Rule:** A literal directory grant must not become a pattern that authorizes a
different workspace, and serialized permission configuration must remain valid
for paths accepted by the coordinator. A documented limitation is insufficient
when the proposed implementation still emits an overbroad or malformed grant.

**Concrete failure:** A valid mailbox root containing the literal directory
name project?x produces a grant such as
`/tmp/mailboxes/project?x/issue-257/opencode/**`. OpenCode's documented wildcard
semantics make that match a separate projectAx workspace's mailbox too.
The coordinator's root validation checks overlap and symlinks, not wildcard
characters. Independently, a newline in a valid directory name survives the
specified quote/backslash escaping and produces invalid JSON; the spaced-path
test does not exercise this. OpenCode documents `*` and `?` matching in its
[permission reference](https://opencode.ai/docs/permissions/#wildcards).

Smallest correction: use actual JSON serialization and a proven literal-path
representation, or leave such paths subject to native permission prompts rather
than emitting a wider allow rule. Removing generated permission overrides, as
suggested in finding 1, also removes this new conversion problem.

### 4. [P2] Claude's declared file map expands to files explicitly left unchanged

**Plan claim:** Exact File List names seven changed files, lists several others
as “Unchanged on purpose,” and leaves its three modified test files in Tests.

**Rule:** Every intended modification must be named in the file-list section,
and the mechanically extracted approved map must match the stated change scope.
Reuse-only paths belong in Reuse and Scope, which the existing extractor excludes.

**Concrete failure:** Running extractApprovedPaths against the bound Claude plan
includes the entire githooks/ directory, githooks/post-merge, AGENTS.md,
src/state.ts, src/tmux.ts, src/agentEvent.ts, src/install.ts, and src/doctor.ts,
despite the stated exclusions. It also includes incidental tokens such as
config.json, start.json, start-opencode.sh, agentVersions.opencode, and the
.opencode/, .muse/, and .cursor/ trees. The resulting approved scope therefore
permits unrelated changes instead of enforcing the seven-file proposal and its
tests. In particular it broadens the workflow-critical hook scope the plan says
will remain unchanged. Separately, the three intended test modifications are
missing from the explicit file list required by the action.

Smallest correction: list all intended source, documentation, and test changes
explicitly; move unchanged/reused paths into Reuse and Scope; avoid backticked
incidental path-like tokens elsewhere. Validate that extractApprovedPaths
returns exactly the intended list before publishing the revised plan.

### Scope, reuse, and verification assessment

Claude's interactive-only feature scope is acceptable under the issue's stated
alternative. The shared launcher, version table, existing directory computation,
doctor behavior, and existing installer fixtures are appropriate reuse. No new
source files, abstractions, or dependencies are proposed. Its three test cases
are focused, but need the permission-preservation/path cases if that override
remains, and the owner-send case above. Its named fast-config command excludes
the installer and CLI suites in this repository; replace the conditional
instruction with exact fast/system commands. The requested test assertion that
OpenCode “has no update command” should say automatic updating is skipped:
OpenCode documents an [upgrade command](https://opencode.ai/docs/cli/#upgrade).

The Codex plan has no blocking findings from this review. Its additional runtime
model field and propagation implement the other option explicitly named by the
issue. The setting uses the existing typed/frozen agent record and shared launch
path, with focused cases for quoting, persistence, recovery, and unchanged native
permissions. Its eleven-file map extracts exactly as declared. It names existing
fixtures, proposes no new files/dependencies, and separates fast and system
commands correctly. The additional model feature is a scope choice, not a reason
to require it in Claude's otherwise valid interactive-only alternative.

Verification performed for this review: direct reading of both bound plans and
relevant existing code; approved-path extraction for both plans; a pure
resolveNudgeKeys call and simulated TmuxController.remind with an injected runner;
and small in-memory reproductions of the proposed permission replacement,
wildcard interpretation, and JSON escaping. No real terminal input, provider
request, product suite, or live OpenCode test was run. The wildcard reproduction
uses the documented matcher contract, not a claim that an installed OpenCode
binary was executed. Upstream permission/key/CLI documentation was checked.

## Conclusion

**Claude plan 200ca23013a8a94bf29759b68b9595d91547c24b: revise.** Preserve owner
permissions, correct explicit owner-send keys, remove or make safe the literal
path conversion, and publish an exact mechanically verified file map.

**Codex plan 1db91964c3920092fd1a74bd081a0ad6f4e7dc15: approve.** Its optional
model support is within issue scope, and its attended-mode limitation and lack
of live OpenCode evidence are explicit. Product acceptance still depends on
implementation review and the checks required by the subsequent action.
