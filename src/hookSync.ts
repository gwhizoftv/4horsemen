import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HOOK_NAMES = ["commit-msg", "post-commit", "post-merge", "pre-commit", "pre-push"] as const;
export type HookName = (typeof HOOK_NAMES)[number];

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const shimTemplatePath = (): string => join(packageRoot, "templates/hooks/shim.sh");

export const readShimTemplate = (): string => readFileSync(shimTemplatePath(), "utf8");

export const agentHooksDir = (cloneRoot: string): string => join(cloneRoot, ".git/hooks");

export const writeHookShims = (cloneRoot: string, options: { dryRun?: boolean } = {}): string[] => {
  const hooksDir = agentHooksDir(cloneRoot);
  const body = readShimTemplate();
  if (options.dryRun === true) {
    return HOOK_NAMES.map((name) => join(hooksDir, name));
  }
  mkdirSync(hooksDir, { recursive: true });
  const written: string[] = [];
  for (const name of HOOK_NAMES) {
    const path = join(hooksDir, name);
    writeFileSync(path, body, { mode: 0o755 });
    chmodSync(path, 0o755);
    written.push(path);
  }
  return written;
};

export const vendorHookBodies = (
  cloneRoot: string,
  installRoot: string,
  options: { dryRun?: boolean } = {}
): string[] => {
  const hooksDir = agentHooksDir(cloneRoot);
  const sourceDir = join(installRoot, "githooks");
  if (options.dryRun === true) {
    return HOOK_NAMES.map((name) => join(hooksDir, name));
  }
  mkdirSync(hooksDir, { recursive: true });
  mkdirSync(join(hooksDir, "lib"), { recursive: true });
  const written: string[] = [];
  for (const name of HOOK_NAMES) {
    const source = join(sourceDir, name);
    const target = join(hooksDir, name);
    if (!existsSync(source)) throw new Error(`Missing hook body ${source}`);
    copyFileSync(source, target);
    chmodSync(target, 0o755);
    written.push(target);
  }
  copyFileSync(join(sourceDir, "lib/identity.sh"), join(hooksDir, "lib/identity.sh"));
  const configSource = join(sourceDir, "lib/workspace-config.sh");
  if (existsSync(configSource)) {
    copyFileSync(configSource, join(hooksDir, "lib/workspace-config.sh"));
  }
  writeFileSync(join(hooksDir, ".coordination-vendor-stamp"), `${installRoot}\n`, { encoding: "utf8" });
  return written;
};

export const clearAgentHooks = (cloneRoot: string, options: { dryRun?: boolean } = {}): string[] => {
  const hooksDir = agentHooksDir(cloneRoot);
  const removed: string[] = [];
  for (const name of HOOK_NAMES) {
    const path = join(hooksDir, name);
    if (existsSync(path)) {
      removed.push(path);
      if (options.dryRun !== true) unlinkSync(path);
    }
  }
  const stamp = join(hooksDir, ".coordination-vendor-stamp");
  if (existsSync(stamp)) {
    removed.push(stamp);
    if (options.dryRun !== true) {
      unlinkSync(stamp);
      rmSync(join(hooksDir, "lib"), { recursive: true, force: true });
    }
  }
  return removed;
};
