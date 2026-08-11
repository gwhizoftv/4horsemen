import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

export const MANAGED_HOOK_MARKER = "# coord-managed-hook-v1";
export const HOOK_NAMES = ["commit-msg", "post-commit", "post-merge", "pre-commit", "pre-push"] as const;
export type HookMode = "shim" | "vendor";

export type HookInstall = {
  cloneRoot: string;
  gitDir: string;
  agent: string;
  installRoot: string;
  workspaceConfig: string;
  mode: HookMode;
};

const shellToken = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`");

const renderShim = (template: string, install: HookInstall, hook: string): string =>
  template
    .replaceAll("@HOOK_NAME@", shellToken(hook))
    .replaceAll("@AGENT_ID@", shellToken(install.agent))
    .replaceAll("@WORKSPACE_CONFIG@", shellToken(install.workspaceConfig))
    .replaceAll("@HOOK_MODE@", install.mode)
    .replaceAll("@INSTALL_ROOT@", shellToken(install.installRoot));

export const expectedHookShim = (install: HookInstall, hook: string): string =>
  renderShim(readFileSync(join(install.installRoot, "templates", "hooks", "shim.sh"), "utf8"), install, hook);

const writeExecutableIfChanged = (path: string, content: string): boolean => {
  if (existsSync(path) && readFileSync(path, "utf8") === content) {
    chmodSync(path, 0o755);
    return false;
  }
  writeFileSync(path, content, { encoding: "utf8", mode: 0o755 });
  chmodSync(path, 0o755);
  return true;
};

const copyCanonicalHooks = (install: HookInstall): void => {
  const destination = join(install.gitDir, "hooks", ".coord-vendor", "githooks");
  mkdirSync(join(destination, "lib"), { recursive: true });
  for (const hook of HOOK_NAMES) {
    copyFileSync(join(install.installRoot, "githooks", hook), join(destination, hook));
    chmodSync(join(destination, hook), 0o755);
  }
  for (const file of ["identity.sh", "verify.mjs"]) {
    copyFileSync(join(install.installRoot, "githooks", "lib", file), join(destination, "lib", file));
  }
};

export const installHooks = (install: HookInstall): { changed: boolean; preserved: string[] } => {
  const hookDirectory = join(install.gitDir, "hooks");
  mkdirSync(hookDirectory, { recursive: true });
  const preserved: string[] = [];
  let changed = false;
  if (install.mode === "vendor") copyCanonicalHooks(install);

  for (const hook of HOOK_NAMES) {
    const path = join(hookDirectory, hook);
    const backup = `${path}.coord-original`;
    if (existsSync(path) && !readFileSync(path, "utf8").includes(MANAGED_HOOK_MARKER)) {
      if (existsSync(backup)) {
        throw new Error(`Cannot preserve existing ${path}: ${backup} already exists.`);
      }
      renameSync(path, backup);
      preserved.push(hook);
      changed = true;
    }
    changed = writeExecutableIfChanged(path, expectedHookShim(install, hook)) || changed;
  }
  return { changed, preserved };
};

export const uninstallHooks = (gitDir: string): boolean => {
  const hookDirectory = join(gitDir, "hooks");
  let changed = false;
  for (const hook of HOOK_NAMES) {
    const path = join(hookDirectory, hook);
    const backup = `${path}.coord-original`;
    if (existsSync(path) && readFileSync(path, "utf8").includes(MANAGED_HOOK_MARKER)) {
      unlinkSync(path);
      changed = true;
    }
    if (existsSync(backup) && !existsSync(path)) {
      renameSync(backup, path);
      changed = true;
    }
  }
  const vendor = join(hookDirectory, ".coord-vendor");
  if (existsSync(vendor)) {
    rmSync(vendor, { recursive: true, force: true });
    changed = true;
  }
  return changed;
};

export const hookDigest = (installRoot: string): string => {
  const hash = createHash("sha256");
  for (const path of [
    ...HOOK_NAMES.map((hook) => join(installRoot, "githooks", hook)),
    join(installRoot, "githooks", "lib", "identity.sh"),
    join(installRoot, "githooks", "lib", "verify.mjs")
  ]) {
    hash.update(path.slice(installRoot.length));
    hash.update(readFileSync(path));
  }
  return hash.digest("hex");
};

export const writeVendorStamp = (gitDir: string, commit: string, digest: string): void => {
  const root = join(gitDir, "hooks", ".coord-vendor");
  mkdirSync(root, { recursive: true });
  const path = join(root, "stamp.json");
  const content = `${JSON.stringify({ commit, hookDigest: digest }, null, 2)}\n`;
  if (!existsSync(path) || readFileSync(path, "utf8") !== content) writeFileSync(path, content, "utf8");
};

export const vendorStampPath = (gitDir: string): string => join(gitDir, "hooks", ".coord-vendor", "stamp.json");
