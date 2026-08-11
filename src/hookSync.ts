import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const coordinatorSourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export const HOOKS = ["commit-msg", "post-commit", "post-merge", "pre-commit", "pre-push"] as const;

export const installShims = (agentCloneRoot: string): void => {
  const hooksDir = join(agentCloneRoot, ".git", "hooks");
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

  const shimTemplate = readFileSync(join(coordinatorSourceRoot, "templates", "hooks", "shim.sh"), "utf8");

  for (const hook of HOOKS) {
    const hookPath = join(hooksDir, hook);
    writeFileSync(hookPath, shimTemplate, "utf8");
    chmodSync(hookPath, 0o755);
  }
};

export const installVendorCopies = (agentCloneRoot: string): void => {
  const hooksDir = join(agentCloneRoot, ".git", "hooks");
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

  for (const hook of HOOKS) {
    const hookPath = join(hooksDir, hook);
    const body = readFileSync(join(coordinatorSourceRoot, "githooks", hook), "utf8");
    writeFileSync(hookPath, body, "utf8");
    chmodSync(hookPath, 0o755);
  }
  
  const libDir = join(hooksDir, "lib");
  if (!existsSync(libDir)) mkdirSync(libDir, { recursive: true });
  const identityBody = readFileSync(join(coordinatorSourceRoot, "githooks", "lib", "identity.sh"), "utf8");
  writeFileSync(join(libDir, "identity.sh"), identityBody, "utf8");
  chmodSync(join(libDir, "identity.sh"), 0o755);
};

export const clearHooks = (agentCloneRoot: string): void => {
  const hooksDir = join(agentCloneRoot, ".git", "hooks");
  if (!existsSync(hooksDir)) return;
  for (const hook of HOOKS) {
    const hookPath = join(hooksDir, hook);
    if (existsSync(hookPath)) {
      // Only remove if it looks like our shim or we are forcing it, but uninstall is destructive to agent hooks anyway.
      rmSync(hookPath);
    }
  }
  const identityPath = join(hooksDir, "lib", "identity.sh");
  if (existsSync(identityPath)) rmSync(identityPath);
};
