import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256, sha256OfFile } from "./hash.js";
import { git, gitDir, localConfigGet, localConfigUnset } from "./gitExec.js";

/**
 * Hook wiring for AGENT CLONES only.
 *
 * Everything here writes into a clone's `.git/hooks/`, which is untracked by
 * construction and is git's default hooks path. Two properties follow, and both
 * are load-bearing:
 *
 *   1. A human clone of the same product remote receives nothing. Coordination
 *      constrains agents and the owner control plane, not the product's other
 *      developers.
 *   2. The presence of a hook *is* the signal that this clone is an agent
 *      clone, so an unresolvable install root or identity can fail closed here
 *      without ever punishing a human.
 *
 * `core.hooksPath` is deliberately not used: when it points at a directory that
 * does not exist, git runs no hooks and reports nothing, which turns every gate
 * off silently. That is the one failure this project refuses.
 */

export const HOOK_NAMES = ["commit-msg", "post-commit", "post-merge", "pre-commit", "pre-push"] as const;
export type HookName = (typeof HOOK_NAMES)[number];

/** Support files a vendored clone needs beside the bodies, resolved by dirname. */
const VENDOR_LIB_FILES = ["lib/identity.sh", "lib/policy.sh", "lib/launcher.sh"] as const;

export const MANIFEST_NAME = "coord-hooks.json";

export type HookMode = "shim" | "vendor";

export type HookManifest = {
  mode: HookMode;
  installRoot: string;
  version: string;
  sourceCommit: string;
  writtenAt: string;
  files: Record<string, string>;
};

export type HookSyncInput = {
  clone: string;
  installRoot: string;
  version: string;
  sourceCommit: string;
  mode: HookMode;
  dryRun: boolean;
  now?: string;
};

export type HookSyncOutcome = {
  hooksDir: string;
  written: string[];
  unchanged: string[];
  clearedHooksPath: boolean;
};

const hooksDirOf = (clone: string): string => join(gitDir(clone), "hooks");

const shimTemplatePath = (installRoot: string): string => join(installRoot, "templates", "hooks", "shim.sh");

const bodyPath = (installRoot: string, name: string): string => join(installRoot, "githooks", name);

const launcherLibraryPath = (installRoot: string): string => join(installRoot, "scripts", "lib", "launcher.sh");

const sourcePathFor = (installRoot: string, relative: string): string =>
  relative === "lib/launcher.sh" ? launcherLibraryPath(installRoot) : bodyPath(installRoot, relative);

/** The exact bytes the manifest records, so drift is a content comparison. */
export const plannedHookContents = (input: Pick<HookSyncInput, "installRoot" | "mode">): Map<string, string> => {
  const planned = new Map<string, string>();
  if (input.mode === "shim") {
    const shim = readFileSync(shimTemplatePath(input.installRoot), "utf8");
    for (const name of HOOK_NAMES) planned.set(name, shim);
    return planned;
  }
  for (const name of HOOK_NAMES) planned.set(name, readFileSync(bodyPath(input.installRoot, name), "utf8"));
  for (const relative of VENDOR_LIB_FILES) {
    planned.set(relative, readFileSync(sourcePathFor(input.installRoot, relative), "utf8"));
  }
  return planned;
};

export const manifestPath = (clone: string): string => join(hooksDirOf(clone), MANIFEST_NAME);

export const readHookManifest = (clone: string): HookManifest | null => {
  const path = manifestPath(clone);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as HookManifest;
  } catch {
    return null;
  }
};

/**
 * Install the hook wiring. `shim` (the default) execs the single canonical body
 * from the coordination install, so an upgrade reaches every clone at once and
 * no copy can drift. `vendor` copies the bodies in, for a clone that must run
 * them without resolving `coord.installRoot`; the manifest stamps the source
 * commit so `coord doctor` can call a stale copy stale.
 */
