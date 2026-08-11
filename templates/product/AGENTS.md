# Agent Workflow — {{PROJECT_NAME}}

Coordination constrains **agents and the owner control plane**. It does not
constrain other developers of this product. Humans may use a plain clone with
no `coord`, no Node, and no coordination hooks.

## Branch scheme

- `{{SHARED_BRANCH}}` — shared truth. Agents never commit or push here.
- `issue-<n>/<agent>` — each agent's working branch for issue n.
- `issue-<n>/final` — consensus branch; updated only by PR merge.

## Hard rules (agents)

- Never commit on `{{SHARED_BRANCH}}` or any `issue-*/final` branch.
- Never commit or push to another agent's branch.
- Never use `--no-verify`, `--force`, or change hook wiring to bypass gates.
- Commit messages start with your agent label (for example `Cursor: …`).
- If a hook blocks you, fix the underlying state.

## Evidence (transient)

During a run, agent branches may carry `.plans/`, `.signals/`, and
`.code-reviews/` for the active issue. R7 finalization deletes those paths
before a merge-ready PR. Maintainers on `{{SHARED_BRANCH}}` should not see
permanent coordination litter.

## Verify

Local commit/push gates and finalization checks are declared as argv in the
owner workspace config under coord-root — not by sniffing this product's
package manifests.
