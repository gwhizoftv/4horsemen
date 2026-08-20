## Comparison

This document compares the four implementation pins for Issue #76 (manual coordination mode):
- **Cursor**: `2857bc3ec2a2bc096a954299d454b67dea973fbf` at `.signals/issue-76/implementation-ready-cursor.json`
- **Antigravity**: `40647d94c0e4a1c6d9166b97fed9b9475b926ea5` at `.signals/issue-76/implementation-ready-antigravity.json`
- **Claude**: `40157df58f5fe280e10c694e8579f004536c9928` at `.signals/issue-76/implementation-ready-claude.json`
- **Codex**: `5402e1d02c8cca3dd9307281e242c4600dc2b83b` at `.signals/issue-76/implementation-ready-codex.json`

### Architectural Alignment

All four implementations adhere closely to the approved plan architecture:
1. **Manual Mode Entry & Exit (`coord manual` & `coord detach manual`)**:
   - Every implementation wires `coord manual` to resolve workspace configuration, validate configured agents, ensure tmux sessions and windows, and open macOS Terminal windows without creating issue runtimes, writing action files, or starting the run loop.
   - `coord detach manual` tears down manual tmux sessions and closes matching Terminal windows while leaving workspace configuration intact.
2. **Session Key & Title Group Polymorphism (`SessionKey = number | "manual"`)**:
   - All implementations generalize tmux session naming to `coord-<issue>[-<namespace>]` vs `coord-manual[-<group>]`, and window titles to `coord-<issue>-<group>/<agent>` vs `coord-manual-<group>/<agent>`.
   - All implementations properly clear `COORD_ISSUE` via `set-environment -u -t <session> COORD_ISSUE` for manual sessions.
3. **Mutual Exclusion**:
   - `coord manual` checks for active issue tmux sessions in the workspace and rejects start if any are active.
   - `startIssue`, `coord <issue>`, and `coord attach` verify no manual tmux session is active before proceeding.
4. **Uninstall Teardown**:
   - `detachAllOwnerUiSync` was updated in all implementations to tear down manual sessions and Terminal tabs on uninstall even when zero `issue-*` directories exist.
5. **Version & Documentation**:
   - All four implementations bumped `package.json` to version `0.0.12` and updated `config.product.example.json`.
   - All four updated `README.md`, `docs/coord-driver.md`, `docs/setup-workspace.md`, `AGENTS.md`, `templates/product/AGENTS.md`, and harness scripts (`launcher.sh`, `setup_claude.sh`, `setup_codex.sh`, `setup_cursor.sh`, `setup_antigravity.sh`).

### Implementation Details and Strengths

- **Antigravity (`40647d94c0e4a1c6d9166b97fed9b9475b926ea5`)**:
  - Implements clean `TmuxController.hasSession(sessionKey)` checking directly against tmux runner, avoiding foreign process runner collisions.
  - Adds dependency injection for `tmuxRunner` in `CliDependencies`, allowing deterministic and hermetic unit testing of CLI command dispatch and conflict checks without requiring active tmux.
  - Comprehensive unit test coverage with all 31 test suites and 341 tests passing cleanly.
- **Claude (`40157df58f5fe280e10c694e8579f004536c9928`)**:
  - Most extensive test coverage with extensive assertion sets covering edge cases in manual UI launch, resume, and teardown across multiple platforms.
  - Detailed documentation updates across all driver reference docs.
- **Codex (`5402e1d02c8cca3dd9307281e242c4600dc2b83b`)**:
  - Clean and concise implementation matching the selected plan specification.
  - Accurate hook policy and verification handling.
- **Cursor (`2857bc3ec2a2bc096a954299d454b67dea973fbf`)**:
  - Compact implementation with focused test suite enhancements and strict error message checking.

### Conclusion

All four implementations are complete, correct, and satisfy all acceptance criteria for Issue #76. All four pass the declared verification suites and pre-push gates.
