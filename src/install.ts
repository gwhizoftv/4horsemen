import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { git, localConfigGet } from "./gitExec.js";
import {
  canonicalSourceDigest,
  installSourceCommit,
  removeCloneHooks,
  vendorIntoProductTree,
  writeCloneHooks,
  type HookMode
} from "./hookSync.js";
import { resolveSafeCoordRoot } from "./paths.js";
import { clearManagedIgnoreFile, DEFAULT_CLONE_IGNORES, writeManagedIgnoreFile } from "./productIgnore.js";
import {
  agentCloneDirectory,
  agentLabel,
  assertContainment,
  buildWorkspaceConfig,
  clearCloneExclude,
  clearCloneIdentity,
  cloneIsDirty,
  configureCloneIdentity,
  effectOptions,
  ensureAgentClone,
  productName,
  proposeProjectPolicy,
  writeAgentLauncher,
  writeCloneExclude,
  writeWorkspaceConfig,
  type EffectOptions,
  type Logger
} from "./setupWorkspace.js";
import {
  readConfig,
  workspaceDeclarationSchema,
  type CoordinatorConfig,
  type InstallStamp,
  type WorkspaceDeclaration
} from "./state.js";
import { agentIdSchema } from "./protocol.js";
import {
  chooseWorkspaceLocation,
  clearOwnerWorkspaceConfig,
  readOwnerWorkspaceConfig,
  resolveInstalledWorkspace,
  writeOwnerWorkspaceConfig,
  type WorkspaceLocation
} from "./workspace.js";

/**
 * `coord install` / `coord uninstall`.
 *
 * The governing rule, which decides every default below: coordination
 * constrains agents and the owner control plane, and does not constrain the
 * product's other developers. One person must be able to use plain VS Code on
 * the product repo — no `coord`, no Node, no new git obligations — while
 * another drives agents against the same remote. So the default install leaves
 * the product's tracked tree byte-for-byte unchanged, and every constraint
 * lands in agent clones or under `coord-root`.
 */

export type InstallOptions = {
  installRoot: string;
  productRoot: string;
  coordRoot: string;
  agents: readonly string[];
  profile: "solo" | "reviewed" | "consensus";
  cloneRoot?: string;
  declarePath?: string;
  origin?: string;
  baseBranch?: string;
  writeProduct: boolean;
  vendor: boolean;
  bootstrap: boolean;
  dryRun: boolean;
  /** Record the owner-local config locator on the product clone (onboard / default). */
  writeOwnerLocator?: boolean;
  log: Logger;
  now?: string;
};

export type InstallResult = {
  configPath: string;
  changes: string[];
  clones: string[];
};

const packageVersion = (installRoot: string): string => {
  const parsed = JSON.parse(readFileSync(join(installRoot, "package.json"), "utf8")) as { version?: string };
  return parsed.version ?? "0.0.0";
};

const readDeclaration = (path: string): WorkspaceDeclaration => {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Cannot parse --declare ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = workspaceDeclarationSchema.safeParse(value);
  if (!result.success) throw new Error(`Invalid --declare ${path}: ${result.error.message}`);
  return result.data;
};

/**
 * Every agent id must pass the coordinator's own schema, be unique, and have a
 * launcher this package knows how to write — all before it participates in a
 * path or any other effect.
 */
const validateAgentIds = (agents: readonly string[], installRoot: string): string[] => {
  if (agents.length === 0) throw new Error("--agents requires at least one agent id.");
  const seen = new Set<string>();
  for (const agent of agents) {
    const parsed = agentIdSchema.safeParse(agent);
    if (!parsed.success) {
      throw new Error(
        `'${agent}' is not a valid agent id. Agent ids are lowercase letters, digits, and hyphens, starting with a letter.`
      );
    }
    if (seen.has(agent)) throw new Error(`--agents lists '${agent}' more than once.`);
    seen.add(agent);
  }
  const library = join(installRoot, "scripts", "lib", "launcher.sh");
  for (const agent of agents) {
    const known = spawnSync("bash", ["-c", '. "$1"; launcher_command "$2" >/dev/null', "_", library, agent], {
      encoding: "utf8"
    });
    if ((known.status ?? 1) !== 0) {
      throw new Error(
        `No launch command is defined for agent '${agent}'. Add one to launcher_command() in ${library} before installing it.`
      );
    }
  }
  return [...agents];
};

