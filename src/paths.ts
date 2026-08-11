import { isAbsolute, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";

export const resolveIssueRoot = (coordRoot: string, issue: number): string => {
  if (!isAbsolute(coordRoot)) {
    throw new Error(`coord-root must be an absolute path: ${coordRoot}`);
  }
  return resolve(coordRoot, `issue-${issue}`);
};

export const ensureContained = (root: string, derived: string): string => {
  const target = resolve(root, derived);
  const rel = relative(root, target);
  
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path ${derived} escapes the containment root ${root}`);
  }
  
  // Reject symlinks by resolving realpath if it exists
  try {
    const real = realpathSync(target);
    if (real !== target) {
      throw new Error(`Symlinks are rejected: ${target} resolves to ${real}`);
    }
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code !== "ENOENT") {
      throw error;
    }
  }
  
  return target;
};

export const refuseInsideClones = (coordRoot: string, cloneRoots: string[]): void => {
  for (const cloneRoot of cloneRoots) {
    const rel = relative(cloneRoot, coordRoot);
    if (!rel.startsWith("..") && !isAbsolute(rel)) {
      throw new Error(`coord-root ${coordRoot} is inside agent clone ${cloneRoot}`);
    }
  }
};
