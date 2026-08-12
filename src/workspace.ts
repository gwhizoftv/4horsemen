import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { localConfigGet, localConfigSet, localConfigUnset, worktreeRoot } from "./gitExec.js";
import { assertNoSymlink, containedPath, isPathInside } from "./paths.js";
import { coordinatorConfigSchema, type CoordinatorConfig } from "./state.js";

/**
 * Owner product-local locator. Distinct from the agent-clone keys in
 * githooks/lib/identity.sh (`coord.installRoot`, `coord.cliEntry`,
 * `coord.workspaceConfig`), which mark agent clones.
 */
export const OWNER_WORKSPACE_CONFIG_KEY = "coord.ownerWorkspaceConfig";

export type WorkspaceLayout = "flat" | "nested";

export type WorkspaceLocation = {
  /** Operator's outer runtime directory (may hold multiple products). */
  coordRoot: string;
  /** Config and run-state root for this product (`issue-N`, `mirror.git`). */
  workspaceRoot: string;
  configPath: string;
  layout: WorkspaceLayout;
};

const tryReadConfig = (path: string): CoordinatorConfig | null => {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const parsed = coordinatorConfigSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const flatConfigPath = (coordRoot: string): string => join(resolve(coordRoot), "config.json");

const nestedWorkspaceRoot = (coordRoot: string, project: string): string =>
  containedPath(resolve(coordRoot), "workspaces", project);

const nestedConfigPath = (coordRoot: string, project: string): string =>
  join(nestedWorkspaceRoot(coordRoot, project), "config.json");

const hasNestedWorkspaces = (coordRoot: string): boolean => {
  const workspaces = join(resolve(coordRoot), "workspaces");
  return existsSync(workspaces);
};

/**
 * Resolve an already-installed workspace. Flat wins when both a matching flat
 * and matching nested config exist.
 */
export const resolveInstalledWorkspace = (coordRoot: string, project: string): WorkspaceLocation | null => {
  const root = resolve(coordRoot);
  assertNoSymlink(root, root);

  const flatPath = flatConfigPath(root);
  const flat = tryReadConfig(flatPath);
  if (flat !== null && flat.project === project) {
    assertNoSymlink(root, flatPath);
    return {
      coordRoot: root,
      workspaceRoot: root,
      configPath: flatPath,
      layout: "flat"
    };
  }

  const nestedPath = nestedConfigPath(root, project);
  const nested = tryReadConfig(nestedPath);
  if (nested !== null && nested.project === project) {
    const workspaceRoot = nestedWorkspaceRoot(root, project);
    assertNoSymlink(root, nestedPath);
    return {
      coordRoot: root,
      workspaceRoot,
      configPath: nestedPath,
      layout: "nested"
    };
  }

  return null;
};

/**
 * Choose where a fresh install should place this product's config and run state.
 * An unoccupied outer runtime uses flat; a second product or an existing nested
 * layout uses nested without relocating the first product.
 */
export const chooseWorkspaceLocation = (coordRoot: string, project: string): WorkspaceLocation => {
  const existing = resolveInstalledWorkspace(coordRoot, project);
  if (existing !== null) return existing;

  const root = resolve(coordRoot);
  assertNoSymlink(root, root);
  const flatPath = flatConfigPath(root);
  const flat = tryReadConfig(flatPath);
  const flatOccupiedByOther = flat !== null && flat.project !== project;
  const nest = hasNestedWorkspaces(root) || flatOccupiedByOther || existsSync(flatPath);

  if (!nest) {
    return {
      coordRoot: root,
      workspaceRoot: root,
      configPath: flatPath,
      layout: "flat"
    };
  }

  const workspaceRoot = nestedWorkspaceRoot(root, project);
  return {
    coordRoot: root,
    workspaceRoot,
    configPath: join(workspaceRoot, "config.json"),
    layout: "nested"
  };
};

export const readOwnerWorkspaceConfig = (productRoot: string): string | null => {
  const value = localConfigGet(resolve(productRoot), OWNER_WORKSPACE_CONFIG_KEY);
  return value === null || value === "" ? null : value;
};

export const writeOwnerWorkspaceConfig = (productRoot: string, configPath: string): void => {
  const absolute = resolve(configPath);
  if (!absolute.startsWith("/")) {
    throw new Error(`Owner workspace config locator must be an absolute path; got ${configPath}.`);
  }
  localConfigSet(resolve(productRoot), OWNER_WORKSPACE_CONFIG_KEY, absolute);
};

export const clearOwnerWorkspaceConfig = (productRoot: string): void => {
  localConfigUnset(resolve(productRoot), OWNER_WORKSPACE_CONFIG_KEY);
};

export type ResolvedRuntime = {
  location: WorkspaceLocation;
  config: CoordinatorConfig;
  productRoot: string | null;
};

const locationFromConfigPath = (configPath: string, expectedProject?: string): WorkspaceLocation => {
  const absolute = resolve(configPath);
  assertNoSymlink(dirname(absolute), absolute);
  const config = tryReadConfig(absolute);
  if (config === null) {
    throw new Error(`Cannot read workspace config at ${absolute}. Run coord onboard <product> first.`);
  }
  if (expectedProject !== undefined && config.project !== expectedProject) {
    throw new Error(
      `Workspace config at ${absolute} is for project '${config.project}', not '${expectedProject}'.`
    );
  }
  const workspaceRoot = dirname(absolute);
  const parent = dirname(workspaceRoot);
  const nestedUnderWorkspaces =
    basename(parent) === "workspaces" && basename(workspaceRoot) === config.project;
  if (nestedUnderWorkspaces) {
    return {
      coordRoot: dirname(parent),
      workspaceRoot,
      configPath: absolute,
      layout: "nested"
    };
  }
  return {
    coordRoot: workspaceRoot,
    workspaceRoot,
    configPath: absolute,
    layout: "flat"
  };
};

/**
 * Resolve runtime from explicit flags, product locator, or cwd worktree locator.
 */
export const resolveRuntimeLocation = (input: {
  configPath?: string;
  coordRoot?: string;
  productRoot?: string;
  cwd: string;
  project?: string;
}): ResolvedRuntime => {
  if (input.configPath !== undefined && input.coordRoot !== undefined) {
    const configPath = resolve(input.cwd, input.configPath);
    const coordRoot = resolve(input.cwd, input.coordRoot);
    const config = tryReadConfig(configPath);
    if (config === null) throw new Error(`Cannot read workspace config at ${configPath}.`);
    const configDir = dirname(configPath);
    let location: WorkspaceLocation;
    if (resolve(configDir) === resolve(coordRoot)) {
      location = { coordRoot, workspaceRoot: coordRoot, configPath, layout: "flat" };
    } else if (isPathInside(join(coordRoot, "workspaces"), configDir) && basename(configDir) === config.project) {
      location = { coordRoot, workspaceRoot: configDir, configPath, layout: "nested" };
    } else {
      // Advanced/explicit: policy file may live apart from the runtime root.
      location = { coordRoot, workspaceRoot: coordRoot, configPath, layout: "flat" };
    }
    return {
      location,
      config,
      productRoot: config.coordination?.productRoot ?? null
    };
  }

  if (input.configPath !== undefined || input.coordRoot !== undefined) {
    throw new Error(
      "Provide both --config and --coord-root together, or use --product / cwd after coord onboard."
    );
  }

  const productRoot =
    input.productRoot !== undefined
      ? resolve(input.cwd, input.productRoot)
      : (worktreeRoot(input.cwd) ?? null);
  if (productRoot === null) {
    throw new Error(
      "No product worktree found. Run from an onboarded product, or pass --product <path> / --config with --coord-root.\n" +
        "  Fix: coord onboard <product>"
    );
  }

  const locator = readOwnerWorkspaceConfig(productRoot);
  if (locator === null) {
    throw new Error(
      `Product ${productRoot} has no ${OWNER_WORKSPACE_CONFIG_KEY} locator.\n` +
        `  Fix: coord onboard ${productRoot}`
    );
  }
  const absoluteLocator = resolve(locator);
  if (!existsSync(absoluteLocator)) {
    throw new Error(
      `Stale ${OWNER_WORKSPACE_CONFIG_KEY} at ${productRoot}: ${absoluteLocator} is missing.\n` +
        `  Fix: coord onboard ${productRoot}`
    );
  }

  const project = input.project ?? basename(resolve(productRoot));
  const location = locationFromConfigPath(absoluteLocator, project);
  const config = tryReadConfig(location.configPath);
  if (config === null) {
    throw new Error(`Cannot read workspace config at ${location.configPath}.`);
  }
  if (input.coordRoot !== undefined && resolve(input.coordRoot) !== location.coordRoot) {
    throw new Error(
      `--coord-root ${input.coordRoot} does not match the onboarded location ${location.coordRoot}.`
    );
  }
  return { location, config, productRoot };
};
