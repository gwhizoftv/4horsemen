import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mirrorPath } from "./paths.js";

export class MirrorFetchError extends Error {
  constructor(message: string) { super(message); this.name = "MirrorFetchError"; }
}

/** Initialize a bare mirror if it doesn't exist. */
export function initMirror(coordRoot: string, originUrl: string): string {
  const mirror = mirrorPath(coordRoot);
  if (!existsSync(mirror)) {
    const result = spawnSync("git", ["clone", "--bare", "--no-tags", originUrl, mirror], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
    });
    if (result.status !== 0) {
      throw new MirrorFetchError(`Failed to initialize mirror: ${result.stderr?.trim() ?? result.error?.message ?? "unknown"}`);
    }
  }
  return mirror;
}

/** Fetch a specific ref from origin into the mirror. Returns true on success. Throws MirrorFetchError on transient failure. */
export function fetchRef(coordRoot: string, refspec: string): void {
  const mirror = mirrorPath(coordRoot);
  const result = spawnSync("git", ["-C", mirror, "fetch", "origin", refspec], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  });
  if (result.status !== 0) {
    const msg = result.stderr?.trim() ?? result.error?.message ?? "unknown error";
    throw new MirrorFetchError(`Mirror fetch failed for ${refspec}: ${msg}`);
  }
}

/** Fetch the issue branch ref for an agent. */
export function fetchAgentBranch(coordRoot: string, issue: number, agent: string): void {
  const ref = `refs/heads/issue-${issue}/${agent}:refs/heads/issue-${issue}/${agent}`;
  fetchRef(coordRoot, ref);
}

/** Check if a SHA is reachable from a named branch in the mirror. */
export function isReachable(coordRoot: string, sha: string, branch: string): boolean {
  const mirror = mirrorPath(coordRoot);
  const result = spawnSync("git", ["-C", mirror, "merge-base", "--is-ancestor", sha, branch], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000
  });
  return result.status === 0;
}

/** Read a blob at a specific commit and path. Returns null if not found. */
export function readBlob(coordRoot: string, sha: string, path: string): string | null {
  const mirror = mirrorPath(coordRoot);
  const result = spawnSync("git", ["-C", mirror, "show", `${sha}:${path}`], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000
  });
  if (result.status !== 0) return null;
  return result.stdout;
}

/** Check if a commit exists in the mirror. */
export function commitExists(coordRoot: string, sha: string): boolean {
  const mirror = mirrorPath(coordRoot);
  const result = spawnSync("git", ["-C", mirror, "cat-file", "-e", `${sha}^{commit}`], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000
  });
  return result.status === 0;
}

/** Check ancestry: is `ancestor` an ancestor of `descendant`? */
export function isAncestor(coordRoot: string, ancestor: string, descendant: string): boolean {
  const mirror = mirrorPath(coordRoot);
  const result = spawnSync("git", ["-C", mirror, "merge-base", "--is-ancestor", ancestor, descendant], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000
  });
  return result.status === 0;
}

/** List changed paths between two commits. */
export function changedPaths(coordRoot: string, base: string, head: string): string[] | null {
  const mirror = mirrorPath(coordRoot);
  const result = spawnSync("git", ["-C", mirror, "diff", "--name-only", base, head, "--"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000
  });
  if (result.status !== 0) return null;
  return result.stdout.trim().split("\n").filter(l => l.length > 0);
}