export const writeCloneHooks = (input: HookSyncInput): HookSyncOutcome => {
  const hooksDir = hooksDirOf(input.clone);
  const planned = plannedHookContents(input);
  const written: string[] = [];
  const unchanged: string[] = [];

  // A clone migrating off the tracked-githooks layout still points core.hooksPath
  // at githooks/, which would shadow everything written below and leave the
  // operator reading hooks that are not the ones git runs.
  const hooksPath = localConfigGet(input.clone, "core.hooksPath");
  const clearedHooksPath = hooksPath !== null;

  for (const [relative, content] of planned) {
    const target = join(hooksDir, relative);
    if (existsSync(target) && readFileSync(target, "utf8") === content) {
      unchanged.push(relative);
      continue;
    }
    written.push(relative);
    if (input.dryRun) continue;
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content, "utf8");
    chmodSync(target, 0o755);
  }

  const manifest: HookManifest = {
    mode: input.mode,
    installRoot: input.installRoot,
    version: input.version,
    sourceCommit: input.sourceCommit,
    writtenAt: input.now ?? new Date().toISOString(),
    files: Object.fromEntries([...planned].map(([relative, content]) => [relative, sha256(content)]))
  };

  if (!input.dryRun) {
    if (clearedHooksPath) localConfigUnset(input.clone, "core.hooksPath");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(manifestPath(input.clone), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  return { hooksDir, written, unchanged, clearedHooksPath };
};

export type HookRemovalOutcome = { removed: string[]; kept: string[] };

/**
 * Remove only what this installer wrote, and only while it still matches what
 * the manifest recorded. A hook an operator edited by hand is left in place and
 * reported: uninstall is not licensed to delete work it did not create.
 */
export const removeCloneHooks = (clone: string, options: { dryRun: boolean }): HookRemovalOutcome => {
  const manifest = readHookManifest(clone);
  const removed: string[] = [];
  const kept: string[] = [];
  if (manifest === null) return { removed, kept };

  const hooksDir = hooksDirOf(clone);
  for (const [relative, digest] of Object.entries(manifest.files)) {
    const target = join(hooksDir, relative);
    if (!existsSync(target)) continue;
    if (sha256OfFile(target) !== digest) {
      kept.push(relative);
      continue;
    }
    removed.push(relative);
    if (!options.dryRun) rmSync(target);
  }

  if (!options.dryRun) rmSync(manifestPath(clone), { force: true });
  return { removed, kept };
};

export type HookDrift =
  | { kind: "absent" }
  | { kind: "ok"; mode: HookMode }
  | { kind: "unmanaged" }
  | { kind: "modified"; files: string[] }
  | { kind: "missing"; files: string[] }
  | { kind: "stale-vendor"; recordedCommit: string; installCommit: string }
  | { kind: "shadowed"; hooksPath: string };

/** Classify one clone's hook wiring for `coord doctor`. */
export const inspectCloneHooks = (input: {
  clone: string;
  installRoot: string;
  installCommit: string;
}): HookDrift => {
  const manifest = readHookManifest(input.clone);
  const hooksDir = hooksDirOf(input.clone);
  if (manifest === null) {
    const anyPresent = HOOK_NAMES.some((name) => existsSync(join(hooksDir, name)));
    return anyPresent ? { kind: "unmanaged" } : { kind: "absent" };
  }

  const hooksPath = localConfigGet(input.clone, "core.hooksPath");
  if (hooksPath !== null) return { kind: "shadowed", hooksPath };

  const missing: string[] = [];
  const modified: string[] = [];
  for (const [relative, digest] of Object.entries(manifest.files)) {
    const target = join(hooksDir, relative);
    if (!existsSync(target)) {
      missing.push(relative);
      continue;
    }
    if (sha256OfFile(target) !== digest) modified.push(relative);
  }
  if (missing.length > 0) return { kind: "missing", files: missing.sort() };
  if (modified.length > 0) return { kind: "modified", files: modified.sort() };

  if (manifest.mode === "vendor" && manifest.sourceCommit !== input.installCommit) {
    return { kind: "stale-vendor", recordedCommit: manifest.sourceCommit, installCommit: input.installCommit };
  }
  return { kind: "ok", mode: manifest.mode };
};

/**
 * Copy the canonical hook bodies into a product's tracked tree. Only reachable
 * through `--write-product --vendor`, which an owner asks for explicitly; the
 * default install never touches a tracked file.
 */
export const vendorIntoProductTree = (input: {
  productRoot: string;
  installRoot: string;
  dryRun: boolean;
}): string[] => {
  const targetDir = join(input.productRoot, "githooks");
  const relatives = [...HOOK_NAMES, ...VENDOR_LIB_FILES];
  const written: string[] = [];
  for (const relative of relatives) {
    const source = sourcePathFor(input.installRoot, relative);
    const target = join(targetDir, relative);
    const content = readFileSync(source, "utf8");
    if (existsSync(target) && readFileSync(target, "utf8") === content) continue;
    written.push(join("githooks", relative));
    if (input.dryRun) continue;
    mkdirSync(join(target, ".."), { recursive: true });
    copyFileSync(source, target);
    chmodSync(target, 0o755);
  }
  return written;
};

/** Resolve the commit a coordination checkout is currently at, for the stamp. */
export const installSourceCommit = (installRoot: string): string => {
  const result = git(installRoot, "rev-parse", "--verify", "HEAD^{commit}");
  if (result.exitCode !== 0) {
    throw new Error(
      `Cannot resolve the coordination install commit at ${installRoot}: ${result.stderr.trim()}. ` +
        "The install root must be a git checkout so the stamp can record what a workspace runs against."
    );
  }
  return result.stdout.trim();
};
