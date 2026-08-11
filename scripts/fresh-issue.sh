#!/usr/bin/env bash
# fresh-issue.sh — start issue-<n>/<agent> from pristine main (no automation/).
set -euo pipefail
agent="${1:-}"; issue="${2:-}"
[[ -n "$agent" && -n "$issue" ]] || { echo "Usage: scripts/fresh-issue.sh <agent> <issue>" >&2; exit 2; }
[[ "$issue" =~ ^[0-9]+$ ]] || { echo "Issue must be a number" >&2; exit 2; }
repo_root="$(git rev-parse --show-toplevel)"; cd "$repo_root"
configured="$(git config --get consensus.agentId || true)"
[[ -n "$configured" ]] || { echo "Missing consensus.agentId; run setup from master." >&2; exit 3; }
[[ "$configured" == "$agent" ]] || { echo "This clone is '$configured', not '$agent'." >&2; exit 3; }
git fetch origin --prune
git diff --quiet && git diff --cached --quiet || { echo "Tracked changes present." >&2; exit 3; }
git checkout main && git reset --hard origin/main
branch="issue-${issue}/${agent}"
baseline="$(git rev-parse HEAD)"
if git show-ref --verify --quiet "refs/heads/$branch"; then
  tip="$(git rev-parse "$branch")"
  [[ "$tip" == "$baseline" ]] && git diff --quiet "$branch" || { echo "$branch not at baseline." >&2; exit 4; }
  git checkout "$branch"
else
  git checkout -b "$branch"
fi
mkdir -p ".plans/issue-${issue}" ".signals/issue-${issue}" ".code-reviews/issue-${issue}"
echo "issue-${issue}:${baseline}"