const readPreviousConfig = (configPath: string): CoordinatorConfig | null => {
  if (!existsSync(configPath)) return null;
  try {
    return readConfig(configPath);
  } catch {
    return null;
  }
};

const requireWorktree = (path: string, description: string): string => {
  const result = git(path, "rev-parse", "--show-toplevel");
  if (result.exitCode !== 0) throw new Error(`${description} ${path} is not a git worktree.`);
  return result.stdout.trim();
};

const bootstrapCoordination = (installRoot: string, options: EffectOptions): void => {
  for (const argv of [
    ["pnpm", "install", "--frozen-lockfile"],
    ["pnpm", "build"]
  ]) {
    const [command, ...args] = argv;
    options.changes.push(`${argv.join(" ")} in ${installRoot}`);
    if (options.dryRun) {
      options.log(`would run ${argv.join(" ")} in ${installRoot}\n`);
      continue;
    }
    options.log(`running ${argv.join(" ")} in ${installRoot}\n`);
    const result = spawnSync(command as string, args, { cwd: installRoot, stdio: "inherit" });
    if ((result.status ?? 1) !== 0) throw new Error(`Bootstrap step '${argv.join(" ")}' failed in ${installRoot}.`);
  }
};

/** Metadata written under `.git/` by scripts/bootstrap.sh when it created the checkout. */
const BOOTSTRAP_OWNER_MARKER = "coord-bootstrap-owner";

const bootstrapOwnsInstallRoot = (installRoot: string): boolean => {
  const marker = join(installRoot, ".git", BOOTSTRAP_OWNER_MARKER);
  return existsSync(marker);
};

