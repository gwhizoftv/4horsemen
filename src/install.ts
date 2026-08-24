import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  clearAgentsProtocolFile,
  clearClaudeAgentsShim,
  liftCloneAgentsProtocol,
  writeClaudeAgentsShim,
  writeCloneAgentsProtocol,
  writeProductAgentsProtocol
} from "./agentsProtocol.js";
import { git, localConfigGet } from "./gitExec.js";
import {
  canonicalSourceDigest,
  installSourceCommit,
  removeCloneHooks,
  vendorIntoProductTree,
  writeCloneHooks,
  type HookMode
} from "./hookSync.js";
import {
  assertMailboxClaim,
  defaultCompletesRoot,
  isPathInside,
  resolveSafeCompletesRoot,
  resolveSafeCoordRoot,
  workspaceTerminalGroup
} from "./paths.js";
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
  clearOwnerWorkspace,
  flatConfigPath,
  listIssueNumbersInWorkspace,
  recordOwnerWorkspace,
  resolveWorkspaceLocation,
  selectWorkspaceLocation
} from "./workspace.js";
import { doctor, type DoctorReport } from "./doctor.js";
import { detachAllOwnerUiSync } from "./detachIssue.js";
import {
  removeAgentLifecycleHooks,
  removeAntigravityStatusLine,
  syncAgentLifecycleHooks,
  syncAntigravityStatusLine
} from "./agentHookSync.js";

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
  profile: string;
  cloneRoot?: string;
  declarePath?: string;
  origin?: string;
  baseBranch?: string;
  writeProduct: boolean;
  vendor: boolean;
  bootstrap: boolean;
  dryRun: boolean;
  log: Logger;
  now?: string;
  /**
   * Owner override for the completion mailbox root. Defaults to the sibling of
   * the coord root; a nested or shared runtime that does not share that parent
   * has to state one, or two products would drop receipts in the same tree.
   */
  completesRoot?: string;
  /** Test/embedding override for the one Antigravity user-global setting. */
  home?: string | null;
};

export type InstallResult = {
  configPath: string;
  changes: string[];
  clones: string[];
};

/** Package version from installRoot/package.json (pre-1.0: bump 0.0.N before merging to main). */
export const packageVersion = (installRoot: string): string => {
  const parsed = JSON.parse(readFileSync(join(installRoot, "package.json"), "utf8")) as { version?: string };
  return parsed.version ?? "0.0.0";
};

const bootstrapOwnsInstallRoot = (installRoot: string): boolean => {
  const gitDirectory = git(installRoot, "rev-parse", "--absolute-git-dir");
  if (gitDirectory.exitCode !== 0) return false;
  const metadata = join(gitDirectory.stdout.trim(), "coord-bootstrap.json");
  if (!existsSync(metadata)) return false;
  try {
    const parsed = JSON.parse(readFileSync(metadata, "utf8")) as { version?: unknown; ownsInstallRoot?: unknown };
    return parsed.version === 1 && parsed.ownsInstallRoot === true;
  } catch {
    return false;
  }
};

const existingRealpath = (path: string): string => {
  const resolved = resolve(path);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
};

