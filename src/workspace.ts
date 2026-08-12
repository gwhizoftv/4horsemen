import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { localConfigGet, localConfigSet, localConfigUnset, worktreeRoot } from "./gitExec.js";
import { assertNoSymlink, containedPath, isPathInside } from "./paths.js";

/**
 * Where one product's config and run state live inside the owner's runtime.
 *
 * This is the only module allowed to decide flat versus nested. Before it
 * existed, `install`, `start`, `doctor`, and `uninstall` each joined
 * `workspaces/<project>` for themselves, which is how a command could write one
 * layout and another could fail to find it.
 *
 * The happy path is flat: a runtime serving one product holds its `config.json`,
 * `mirror.git`, and `issue-N/` directly. A runtime serving several products
 * nests every product after the first under `workspaces/<project>/`, including
 * its run state — GitHub issue numbers are repository-local, so two products
 * sharing one `issue-42/` would share cursors, journal, digest, and mirror.
 */

/**
 * The owner's pointer from a product clone back to its workspace config.
 *
 * Deliberately NOT `coord.workspaceConfig`. `consensus_wiring_present` in
 * `githooks/lib/identity.sh` treats `coord.installRoot`, `coord.cliEntry`, and
 * `coord.workspaceConfig` as proof that a clone is an agent clone; a product
 * carrying any of them and no `consensus.agentId` would fail every commit
 * closed the moment hooks were present in it for any reason.
 */
export const OWNER_LOCATOR_KEY = "coord.ownerWorkspaceConfig";

export type WorkspaceLayout = "flat" | "nested";

export type WorkspaceLocation = {
  /** The operator's outer runtime directory, as given by `--coord-root`. */
  coordRoot: string;
  /** Root of this product's config and run state; equals `coordRoot` when flat. */
  workspaceRoot: string;
  configPath: string;
  layout: WorkspaceLayout;
};

export const flatWorkspace = (coordRoot: string): WorkspaceLocation => {
  const root = resolve(coordRoot);
  return { coordRoot: root, workspaceRoot: root, configPath: join(root, "config.json"), layout: "flat" };
};

export const nestedWorkspace = (coordRoot: string, project: string): WorkspaceLocation => {
  const root = resolve(coordRoot);
  const workspaceRoot = containedPath(root, "workspaces", project);
  return { coordRoot: root, workspaceRoot, configPath: join(workspaceRoot, "config.json"), layout: "nested" };
};

/**
 * The `project` field of a config, read leniently.
 *
 * Layout resolution must keep working for a config the schema would reject:
 * `doctor` exists to report exactly that config, and it cannot report one it
 * could not locate.
 */
const configProject = (path: string): string | null => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { project?: unknown };
    return typeof parsed.project === "string" && parsed.project !== "" ? parsed.project : null;
  } catch {
    return null;
  }
};

export type ResolveOptions = {
  /**
   * Accept a flat config whose `project` cannot be read.
   *
   * `doctor` sets this: a config too corrupt to parse is precisely what it
   * exists to report, and it cannot report a workspace it refused to locate.
   * `install` leaves it off, so an unreadable config belonging to some other
   * product is never adopted and overwritten.
   */
  acceptUnreadableFlat?: boolean;
};

/** The installed workspace for `project`, or null when it is not installed. */
export const resolveInstalledWorkspace = (
  coordRoot: string,
  project: string,
  options: ResolveOptions = {}
): WorkspaceLocation | null => {
  const flat = flatWorkspace(coordRoot);
  const flatExists = existsSync(flat.configPath);
  const flatProject = flatExists ? configProject(flat.configPath) : null;
  // Flat wins on a tie: a runtime that holds both is mid-migration, and the
  // flat config is the one this version writes.
  if (flatExists && flatProject === project) return flat;
  const nested = nestedWorkspace(coordRoot, project);
  if (existsSync(nested.configPath)) return nested;
  if (flatExists && flatProject === null && options.acceptUnreadableFlat === true) return flat;
  return null;
};

/**
 * Where a fresh or repeated install writes.
 *
 * An already-installed workspace is returned unchanged — reinstalling to repair
 * a hook must never relocate a runtime out from under in-flight issue state.
 * Otherwise flat, unless the flat slot already belongs to another product.
 */