export const install = (options: InstallOptions): InstallResult => {
  const effects = effectOptions(options.log, options.dryRun);
  const installRoot = requireWorktree(resolve(options.installRoot), "The coordination install root");
  const productRoot = requireWorktree(resolve(options.productRoot), "The product");
  const project = productName(productRoot);
  const cloneRoot = resolve(options.cloneRoot ?? dirname(productRoot));

  // Identifiers become filesystem paths, so they are validated before anything
  // derives a path from them. Deferring to the config schema at step 6 meant a
  // traversal id had already produced a real clone outside the clone root, with
  // no workspace config left behind for uninstall to find it by.
  const agents = validateAgentIds(options.agents, installRoot);

  // ---- step 0: optional bootstrap of the coordination install itself -------
  if (options.bootstrap) bootstrapCoordination(installRoot, effects);

  // ---- step 1: preflight and containment ----------------------------------
  assertContainment({ productRoot, coordRoot: resolve(options.coordRoot), cloneRoot });
  const coordRoot = resolveSafeCoordRoot({
    coordRoot: resolve(options.coordRoot),
    agentRoots: options.agents.map((agent) => agentCloneDirectory(cloneRoot, project, agent)),
    create: !options.dryRun
  });

  const location = chooseWorkspaceLocation(coordRoot, project);

  const origin = options.origin ?? localConfigGet(productRoot, "remote.origin.url");
  if (origin === null || origin === "") {
    throw new Error(
      `The product ${productRoot} has no 'origin' remote. Agents publish evidence to a shared remote; add one or pass --origin.`
    );
  }
  const baseBranch = options.baseBranch ?? "main";
  if (git(productRoot, "rev-parse", "--verify", `refs/heads/${baseBranch}`).exitCode !== 0) {
    throw new Error(`The product ${productRoot} has no '${baseBranch}' branch.`);
  }

  const cliEntry = join(installRoot, "dist", "main.js");
  if (!existsSync(cliEntry) && !options.dryRun) {
    throw new Error(
      `The coordination install at ${installRoot} is not built: ${cliEntry} is missing.\n` +
        "  The hooks resolve declared verification through this entry point, so an unbuilt install would fail every commit.\n" +
        "  Fix: run `pnpm build` in the install root, or re-run with --bootstrap-coordination."
    );
  }

  const configPath = location.configPath;
  const proposal = proposeProjectPolicy(productRoot);
  const declared = options.declarePath === undefined ? null : readDeclaration(options.declarePath);
  const mode: HookMode = options.vendor ? "vendor" : "shim";
  const sourceCommit = installSourceCommit(installRoot);
  const version = packageVersion(installRoot);
  const canonicalDigest = canonicalSourceDigest(installRoot);

  // ---- step 1b: build the config BEFORE any effect -------------------------
  // Every declaration, schema, and launcher failure is knowable now. Building
  // this after the clone loop meant an undeclarable product left a fully wired
  // agent clone behind and no workspace config to uninstall it with.
  const agentsMdPath = join(productRoot, "AGENTS.md");
  const ownsInstallRoot = bootstrapOwnsInstallRoot(installRoot);
  const stamp: InstallStamp = {
    installRoot,
    cliEntry,
    version,
    commit: sourceCommit,
    canonicalDigest,
    installedAt: options.now ?? new Date().toISOString(),
    productRoot,
    cloneRoot,
    vendored: options.vendor,
    bootstrapped: options.bootstrap || ownsInstallRoot,
    ownsInstallRoot,
    wroteProductIgnore: options.writeProduct,
    wroteAgentsMd: options.writeProduct && !existsSync(agentsMdPath)
  };
  // Only used to carry a timestamp forward. A config that no longer parses —
  // typically one written before a schema change — must not stop the installer
  // that exists to rewrite it; regenerating is the repair.
  const previous = readPreviousConfig(configPath);
  const config = buildWorkspaceConfig(
    {
      project,
      origin,
      baseBranch,
      agents,
      cloneRoot,
      workspaceDir: location.workspaceRoot,
      profile: options.profile,
      declared,
      proposal
    },
    // A re-install must not look like a change just because time passed — but
    // only the timestamp may be carried over. Comparing three fields let a run
    // that newly wrote the product's ignore block keep `wroteProductIgnore:
    // false`, after which uninstall disowned and orphaned that block.
    previous?.coordination !== undefined &&
    JSON.stringify({ ...previous.coordination, installedAt: "" }) === JSON.stringify({ ...stamp, installedAt: "" })
      ? previous.coordination
      : stamp
  );

  // ---- steps 2-5: per-agent clone wiring ----------------------------------
  const clones: string[] = [];
  for (const agent of agents) {
    const clone = agentCloneDirectory(cloneRoot, project, agent);
    clones.push(clone);
    ensureAgentClone({ productRoot, origin, clone, baseBranch, options: effects });
    if (!existsSync(clone)) {
      // Dry run against a workspace that does not exist yet: the remaining
      // per-clone steps have nothing to inspect, and guessing would report
      // changes the real run might not make.
      effects.log(`would then wire launcher, exclude, identity, and hooks in ${clone}\n`);
      continue;
    }
    writeAgentLauncher({
      installRoot,
      clone,
      agent,
      label: agentLabel(agent),
      baseBranch,
      options: effects
    });
    writeCloneExclude(clone, effects);
    configureCloneIdentity(
      clone,
      {
        agent,
        label: agentLabel(agent),
        baseBranch,
        remoteName: "origin",
        installRoot: options.vendor ? null : installRoot,
        cliEntry,
        workspaceConfig: configPath
      },
      effects
    );
    const hooks = writeCloneHooks({
      clone,
      installRoot,
      version,
      sourceCommit,
      canonicalDigest,
      mode,
      dryRun: options.dryRun,
      now: options.now
    });
    if (hooks.clearedHooksPath) {
      effects.changes.push(`clear core.hooksPath in ${clone}`);
      effects.log(
        `${options.dryRun ? "would clear" : "cleared"} core.hooksPath in ${clone}; hooks now live in ${hooks.hooksDir}\n`
      );
    }
    if (hooks.preserved.length > 0) {
      effects.log(
        `preserved pre-existing hooks ${hooks.preserved.join(", ")} in ${hooks.hooksDir}; the shim chains them\n`
      );
    }
    if (hooks.repairedMode.length > 0) {
      effects.changes.push(`restore the execute bit on ${hooks.repairedMode.join(", ")} in ${clone}`);
      effects.log(
        `${options.dryRun ? "would restore" : "restored"} the execute bit on ${hooks.repairedMode.join(", ")}; git ignores a hook without it\n`
      );
    }
    if (hooks.written.length > 0) {
      effects.changes.push(`write hooks ${hooks.written.join(", ")} in ${clone}`);
      effects.log(`${options.dryRun ? "would write" : "wrote"} ${mode} hooks ${hooks.written.join(", ")} in ${hooks.hooksDir}\n`);
    } else if (hooks.repairedMode.length === 0) {
      effects.log(`hooks already current in ${hooks.hooksDir}\n`);
    }
  }

  // ---- optional, opt-in: tracked changes in the product --------------------
  if (options.writeProduct) {
    const ignorePath = join(productRoot, ".gitignore");
    const outcome = writeManagedIgnoreFile(ignorePath, DEFAULT_CLONE_IGNORES, { dryRun: options.dryRun });
    if (outcome.changed) {
      effects.changes.push(`update ${ignorePath}`);
      effects.log(`${options.dryRun ? "would update" : "updated"} ${ignorePath}\n`);
    }
    writeProductAgentsMd({
      productRoot,
      installRoot,
      project,
      baseBranch,
      toolchain: declared?.toolchain ?? proposal.toolchain,
      options: effects
    });
    if (options.vendor) {
      const written = vendorIntoProductTree({ productRoot, installRoot, dryRun: options.dryRun });
      if (written.length > 0) {
        effects.changes.push(`vendor hook bodies into ${productRoot}`);
        effects.log(`${options.dryRun ? "would vendor" : "vendored"} ${written.join(", ")} into the product tree\n`);
      }
    }
  }

  // ---- step 6: emit the workspace config under the resolved workspace ------
  writeWorkspaceConfig(location, config, effects);

  if (options.writeOwnerLocator !== false) {
    const current = readOwnerWorkspaceConfig(productRoot);
    if (current !== configPath) {
      effects.changes.push(`record owner locator on ${productRoot}`);
      if (options.dryRun) {
        effects.log(`would record ${configPath} as owner workspace locator on ${productRoot}\n`);
      } else {
        writeOwnerWorkspaceConfig(productRoot, configPath);
        effects.log(`recorded owner workspace locator on ${productRoot}\n`);
      }
    }
  }

  // ---- step 7: next steps, never run for the operator ----------------------
  options.log(
    [
      "",
      `Installed ${project} for agents: ${agents.join(", ")} (${location.layout} layout).`,
      `  workspace config : ${configPath}`,
      `  workspace root   : ${location.workspaceRoot}`,
      `  hook delivery    : ${mode}${options.vendor ? " (copies stamped at " + sourceCommit.slice(0, 12) + ")" : ""}`,
      `  product tree     : ${options.writeProduct ? "opt-in tracked changes written" : "untouched (git status unchanged)"}`,
      "",
      "Next steps — coord does not start anything for you:",
      `  gh issue create --title "…" --body "…"`,
      `  coord <issue>   # or: coord start <issue> --config ${configPath} --coord-root ${coordRoot}`,
      `  coord doctor --coord-root ${coordRoot} --product ${productRoot}`,
      ""
    ].join("\n")
  );

  return { configPath, changes: effects.changes, clones };
};

