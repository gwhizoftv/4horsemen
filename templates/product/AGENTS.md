# Coordinated agent workflow

Coordination is installed only in dedicated agent clones. Human clones do not
need `coord`, Node, or coordination hooks. Agents work on `issue-<n>/<agent>`
branches, use the configured commit prefix, and publish transient evidence in
`.plans/`, `.signals/`, and `.code-reviews/`. The finalization step removes the
current issue's evidence before a merge-ready pull request is opened.
