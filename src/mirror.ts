import { spawnSync } from "node:child_process";
import { ensureContained, refuseInsideClones, resolveIssueRoot } from "./paths.js";
import { existsSync, mkdirSync } from "node:fs";

export const gitTimeoutMs = 15_000;

export type Mirror = {
  root: string;
};

const runGit = (root: string, args: readonly string[]) => {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: gitTimeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  });
  return {
    status: result.status,
    stdout: result.stdout === null ? Buffer.alloc(0) : Buffer.from(result.stdout),
    error: result.stderr === null ? "" : result.stderr.toString("utf8").trim()
  };
};

export const setupMirror = (coordRoot: string, issue: number, cloneRoots: string[]): Mirror => {
  refuseInsideClones(coordRoot, cloneRoots);
  const issueRoot = resolveIssueRoot(coordRoot, issue);
  const mirrorDir = ensureContained(issueRoot, "mirror.git");
  
  if (!existsSync(mirrorDir)) {
    mkdirSync(mirrorDir, { recursive: true });
    runGit(mirrorDir, ["init", "--bare"]);
  }
  return { root: mirrorDir };
};

export type FetchResult = "success" | "missing" | "transient-failure";

export const fetchOriginRef = (mirror: Mirror, originUrl: string, ref: string): FetchResult => {
  const result = runGit(mirror.root, ["fetch", "--force", originUrl, `refs/heads/${ref}:refs/heads/${ref}`]);
  if (result.status === 0) {
    return "success";
  }
  if (result.error.includes("couldn't find remote ref") || result.error.includes("fatal: couldn't find remote ref")) {
    return "missing";
  }
  return "transient-failure";
};

export const isReachable = (mirror: Mirror, sha: string, ref: string): boolean => {
  const result = runGit(mirror.root, ["merge-base", "--is-ancestor", sha, ref]);
  return result.status === 0;
};

export const readBlob = (mirror: Mirror, sha: string, path: string): Buffer | null => {
  const result = runGit(mirror.root, ["cat-file", "-p", `${sha}:${path}`]);
  if (result.status !== 0) {
    return null;
  }
  return result.stdout;
};