const writeProductAgentsMd = (input: {
  productRoot: string;
  installRoot: string;
  project: string;
  baseBranch: string;
  toolchain: string | undefined;
  options: EffectOptions;
}): void => {
  const target = join(input.productRoot, "AGENTS.md");
  if (existsSync(target)) {
    input.options.log(`AGENTS.md already exists in ${input.productRoot}; leaving it alone\n`);
    return;
  }
  const template = join(input.installRoot, "templates", "product", "AGENTS.md");
  const rendered = readFileSync(template, "utf8")
    .replaceAll("{{PROJECT}}", input.project)
    .replaceAll("{{BASE_BRANCH}}", input.baseBranch)
    .replaceAll("{{TOOLCHAIN}}", input.toolchain ?? "declared in the owner workspace config");
  input.options.changes.push(`write ${target}`);
  if (input.options.dryRun) {
    input.options.log(`would write ${target}\n`);
    return;
  }
  writeFileSync(target, rendered, "utf8");
  input.options.log(`wrote ${target}\n`);
};

// --------------------------------------------------------------- onboard ----

export type OnboardOptions = {
  installRoot: string;
  productRoot: string;
  coordRoot?: string;
  cloneRoot?: string;
  agents?: readonly string[];
  profile?: "solo" | "reviewed" | "consensus";
  declarePath?: string;
  origin?: string;
  dryRun?: boolean;
  log: Logger;
  now?: string;
};

export type OnboardResult = InstallResult & { location: WorkspaceLocation };

/**
 * Happy-path preset over `install`: four agents, sibling coord-runtime, owner
 * locator, consensus profile. Advanced flags stay on `coord install`.
 */
