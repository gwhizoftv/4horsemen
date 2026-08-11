import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { git, localConfigGet } from "./gitExec.js";
import {
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
  workspaceConfigPath,
  workspaceDirectory,
  writeAgentLauncher,
  writeCloneExclude,
  writeWorkspaceConfig,
  type EffectOptions,
  type Logger
} from "./setupWorkspace.js";
import { readConfig, workspaceDeclarationSchema, type InstallStamp, type WorkspaceDeclaration } from "./state.js";

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

  if (options.agents.length === 0) throw new Error("--agents requires at least one agent id.");

  // ---- step 0: optional bootstrap of the coordination install itself -------
  if (options.bootstrap) bootstrapCoordination(installRoot, effects);

  // ---- step 1: preflight and containment ----------------------------------
  assertContainment({ productRoot, coordRoot: resolve(options.coordRoot), cloneRoot });
  const coordRoot = resolveSafeCoordRoot({
    coordRoot: resolve(options.coordRoot),
    agentRoots: options.agents.map((agent) => agentCloneDirectory(cloneRoot, project, agent)),
    create: !options.dryRun
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

  const configPath = workspaceConfigPath(coordRoot, project);
  const proposal = proposeProjectPolicy(productRoot);
  const declared = options.declarePath === undefined ? null : readDeclaration(options.declarePath);
  const mode: HookMode = options.vendor ? "vendor" : "shim";
  const sourceCommit = installSourceCommit(installRoot);
  const version = packageVersion(installRoot);

  // ---- steps 2-5: per-agent clone wiring ----------------------------------
  const clones: string[] = [];
  for (const agent of options.agents) {
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
    if (hooks.written.length > 0) {
      effects.changes.push(`write hooks ${hooks.written.join(", ")} in ${clone}`);
      effects.log(`${options.dryRun ? "would write" : "wrote"} ${mode} hooks ${hooks.written.join(", ")} in ${hooks.hooksDir}\n`);
    } else {
      effects.log(`hooks already current in ${hooks.hooksDir}\n`);
    }
  }

  // ---- optional, opt-in: tracked changes in the product --------------------
  let wroteProductIgnore = false;
  if (options.writeProduct) {
    const ignorePath = join(productRoot, ".gitignore");
    const outcome = writeManagedIgnoreFile(ignorePath, DEFAULT_CLONE_IGNORES, { dryRun: options.dryRun });
    wroteProductIgnore = outcome.changed || readsManagedBlock(ignorePath);
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

  // ---- step 6: emit the workspace config under coord-root ------------------
  const stamp: InstallStamp = {
    installRoot,
    cliEntry,
    version,
    commit: sourceCommit,
    installedAt: options.now ?? new Date().toISOString(),
    productRoot,
    cloneRoot,
    vendored: options.vendor,
    bootstrapped: options.bootstrap,
    wroteProductIgnore
  };
  const previous = existsSync(configPath) ? readConfig(configPath) : null;
  const config = buildWorkspaceConfig(
    {
      project,
      origin,
      baseBranch,
      agents: options.agents,
      cloneRoot,
      workspaceDir: workspaceDirectory(coordRoot, project),
      declared,
      proposal
    },
    // A re-install must not look like a change just because time passed.
    previous?.coordination !== undefined &&
    previous.coordination.commit === stamp.commit &&
    previous.coordination.version === stamp.version &&
    previous.coordination.installRoot === stamp.installRoot
      ? previous.coordination
      : stamp
  );
  writeWorkspaceConfig(coordRoot, config, effects);

  // ---- step 7: next steps, never run for the operator ----------------------
  options.log(
    [
      "",
      `Installed ${project} for agents: ${options.agents.join(", ")}.`,
      `  workspace config : ${configPath}`,
      `  hook delivery    : ${mode}${options.vendor ? " (copies stamped at " + sourceCommit.slice(0, 12) + ")" : ""}`,
      `  product tree     : ${options.writeProduct ? "opt-in tracked changes written" : "untouched (git status unchanged)"}`,
      "",
      "Next steps — coord does not start anything for you:",
      `  coord doctor --coord-root ${coordRoot} --product ${productRoot}`,
      `  coord start <issue> --profile ${options.profile} --config ${configPath} --coord-root ${coordRoot}`,
      `  COORD_ISSUE=<issue> coord run --coord-root ${coordRoot}`,
      ""
    ].join("\n")
  );

  return { configPath, changes: effects.changes, clones };
};

const readsManagedBlock = (path: string): boolean =>
  existsSync(path) && readFileSync(path, "utf8").includes("coordination managed block");

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

  const configPath = workspaceConfigPath(coordRoot, project);
  if (!existsSync(configPath)) {
    throw new Error(`No installed workspace for '${project}' at ${configPath}. Nothing to uninstall.`);
  }
  const config = readConfig(configPath);
  const stamp = config.coordination;
  const kept: string[] = [];

  for (const agent of config.agents) {
    const clone = resolve(dirname(configPath), agent.root);
    if (!existsSync(clone)) continue;
    const removal = removeCloneHooks(clone, { dryRun: options.dryRun });
    if (removal.removed.length > 0) {
      effects.changes.push(`remove hooks ${removal.removed.join(", ")} from ${clone}`);
      effects.log(`${options.dryRun ? "would remove" : "removed"} hooks ${removal.removed.join(", ")} from ${clone}\n`);
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

  if (options.deleteClones) {
    for (const agent of config.agents) {
      const clone = resolve(dirname(configPath), agent.root);
      if (!existsSync(clone)) continue;
      if (cloneIsDirty(clone) && !options.force) {
        throw new Error(
          `Refusing to delete ${clone}: it has uncommitted changes. Commit or stash them, or re-run with --force to DISCARD them.`
        );
      }
      effects.changes.push(`delete clone ${clone}`);
      if (!options.dryRun) rmSync(clone, { recursive: true, force: true });
      effects.log(`${options.dryRun ? "would delete" : "deleted"} clone ${clone}\n`);
    }
  }

  const workspaceDir = workspaceDirectory(coordRoot, project);
  effects.changes.push(`delete workspace entry ${workspaceDir}`);
  if (!options.dryRun) rmSync(workspaceDir, { recursive: true, force: true });
  effects.log(`${options.dryRun ? "would delete" : "deleted"} workspace entry ${workspaceDir}\n`);

  if (options.wipeRuntime) {
    effects.changes.push(`wipe runtime ${coordRoot}`);
    if (!options.dryRun) rmSync(coordRoot, { recursive: true, force: true });
    effects.log(`${options.dryRun ? "would wipe" : "wiped"} runtime ${coordRoot}\n`);
  }

  if (options.deleteCoordination) {
    if (stamp?.bootstrapped !== true) {
      throw new Error(
        "Refusing --delete-coordination: this install did not record bootstrap ownership of the coordination checkout, " +
          "so removing it would delete something the operator installed independently."
      );
    }
    effects.changes.push(`delete coordination install ${stamp.installRoot}`);
    if (!options.dryRun) rmSync(stamp.installRoot, { recursive: true, force: true });
    effects.log(`${options.dryRun ? "would delete" : "deleted"} coordination install ${stamp.installRoot}\n`);
  }

  for (const message of kept) options.log(`kept: ${message}\n`);
  return { changes: effects.changes, kept };
};
