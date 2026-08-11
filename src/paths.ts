import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, parse, resolve, sep } from "node:path";

/**
 * Runtime path policy for the owner-side control tree.
 *
 * The coordinator must never be able to write inside an agent clone, so every
 * derived path is resolved, symlink-checked, and containment-checked against
 * the coord root before it is handed to an effectful boundary.
 *
 * Topology (all outside every configured clone):
 *
 *   <coordRoot>/
 *     mirror.git/
 *     issue-<n>/
 *       start.json
 *       cursors.json
 *       journal.jsonl
 *       agents/<agent>/
 *         action.md
 *         complete
 *         render.log
 */

export type CoordPathErrorCode =
  | "not-absolute"
  | "inside-agent-clone"
  | "contains-agent-clone"
  | "symlink-rejected"
  | "escapes-root"
  | "invalid-agent-id"
  | "invalid-issue";

export class CoordPathError extends Error {
  readonly code: CoordPathErrorCode;

  constructor(code: CoordPathErrorCode, message: string) {
    super(message);
    this.name = "CoordPathError";
    this.code = code;
  }
}

/** Agent ids become path segments, so they are restricted rather than escaped. */
const agentIdPattern = /^[a-z0-9][a-z0-9-]*$/;

export const assertValidAgentId = (agent: string): string => {
  if (!agentIdPattern.test(agent)) {
    throw new CoordPathError(
      "invalid-agent-id",
      `Agent id ${JSON.stringify(agent)} is not a valid path segment. Use lowercase letters, digits, and hyphens.`
    );
  }

  return agent;
};

export const assertValidIssue = (issue: number): number => {
  if (!Number.isInteger(issue) || issue < 1) {
    throw new CoordPathError("invalid-issue", `Issue must be a positive integer, received ${String(issue)}.`);
  }

  return issue;
};

/**
 * Resolve a path to its real location without requiring it to exist yet.
 * The nearest existing ancestor is realpath'd and the remaining segments are
 * re-appended, so a coord root that has not been created can still be
 * containment-checked against clones that do exist.
 */
export const realPathAllowingMissing = (target: string): string => {
  const absolute = resolve(target);
  const missing: string[] = [];
  let current = absolute;

  for (;;) {
    try {
      return resolve(realpathSync(current), ...missing.reverse());
    } catch {
      const { dir, base } = parse(current);

      if (dir === current || base === "") {
        return absolute;
      }

      missing.push(base);
      current = dir;
    }
  }
};

/** True when `child` is `parent` itself or lies beneath it. */
export const isContainedIn = (parent: string, child: string): boolean => {
  const parentResolved = resolve(parent);
  const childResolved = resolve(child);

  return childResolved === parentResolved || childResolved.startsWith(parentResolved + sep);
};

/**
 * Reject a symbolic link anywhere between `base` and `target`.
 *
 * The check is deliberately scoped to the control tree rather than the whole
 * absolute path. Links above the root are normal and outside our control —
 * macOS `/var` is itself a link — and a link in the root *is* handled, by
 * resolving the root before containment-checking it against every clone. What
 * must not exist is a link planted underneath an approved root, which would
 * redirect a contained-looking write into an agent worktree.
 */
export const assertNoSymlinkBelow = (base: string, target: string): void => {
  const baseResolved = resolve(base);
  const absolute = resolve(target);

  if (!isContainedIn(baseResolved, absolute)) {
    throw new CoordPathError(
      "escapes-root",
      `Refusing path ${absolute}: it escapes the control root ${baseResolved}.`
    );
  }

  const relative = absolute.slice(baseResolved.length);
  const segments = relative.split(sep).filter((segment) => segment !== "");
  let current = baseResolved;

  for (const segment of segments) {
    current = resolve(current, segment);

    let stats;

    try {
      stats = lstatSync(current);
    } catch {
      // Not created yet: nothing beyond this point can exist either.
      return;
    }

    if (stats.isSymbolicLink()) {
      throw new CoordPathError(
        "symlink-rejected",
        `Refusing to use ${absolute}: ${current} is a symbolic link inside the control root. The control tree must not redirect through a link.`
      );
    }
  }
};

/**
 * Validate the owner-supplied `--coord-root` against every configured agent
 * clone. Overlap is refused in both directions: a root inside a clone would
 * dirty an agent worktree, and a root containing a clone would let coordinator
 * writes reach one.
 */
export const resolveCoordRoot = (requested: string, agentRoots: readonly string[]): string => {
  if (!isAbsolute(requested)) {
    throw new CoordPathError(
      "not-absolute",
      `--coord-root must be an absolute path outside every configured clone, received ${JSON.stringify(requested)}.`
    );
  }

  // Resolving first is what defeats a root that links into a clone: the
  // containment checks below run against the real location, not the alias.
  const root = realPathAllowingMissing(requested);

  for (const agentRoot of agentRoots) {
    const resolvedAgentRoot = realPathAllowingMissing(agentRoot);

    if (isContainedIn(resolvedAgentRoot, root)) {
      throw new CoordPathError(
        "inside-agent-clone",
        `--coord-root ${root} is inside the configured clone ${resolvedAgentRoot}. Runtime state must live in the owner's folder, where it cannot dirty an agent worktree.`
      );
    }

    if (isContainedIn(root, resolvedAgentRoot)) {
      throw new CoordPathError(
        "contains-agent-clone",
        `--coord-root ${root} contains the configured clone ${resolvedAgentRoot}. Choose a control root that does not enclose any clone.`
      );
    }
  }

  return root;
};

/** Every runtime path for one issue, each proven to stay under the root. */
export type CoordPaths = {
  readonly root: string;
  readonly issue: number;
  readonly mirror: string;
  readonly issueDir: string;
  readonly startJson: string;
  readonly cursorsJson: string;
  readonly journal: string;
  readonly agentsDir: string;
  readonly worktreesDir: string;
  agentDir: (agent: string) => string;
  actionFile: (agent: string) => string;
  completeFile: (agent: string) => string;
  renderLog: (agent: string) => string;
};

/**
 * Join beneath the coord root and prove the result did not escape. Guards
 * against a `..` segment arriving through configuration or an agent id.
 */
export const containedJoin = (root: string, ...segments: readonly string[]): string => {
  const candidate = resolve(root, ...segments);

  if (!isContainedIn(root, candidate)) {
    throw new CoordPathError(
      "escapes-root",
      `Refusing path ${candidate}: it escapes the control root ${root}.`
    );
  }

  return candidate;
};

export const coordPaths = (root: string, issue: number): CoordPaths => {
  assertValidIssue(issue);

  const issueDir = containedJoin(root, `issue-${issue}`);
  const agentsDir = containedJoin(issueDir, "agents");
  const agentDir = (agent: string): string => containedJoin(agentsDir, assertValidAgentId(agent));

  return {
    root,
    issue,
    mirror: containedJoin(root, "mirror.git"),
    issueDir,
    startJson: containedJoin(issueDir, "start.json"),
    cursorsJson: containedJoin(issueDir, "cursors.json"),
    journal: containedJoin(issueDir, "journal.jsonl"),
    agentsDir,
    worktreesDir: containedJoin(issueDir, "worktrees"),
    agentDir,
    actionFile: (agent: string) => containedJoin(agentDir(agent), "action.md"),
    completeFile: (agent: string) => containedJoin(agentDir(agent), "complete"),
    renderLog: (agent: string) => containedJoin(agentDir(agent), "render.log")
  };
};