export const onboard = (options: OnboardOptions): OnboardResult => {
  const productRoot = resolve(options.productRoot);
  const parent = dirname(productRoot);
  const coordRoot = resolve(options.coordRoot ?? join(parent, "coord-runtime"));
  const result = install({
    installRoot: options.installRoot,
    productRoot,
    coordRoot,
    cloneRoot: resolve(options.cloneRoot ?? parent),
    agents: options.agents ?? ["claude", "codex", "cursor", "antigravity"],
    profile: options.profile ?? "consensus",
    writeProduct: false,
    vendor: false,
    bootstrap: false,
    dryRun: options.dryRun ?? false,
    writeOwnerLocator: true,
    log: options.log,
    ...(options.declarePath === undefined ? {} : { declarePath: options.declarePath }),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(options.now === undefined ? {} : { now: options.now })
  });
  const project = productName(productRoot);
  const location = resolveInstalledWorkspace(coordRoot, project) ?? chooseWorkspaceLocation(coordRoot, project);
  return { ...result, location };
};

// ------------------------------------------------------------- uninstall ----

export type UninstallOptions = {
  productRoot?: string;
  coordRoot: string;
  project?: string;
  deleteClones: boolean;
  wipeRuntime: boolean;
  deleteCoordination: boolean;
  force: boolean;
  dryRun: boolean;
  log: Logger;
};

export type UninstallResult = { changes: string[]; kept: string[] };

/**
 * Conservative by default: clear the wiring coordination added, and nothing
 * else. Clones, runtime state, and the coordination checkout survive unless the
 * operator names them, because a workspace under uninstall is far more often
 * being repaired than being abandoned.
 */