export const selectWorkspaceForInstall = (coordRoot: string, project: string): WorkspaceLocation => {
  const installed = resolveInstalledWorkspace(coordRoot, project);
  if (installed !== null) return installed;
  const flat = flatWorkspace(coordRoot);
  if (existsSync(flat.configPath)) return nestedWorkspace(coordRoot, project);
  // A runtime that already nests products keeps nesting them; adopting the flat
  // slot for product three would make the layout depend on install order.
  if (existsSync(join(resolve(coordRoot), "workspaces"))) return nestedWorkspace(coordRoot, project);
  return flat;
};

/**
 * The location described by an explicit `--config` (and optional `--coord-root`).
 *
 * A config that lives inside the runtime describes its own workspace root, flat
 * or nested. A config kept anywhere else — the long-supported advanced form,
 * where the operator hand-maintains a config file outside the runtime — puts
 * run state under the `--coord-root` they named, which is what that flag has
 * always meant.
 */
export const workspaceFromConfigPath = (configPath: string, coordRoot?: string): WorkspaceLocation => {
  const path = resolve(configPath);
  const directory = resolve(path, "..");
  if (coordRoot === undefined) {
    const outer = resolve(directory, "..");
    const isNested = basename(resolve(outer)) === "workspaces";
    return {
      coordRoot: isNested ? resolve(outer, "..") : directory,
      workspaceRoot: directory,
      configPath: path,
      layout: isNested ? "nested" : "flat"
    };
  }
  const outer = resolve(coordRoot);
  if (!isPathInside(outer, directory)) {
    return { coordRoot: outer, workspaceRoot: outer, configPath: path, layout: "flat" };
  }
  return {
    coordRoot: outer,
    workspaceRoot: directory,
    configPath: path,
    layout: directory === outer ? "flat" : "nested"
  };
};

// ------------------------------------------------------- the owner locator --

/**
 * Record, in the owner's own product clone, which workspace config drives it.
 *
 * `.git/config` is untracked and per-clone: the product's tracked tree is
 * unchanged, `git status` stays empty, and a human who clones the same remote
 * inherits nothing. It is written only by `onboard`/`install`, never by an
 * agent, and it is the only thing `coord N` needs to find the runtime.
 */
export const writeOwnerLocator = (productRoot: string, configPath: string): void => {
  localConfigSet(productRoot, OWNER_LOCATOR_KEY, resolve(configPath));
};

/** Clear the locator, but only when it still points at the workspace being removed. */
export const clearOwnerLocator = (productRoot: string, configPath: string): boolean => {
  if (!existsSync(productRoot)) return false;
  if (worktreeRoot(productRoot) === null) return false;
  const current = localConfigGet(productRoot, OWNER_LOCATOR_KEY);
  if (current === null || resolve(current) !== resolve(configPath)) return false;
  localConfigUnset(productRoot, OWNER_LOCATOR_KEY);
  return true;
};

export type LocatorResolution =
  | { kind: "ok"; productRoot: string; location: WorkspaceLocation }
  | { kind: "not-a-worktree"; path: string }
  | { kind: "not-onboarded"; productRoot: string }
  | { kind: "stale"; productRoot: string; configPath: string };

/**
 * Resolve a product directory (or any directory inside it) to its workspace.
 *
 * Every failure is named, because the remediation differs: a path that is not a
 * repository at all, a repository that was never onboarded, and an onboarded
 * repository whose runtime has since been deleted are three different mistakes.
 */
export const resolveWorkspaceFromDirectory = (directory: string): LocatorResolution => {
  const root = worktreeRoot(directory);
  if (root === null) return { kind: "not-a-worktree", path: resolve(directory) };
  const configPath = localConfigGet(root, OWNER_LOCATOR_KEY);
  if (configPath === null) return { kind: "not-onboarded", productRoot: root };
  if (!existsSync(configPath)) return { kind: "stale", productRoot: root, configPath };
  assertNoSymlink(resolve(configPath, ".."), configPath);
  return { kind: "ok", productRoot: root, location: workspaceFromConfigPath(configPath) };
};

export const describeLocatorFailure = (resolution: Exclude<LocatorResolution, { kind: "ok" }>): string => {
  if (resolution.kind === "not-a-worktree") {
    return (
      `${resolution.path} is not inside a git worktree, so there is no product to resolve.\n` +
      "  Run this from an onboarded product (or one of its agent clones), or pass --product <path>."
    );
  }
  if (resolution.kind === "not-onboarded") {
    return (
      `${resolution.productRoot} has not been onboarded, so coord does not know its runtime.\n` +
      `  Fix: coord onboard ${resolution.productRoot}`
    );
  }
  return (
    `${resolution.productRoot} points at ${resolution.configPath}, which no longer exists.\n` +
    `  Fix: coord onboard ${resolution.productRoot}`
  );
};
