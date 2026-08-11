# Agent Workflow

Three AI agents and one human maintainer work on this repo in parallel. Each
agent works in its own clone. This file is the single source of truth for the
workflow. Your agent identity and clone path are in your agent-specific memory
file — never act as another agent.

## Branch scheme
- `main` — shared truth. NEVER commit or push to it. Only the human merges here.
- `issue-<n>/<agent>` — your working branch for issue n, e.g. `issue-42/claude`.
  You may only commit/push to branches carrying YOUR agent name.
- `issue-<n>/final` — the consensus branch for issue n. Updated ONLY by merging
  the reviewed pull request. Never push to it directly.

## Workflow per issue
1. Sync: `git checkout main && git pull origin main`
2. The human assigns the issue and announces the issue number <n>.
3. Create YOUR branch: `git checkout -b issue-<n>/<your-agent-name>`
4. Implement the issue. Add tests. Run lint/typecheck/test/check. Commit and push.
5. The human picks the best implementation ("best-so-far").
6. REVIEW ROUND — if you are NOT best-so-far: fetch and study the best-so-far
   branch:
   `git fetch origin && git diff main...origin/issue-<n>/<winner>`
   Write concrete, actionable review comments. Do NOT push code to the winner's branch.
7. REVIEW ROUND — if you ARE best-so-far: read all review comments, incorporate
   what is correct, push revisions to your own branch, and reply to each comment
   stating what you changed or why you disagree.
8. Repeat 6–7 until both reviewers approve or the human stops the loop.
9. The human merges the winning branch into `issue-<n>/final` and eventually
   into `main`. Then everyone returns to step 1.

## Hard rules
- Never commit on `main` or any `issue-*/final` branch.
- Never commit/push to another agent's branch.
- Never use `--no-verify`, `--force`, `--force-with-lease`, or change `core.hooksPath`.
- Commit messages start with your agent label, e.g. `Claude: fix login redirect`.
- If a hook blocks you, the hook is right: fix the state it complains about.

## Conventions
- Prefer editing existing files over creating new ones.
- Add or update tests for behavior you change.
- Run the project check command before committing.
- For pnpm repos, use pnpm. Do not run npm install in a pnpm-lock.yaml repo.