export const uninstall = (options: UninstallOptions): UninstallResult => {
  const effects = effectOptions(options.log, options.dryRun);
  const coordRoot = resolve(options.coordRoot);
  const project = options.project ?? (options.productRoot === undefined ? undefined : productName(resolve(options.productRoot)));
  if (project === undefined) throw new Error("uninstall requires --product or --project.");

  const location = resolveInstalledWorkspace(coordRoot, project);
  if (location === null) {
    throw new Error(
      `No installed workspace for '${project}' under ${coordRoot}. Nothing to uninstall.`
    );
  }
  const configPath = location.configPath;
  const config = readConfig(configPath);
  const stamp = config.coordination;
  const kept: string[] = [];
  const clonePaths = config.agents.map((agent) => ({ agent, clone: resolve(dirname(configPath), agent.root) }));
  const productRoot = options.productRoot !== undefined ? resolve(options.productRoot) : (stamp?.productRoot ?? null);

  // ---- preflight: every refusal is decided before anything is mutated ------
  if (options.deleteClones && !options.force) {
    const dirty = clonePaths.filter(({ clone }) => cloneIsDirty(clone)).map(({ clone }) => clone);
    if (dirty.length > 0) {
      throw new Error(
        `Refusing to delete ${dirty.join(", ")}: uncommitted changes are present. ` +
          "Commit or stash them, or re-run with --force to DISCARD them. Nothing has been changed."
      );
    }
  }
  if (options.deleteCoordination && stamp?.ownsInstallRoot !== true) {
    throw new Error(
      `Refusing --delete-coordination: this workspace did not create the coordination checkout at ` +
        `${stamp?.installRoot ?? "<unknown>"}, so removing it would delete something installed independently. ` +
        "Running bootstrap commands inside an existing checkout is not ownership of it. Nothing has been changed."
    );
  }
  if (options.wipeRuntime && location.layout === "flat") {
    // Flat wipe must not remove sibling nested workspaces or other products'
    // issue roots that incorrectly shared the outer root under older layouts.
    const nestedOthers = existsSync(join(coordRoot, "workspaces"))
      ? readdirSync(join(coordRoot, "workspaces")).filter((entry) => entry !== project)
      : [];
    if (nestedOthers.length > 0 && !options.force) {
      throw new Error(
        `Refusing --wipe-runtime: ${coordRoot} also holds nested workspaces for ${nestedOthers.join(", ")}. ` +
          "Re-run with --force to wipe this flat workspace's issue roots anyway (nested workspaces are left alone)."
      );
    }
  }

  for (const { agent, clone } of clonePaths) {
    if (!existsSync(clone)) continue;
    const removal = removeCloneHooks(clone, { dryRun: options.dryRun });
    if (removal.removed.length > 0) {
      effects.changes.push(`remove hooks ${removal.removed.join(", ")} from ${clone}`);
      effects.log(`${options.dryRun ? "would remove" : "removed"} hooks ${removal.removed.join(", ")} from ${clone}\n`);
    }
    if (removal.restored.length > 0) {
      effects.changes.push(`restore pre-existing hooks ${removal.restored.join(", ")} in ${clone}`);
      effects.log(
        `${options.dryRun ? "would restore" : "restored"} the pre-existing hooks ${removal.restored.join(", ")} in ${clone}\n`
      );
    }
    for (const file of removal.kept) {
      kept.push(`${clone}: ${file} was edited after installation and was left in place`);
    }
    clearCloneIdentity(clone, effects);
    clearCloneExclude(clone, effects);
    const launcher = join(clone, agent.launcher);
    if (existsSync(launcher)) {
      effects.changes.push(`remove ${launcher}`);
      if (!options.dryRun) rmSync(launcher);
      effects.log(`${options.dryRun ? "would remove" : "removed"} ${launcher}\n`);
    }
  }

  if (stamp?.wroteProductIgnore === true && existsSync(join(stamp.productRoot, ".gitignore"))) {
    const outcome = clearManagedIgnoreFile(join(stamp.productRoot, ".gitignore"), { dryRun: options.dryRun });
    if (outcome.changed) {
      effects.changes.push(`remove the managed block from ${outcome.path}`);
      effects.log(`${options.dryRun ? "would remove" : "removed"} the managed block from ${outcome.path}\n`);
    }
  } else if (stamp !== undefined) {
    effects.log(`product .gitignore was not written by coordination; leaving ${stamp.productRoot} alone\n`);
  }

  if (stamp?.wroteAgentsMd === true) {
    const agentsMd = join(stamp.productRoot, "AGENTS.md");
    if (existsSync(agentsMd)) {
      effects.changes.push(`remove ${agentsMd}`);
      if (!options.dryRun) rmSync(agentsMd);
      effects.log(`${options.dryRun ? "would remove" : "removed"} ${agentsMd}\n`);
    }
  }

  if (productRoot !== null) {
    const locator = readOwnerWorkspaceConfig(productRoot);
    if (locator !== null && resolve(locator) === resolve(configPath)) {
      effects.changes.push(`clear owner locator on ${productRoot}`);
      if (!options.dryRun) clearOwnerWorkspaceConfig(productRoot);
      effects.log(`${options.dryRun ? "would clear" : "cleared"} owner workspace locator on ${productRoot}\n`);
    }
  }

  if (options.deleteClones) {
    for (const { clone } of clonePaths) {
      if (!existsSync(clone)) continue;
      effects.changes.push(`delete clone ${clone}`);
      if (!options.dryRun) rmSync(clone, { recursive: true, force: true });
      effects.log(`${options.dryRun ? "would delete" : "deleted"} clone ${clone}\n`);
    }
  }

  effects.changes.push(`delete workspace config ${configPath}`);
  if (!options.dryRun) rmSync(configPath, { force: true });
  effects.log(`${options.dryRun ? "would delete" : "deleted"} workspace config ${configPath}\n`);

  // Never delete/wipe the coord-root itself when layout is flat — that would
  // remove mirror/issues belonging to other products incorrectly. For nested,
  // only remove an empty workspace directory after the config is gone.
  if (location.layout === "nested" && !options.dryRun) {
    try {
      if (readdirSync(location.workspaceRoot).length === 0) {
        rmSync(location.workspaceRoot, { recursive: true, force: true });
      }
    } catch {
      // Directory may already be gone.
    }
  }

  if (options.wipeRuntime) {
    // Scoped to this product's workspaceRoot only (issue-N + mirror under it).
    const issueRuntimes = existsSync(location.workspaceRoot)
      ? readdirSync(location.workspaceRoot).filter((entry) => /^issue-[0-9]+$/.test(entry))
      : [];
    const targets = [
      ...issueRuntimes.map((entry) => join(location.workspaceRoot, entry)),
      join(location.workspaceRoot, "mirror.git")
    ];
    for (const target of targets) {
      if (!existsSync(target)) continue;
      effects.changes.push(`wipe ${target}`);
      if (!options.dryRun) rmSync(target, { recursive: true, force: true });
      effects.log(`${options.dryRun ? "would wipe" : "wiped"} ${target}\n`);
    }
  }

  if (options.deleteCoordination && stamp !== undefined) {
    effects.changes.push(`delete coordination install ${stamp.installRoot}`);
    if (!options.dryRun) rmSync(stamp.installRoot, { recursive: true, force: true });
    effects.log(`${options.dryRun ? "would delete" : "deleted"} coordination install ${stamp.installRoot}\n`);
  }

  for (const message of kept) options.log(`kept: ${message}\n`);
  return { changes: effects.changes, kept };
};
