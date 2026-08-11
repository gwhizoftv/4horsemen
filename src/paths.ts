import { realpathSync, lstatSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";

export class PathConfinementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathConfinementError";
  }
}

/** Resolve and validate the external coord-root path. Rejects symlinks, paths inside any agent clone. */
export function resolveCoordRoot(requestedRoot: string, agentRoots: readonly string[]): string {
  const abs = resolve(requestedRoot);

  if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) {
    throw new PathConfinementError(
      `Coord root must not be a symlink: ${abs}`,
    );
  }

  const real = existsSync(abs) ? realpathSync(abs) : abs;

  for (const agentRoot of agentRoots) {
    if (!existsSync(agentRoot)) continue;
    const agentReal = realpathSync(agentRoot);
    const rel = relative(agentReal, real);
    if (!rel.startsWith("..") && rel !== "") {
      throw new PathConfinementError(
        `Coord root "${real}" is inside agent clone "${agentReal}"`,
      );
    }
    if (rel === "") {
      throw new PathConfinementError(
        `Coord root "${real}" is the same as agent clone "${agentReal}"`,
      );
    }
  }

  return real;
}

/** Resolve the issue directory within the coord root. */
export function issueDir(coordRoot: string, issue: number): string {
  return resolve(coordRoot, `issue-${issue}`);
}

/** Resolve the agents subdirectory for an issue. */
export function agentDir(coordRoot: string, issue: number, agent: string): string {
  return resolve(coordRoot, `issue-${issue}`, "agents", agent);
}

/** Path to the action.md file for an agent. */
export function actionPath(coordRoot: string, issue: number, agent: string): string {
  return resolve(agentDir(coordRoot, issue, agent), "action.md");
}

/** Path to the complete file for an agent. */
export function completePath(coordRoot: string, issue: number, agent: string): string {
  return resolve(agentDir(coordRoot, issue, agent), "complete");
}

/** Path to start.json. */
export function startJsonPath(coordRoot: string, issue: number): string {
  return resolve(issueDir(coordRoot, issue), "start.json");
}

/** Path to cursors.json. */
export function cursorsJsonPath(coordRoot: string, issue: number): string {
  return resolve(issueDir(coordRoot, issue), "cursors.json");
}

/** Path to journal.jsonl. */
export function journalPath(coordRoot: string, issue: number): string {
  return resolve(issueDir(coordRoot, issue), "journal.jsonl");
}

/** Path to the bare mirror. */
export function mirrorPath(coordRoot: string): string {
  return resolve(coordRoot, "mirror.git");
}