export type InstallDeletionContext = {
  force: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

/**
 * Last line of defence before `rmSync` of a coordination checkout.
 *
 * Tests use this repository as `installRoot`. A bootstrap-owned live install
 * (`.git/coord-bootstrap.json`) would otherwise make `--delete-coordination`
 * delete the tree vitest is running in. `--force` is the dirty-clone override
 * and must not be that escape hatch; `COORD_ALLOW_DELETE_INSTALL=1` is.
 */
export const assertInstallDeletionAllowed = (installRoot: string, context: InstallDeletionContext): void => {
  const root = existingRealpath(installRoot);
  const env = context.env ?? process.env;
  if (env.VITEST !== undefined && env.COORD_ALLOW_DELETE_INSTALL !== "1") {
    throw new Error(
      `Refusing --delete-coordination: a test run (VITEST is set) must not delete the coordination install at ${root}. ` +
        "Install/uninstall tests must use a disposable fixture, not the tree under test. Nothing has been changed."
    );
  }
  const cwd = existingRealpath(context.cwd ?? process.cwd());
  if (!context.force && isPathInside(root, cwd)) {
    throw new Error(
      `Refusing --delete-coordination: the current working directory ${cwd} is inside the coordination install ${root}. ` +
        "cd elsewhere, or re-run with --force if deleting this install is intentional. Nothing has been changed."
    );
  }
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
  const workspace = selectWorkspaceLocation(coordRoot, project);
  // Resolved before any clone is wired: an unsafe mailbox must fail the install
  // rather than be discovered when the first agent cannot publish its SHA.
  const completesRoot = resolveSafeCompletesRoot({
    // Sibling of the *outer* root either way, so the mailbox never lands inside
    // the runtime tree. Flat gets the bare sibling (the documented topology);
    // nested adds its project, because several products share one outer root.
    completesRoot:
      options.completesRoot ??
      defaultCompletesRoot(coordRoot, workspace.layout === "nested" ? project : undefined),
    coordRoot,
    agentRoots: options.agents.map((agent) => agentCloneDirectory(cloneRoot, project, agent)),
    create: !options.dryRun
  });
  // Two flat runtimes under one parent derive the same mailbox; nothing in the
  // path distinguishes them. Refuse here, where --completes-root is still an
  // option, rather than letting both products write one receipt file.
  assertMailboxClaim({
    completesRoot,
    configPath: workspace.configPath,
    write: !options.dryRun
  });

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

  const configPath = workspace.configPath;
  const proposal = proposeProjectPolicy(productRoot);
  const declared = options.declarePath === undefined ? null : readDeclaration(options.declarePath);
  const mode: HookMode = options.vendor ? "vendor" : "shim";
  const sourceCommit = installSourceCommit(installRoot);
  const version = packageVersion(installRoot);
  const canonicalDigest = canonicalSourceDigest(installRoot);
  const bootstrapOwned = bootstrapOwnsInstallRoot(installRoot);

  // ---- step 1b: build the config BEFORE any effect -------------------------
  // Every declaration, schema, and launcher failure is knowable now. Building
  // this after the clone loop meant an undeclarable product left a fully wired
  // agent clone behind and no workspace config to uninstall it with.
  const agentsMdPath = join(productRoot, "AGENTS.md");
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
    bootstrapped: options.bootstrap || bootstrapOwned,
    // Running build commands inside a checkout the operator already had is not
    // ownership of it. Only bootstrap's versioned .git metadata proves that
    // bootstrap created this checkout and may authorize later deletion.
    ownsInstallRoot: bootstrapOwned,
    wroteProductIgnore: options.writeProduct,
    wroteAgentsMd: options.writeProduct && !existsSync(agentsMdPath),
    completesRoot
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
      profile: options.profile,
      cloneRoot,
      workspaceDir: workspace.workspaceRoot,
      declared,
      proposal,
      completesRoot
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
    writeCloneAgentsProtocol({ clone, installRoot, options: effects });
    writeClaudeAgentsShim(clone, agent, effects);
    configureCloneIdentity(
      clone,
      {
        agent,
        label: agentLabel(agent),
        baseBranch,
        remoteName: "origin",
        installRoot: options.vendor ? null : installRoot,
        cliEntry,
        workspaceConfig: configPath,
        completesRoot
      },
      effects
    );
    syncAgentLifecycleHooks({ clone, agent, cliEntry, options: effects });
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

  const lifecycleHome = options.home === undefined ? homedir() : options.home;
  if (agents.includes("antigravity") && lifecycleHome !== null) {
    syncAntigravityStatusLine({ home: lifecycleHome, cliEntry, options: effects });
  }

  // ---- optional, opt-in: tracked changes in the product --------------------
  if (options.writeProduct) {
    const ignorePath = join(productRoot, ".gitignore");
    const outcome = writeManagedIgnoreFile(ignorePath, DEFAULT_CLONE_IGNORES, { dryRun: options.dryRun });
    if (outcome.changed) {
      effects.changes.push(`update ${ignorePath}`);
      effects.log(`${options.dryRun ? "would update" : "updated"} ${ignorePath}\n`);
    }
    writeProductAgentsProtocol({
      productRoot,
      installRoot,
      project,
      baseBranch,
      toolchain: declared?.toolchain ?? proposal.toolchain,
      createdFile: stamp.wroteAgentsMd,
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

  // ---- step 6: emit the workspace config under coord-root ------------------
  writeWorkspaceConfig(workspace, config, effects);

  // ---- step 7: next steps, never run for the operator ----------------------
  options.log(
    [
      "",
      `Installed ${project} for agents: ${agents.join(", ")}.`,
      `  workspace config : ${configPath}`,
      `  hook delivery    : ${mode}${options.vendor ? " (copies stamped at " + sourceCommit.slice(0, 12) + ")" : ""}`,
      `  product tree     : ${options.writeProduct ? "opt-in tracked changes written" : "untouched (git status unchanged)"}`,
      "",
      "Next steps — coord does not start anything for you:",
      `  coord doctor --coord-root ${coordRoot} --product ${productRoot}`,
      `  coord manual --product ${productRoot}`,
      `  coord start <issue> --config ${configPath} --coord-root ${workspace.workspaceRoot}`,
      `  COORD_ISSUE=<issue> coord run --coord-root ${workspace.workspaceRoot}`,
      ""
    ].join("\n")
  );

  return { configPath, changes: effects.changes, clones };
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
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  home?: string | null;
};

export type UninstallResult = { changes: string[]; kept: string[] };

const otherWorkspaceConfigs = (coordRoot: string, selectedConfig: string): string[] => {
  const paths: string[] = [];
  const flat = flatConfigPath(coordRoot);
  if (existsSync(flat) && resolve(flat) !== resolve(selectedConfig)) paths.push(flat);
  const workspaces = join(resolve(coordRoot), "workspaces");
  if (existsSync(workspaces)) {
    for (const entry of readdirSync(workspaces, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(workspaces, entry.name, "config.json");
      if (existsSync(candidate) && resolve(candidate) !== resolve(selectedConfig)) paths.push(candidate);
    }
  }
  return paths;
};

const flatRuntimeTargets = (coordRoot: string): string[] => {
  if (!existsSync(coordRoot)) return [];
  return readdirSync(coordRoot)
    .filter((entry) => entry === "mirror.git" || /^issue-[1-9][0-9]*$/.test(entry))
    .map((entry) => join(coordRoot, entry));
};

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

  const workspace = resolveWorkspaceLocation(coordRoot, project);
  if (workspace === null) {
    throw new Error(`No installed workspace for '${project}' under ${coordRoot}. Nothing to uninstall.`);
  }
  const configPath = workspace.configPath;
  const config = readConfig(configPath);
  const stamp = config.coordination;
  const kept: string[] = [];
  const clonePaths = config.agents.map((agent) => ({ agent, clone: resolve(dirname(configPath), agent.root) }));

  // ---- preflight: every refusal is decided before anything is mutated ------
  // Checking dirtiness inside the deletion loop meant a refusal arrived after
  // every clone had already been unwired and an earlier one deleted, leaving a
  // half-destroyed workspace and an error suggesting --force.
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
  if (options.deleteCoordination && stamp !== undefined) {
    assertInstallDeletionAllowed(stamp.installRoot, {
      force: options.force,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env })
    });
  }
  if (options.wipeRuntime && workspace.layout === "flat" && !options.force) {
    const others = otherWorkspaceConfigs(coordRoot, configPath);
    if (others.length > 0) {
      throw new Error(
        `Refusing --wipe-runtime: ${coordRoot} also holds ${others.length} other workspace(s), whose state would be destroyed. ` +
          "Re-run with --force only if wiping the shared runtime is intentional. Nothing has been changed."
      );
    }
  }

  for (const { agent, clone } of clonePaths) {
    if (!existsSync(clone)) continue;
    removeAgentLifecycleHooks({ clone, agent: agent.id, options: effects });
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
    liftCloneAgentsProtocol(clone, effects);
    clearClaudeAgentsShim(clone, agent.id, effects);
    const launcher = join(clone, agent.launcher);
    if (existsSync(launcher)) {
      effects.changes.push(`remove ${launcher}`);
      if (!options.dryRun) rmSync(launcher);
      effects.log(`${options.dryRun ? "would remove" : "removed"} ${launcher}\n`);
    }
  }

  const lifecycleHome = options.home === undefined ? homedir() : options.home;
  if (config.agents.some((agent) => agent.id === "antigravity") && lifecycleHome !== null) {
    const statusLine = removeAntigravityStatusLine({ home: lifecycleHome, options: effects });
    if (statusLine.kept) kept.push("Antigravity status line was edited after installation and was left in place");
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

  if (stamp !== undefined && existsSync(stamp.productRoot)) {
    if (!options.dryRun) clearOwnerWorkspace(stamp.productRoot, configPath);
    effects.changes.push(`clear owner workspace locator in ${stamp.productRoot}`);
    effects.log(`${options.dryRun ? "would clear" : "cleared"} owner workspace locator in ${stamp.productRoot}\n`);
  }

  // Only the AGENTS.md this install created, and only while it is still the
  // template we wrote; a human's file, or one they have since edited, stays.
  // Protocol appended into a pre-existing human AGENTS.md is removed.
  if (stamp?.wroteAgentsMd === true) {
    const agentsMd = join(stamp.productRoot, "AGENTS.md");
    if (existsSync(agentsMd)) {
      effects.changes.push(`remove ${agentsMd}`);
      if (!options.dryRun) rmSync(agentsMd);
      effects.log(`${options.dryRun ? "would remove" : "removed"} ${agentsMd}\n`);
    }
  } else if (stamp?.wroteProductIgnore === true) {
    const agentsMd = join(stamp.productRoot, "AGENTS.md");
    const outcome = clearAgentsProtocolFile(agentsMd, { dryRun: options.dryRun });
    if (outcome.changed) {
      effects.changes.push(`remove AGENTS.md protocol from ${agentsMd}`);
      effects.log(
        `${options.dryRun ? "would remove" : "removed"} AGENTS.md protocol from ${agentsMd}\n`
      );
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

  // Tear down owner Terminals + tmux before deleting config (need agent ids).
  {
    const ui = detachAllOwnerUiSync({
      agentIds: config.agents.map((agent) => agent.id),
      tmuxNamespace:
        workspace.layout === "nested" ? workspaceTerminalGroup(workspace.workspaceRoot) : null,
      terminalGroup: workspaceTerminalGroup(workspace.workspaceRoot),
      issues: listIssueNumbersInWorkspace(workspace.workspaceRoot),
      includeManual: true,
      dryRun: options.dryRun,
      log: effects.log
    });
    if (ui.killedSessions.length > 0 || ui.closedTerminalTitles.length > 0) {
      effects.changes.push(
        `detach owner UI (${ui.killedSessions.length} tmux session(s), ${ui.closedTerminalTitles.length} Terminal title(s))`
      );
    }
  }

  // Remove the selected config, not the surrounding flat runtime. A nested
  // workspace directory is removed only when that makes it empty.
  effects.changes.push(`delete workspace config ${configPath}`);
  if (!options.dryRun) rmSync(configPath, { force: true });
  effects.log(`${options.dryRun ? "would delete" : "deleted"} workspace config ${configPath}\n`);
  const workspaceDir = workspace.workspaceRoot;
  if (
    workspace.layout === "nested" &&
    !options.dryRun &&
    existsSync(workspaceDir) &&
    readdirSync(workspaceDir).length === 0
  ) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }

  if (options.wipeRuntime) {
    // Config for this product is already gone. If nothing else claims the outer
    // root, wipe the whole coord-runtime folder (what operators expect). Shared
    // roots still only drop this product's scoped targets so siblings survive.
    const others = otherWorkspaceConfigs(coordRoot, configPath);
    // The mailbox is a separate tree, so it needs its own target. A receipt left
    // behind after a wipe is read as completion intent by whatever reuses that
    // issue number next. Only wipe it when this product is the last claim on the
    // runtime: a shared root means a sibling workspace still owns its receipts.
    const mailbox = config.completesRoot ?? stamp?.completesRoot ?? defaultCompletesRoot(coordRoot);
    const targets =
      others.length === 0
        ? [coordRoot, mailbox]
        : workspace.layout === "flat"
          ? flatRuntimeTargets(coordRoot)
          : [workspaceDir];
    for (const target of targets) {
      if (!existsSync(target)) continue;
      effects.changes.push(`wipe ${target}`);
      if (!options.dryRun) rmSync(target, { recursive: true, force: true });
      effects.log(`${options.dryRun ? "would wipe" : "wiped"} ${target}\n`);
    }
  }

  if (options.deleteCoordination && stamp !== undefined) {
    assertInstallDeletionAllowed(stamp.installRoot, {
      force: options.force,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env })
    });
    effects.changes.push(`delete coordination install ${stamp.installRoot}`);
    if (!options.dryRun) rmSync(stamp.installRoot, { recursive: true, force: true });
    effects.log(`${options.dryRun ? "would delete" : "deleted"} coordination install ${stamp.installRoot}\n`);
  }

  for (const message of kept) options.log(`kept: ${message}\n`);
  return { changes: effects.changes, kept };
};

export type OnboardOptions = {
  installRoot: string;
  productRoot: string;
  coordRoot?: string;
  /** Owner override for the completion mailbox root; see InstallOptions. */
  completesRoot?: string;
  cloneRoot?: string;
  agents?: readonly string[];
  profile?: string;
  log: Logger;
  home?: string | null;
};

export type OnboardResult = { install: InstallResult; doctor: DoctorReport };

export const onboard = (options: OnboardOptions): OnboardResult => {
  const productRoot = requireWorktree(resolve(options.productRoot), "The product");
  const parent = dirname(productRoot);
  const coordRoot = resolve(options.coordRoot ?? join(parent, "coord-runtime"));
  const installed = install({
    installRoot: options.installRoot,
    productRoot,
    coordRoot,
    ...(options.completesRoot === undefined ? {} : { completesRoot: resolve(options.completesRoot) }),
    cloneRoot: resolve(options.cloneRoot ?? parent),
    agents: options.agents ?? ["claude", "codex", "cursor", "antigravity"],
    profile: options.profile ?? "consensus",
    writeProduct: false,
    vendor: false,
    bootstrap: false,
    dryRun: false,
    log: options.log,
    ...(options.home === undefined ? {} : { home: options.home })
  });
  const report = doctor({ coordRoot, productRoot });
  if (report.exitCode === 0) {
    recordOwnerWorkspace(productRoot, installed.configPath);
    options.log(
      [
        "",
        `Onboarded ${productRoot}.`,
        "Start owner-driven manual work or create a GitHub issue from this product:",
        `  cd ${productRoot}`,
        "  coord manual",
        '  gh issue create --title "…" --body "…"',
        "  coord <issue>",
        ""
      ].join("\n")
    );
  }
  return { install: installed, doctor: report };
};
