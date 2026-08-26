## Comparison

The bound implementations are cursor `029a6844bfe626e9477ba416d3c5835ec3eaf797`, claude `ca1b8d0e87237099b903e7d2bcf8e60ab4ab124f`, and codex `02c14e68114d999609f9586c0c0c3c0a20254b05`.

Codex is the preferred implementation. It most closely follows the selected plan: private response-mode ballot actions, strict response validation and immutable archiving, durable coordinator-owned evidence publication, response-derived provenance, roster-aware invalidation, launcher grants, reporting, and focused tests. Its implementation is also the smallest of the three (36 files versus 49 for Cursor and 51 for Claude), reducing unrelated surface area.

Cursor and Claude both implement the broad response/publication design, but add substantially larger changes and retain more compatibility scaffolding. Cursor's branch includes additional plan/review ballot artifacts and broader test changes; Claude similarly carries extra compatibility and wipe-state changes. Those differences increase review and regression surface without improving the selected plan's core guarantees over Codex.

No blocking correctness finding is established from the bound diffs alone. All three pins include the required workflow-critical modules; Codex's focused test suite passed before publication, and its implementation pin is the one selected by the plan ballot.
