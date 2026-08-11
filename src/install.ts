import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  removeManagedProductGitignore,
  writeManagedProductGitignore,
  writeOptionalAgentsMd
} from "./productIgnore.js";
import { packageRoot, setupWorkspace, teardownAgentCloneWiring, type SetupWorkspaceResult } from "./setupWorkspace.js";
import { coordinatorConfigSchema, readConfig, type CoordinatorConfig } from "./state.js";
import { runDoctorChecks, type DoctorReport } from "./doctor.js";

export type InstallIo = {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
};

export type InstallOptions = {
  product: string;
  coordRoot: string;
  agents: readonly string[];
  profile?: string;
  installRoot?: string;
  cloneRoot?: string;
  configTemplate?: string;
  writeProduct?: boolean;
  vendor?: boolean;
  bootstrapCoordination?: boolean;
  dryRun?: boolean;
  sharedBranch?: string;
  remoteName?: string;
  cwd: string;
  io: InstallIo;
};

export type UninstallOptions = {
  coordRoot: string;
  deleteClones?: boolean;
  wipeRuntime?: boolean;
  deleteCoordination?: boolean;
  force?: boolean;
  dryRun?: boolean;
  cwd: string;
  io: InstallIo;
};

const runGit = (args: readonly string[], cwd: string): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const isDirty = (repo: string): boolean => runGit(["status", "--porcelain"], repo) !== "";

export const runInstall = (options: InstallOptions): SetupWorkspaceResult => {
  if (options.bootstrapCoordination === true) {
    throw new Error("--bootstrap-coordination is not implemented in this revision; install from an existing checkout.");
  }

  const productRoot = resolve(options.cwd, options.product);
  const coordRoot = resolve(options.cwd, options.coordRoot);
  const installRoot = resolve(options.cwd, options.installRoot ?? packageRoot);
  const result = setupWorkspace({
    productRoot,
    coordRoot,
    agents: options.agents,
    installRoot,
    cloneRoot: options.cloneRoot === undefined ? undefined : resolve(options.cwd, options.cloneRoot),
    configTemplatePath:
      options.configTemplate === undefined ? undefined : resolve(options.cwd, options.configTemplate),
    writeProduct: options.writeProduct,
    vendor: options.vendor,
    dryRun: options.dryRun,
    sharedBranch: options.sharedBranch,
    remoteName: options.remoteName
  });

  if (options.writeProduct === true) {
    writeManagedProductGitignore(productRoot, { dryRun: options.dryRun });
    writeOptionalAgentsMd(productRoot, result.config.project, result.config.baseBranch, {
      dryRun: options.dryRun
    });
  }

  if (options.dryRun === true) {
    const pathOnly = runDoctorChecks({
      configPath: result.configPath,
      config: result.config,
      requirePathCommands: true
    });
    // Dry-run has no clones on disk yet; ignore clone wiring errors.
    const hard = pathOnly.findings.filter(
      (finding) =>
        finding.severity === "error" &&
        (finding.code === "missing-command" || finding.code === "config-incompatible")
    );
    if (hard.length > 0) {
      throw new Error(`Install doctor failed:\n- ${hard.map((f) => f.message).join("\n- ")}`);
    }
    options.io.stdout(`DRY-RUN: would install workspace config at ${result.configPath}\n`);
    for (const [agent, root] of Object.entries(result.cloneRoots)) {
      options.io.stdout(`DRY-RUN: would wire agent ${agent} at ${root}\n`);
    }
    return result;
  }

  const doctor = runDoctorChecks({
    configPath: result.configPath,
    config: result.config,
    requirePathCommands: true
  });
  if (!doctor.ok) {
    const details = doctor.findings.filter((finding) => finding.severity === "error").map((f) => f.message);
    throw new Error(`Install doctor failed:\n- ${details.join("\n- ")}`);
  }

  if (result.noop) {
    options.io.stdout(`Install already complete (no-op). Config: ${result.configPath}\n`);
  } else {
    options.io.stdout(`Installed coordination workspace config: ${result.configPath}\n`);
  }

  if (!result.productStatusClean && options.writeProduct !== true) {
    options.io.stderr(
      `coord: warning: product git status is not empty after default install: ${productRoot}\n`
    );
  } else if (result.productStatusClean) {
    options.io.stdout("Product master git status is empty (zero tracked footprint).\n");
  }

  const profile = options.profile ?? "consensus";
  options.io.stdout("Next steps (not auto-run):\n");
  options.io.stdout(
    `  ./coord start <issue> --profile ${profile} --config ${result.configPath} --coord-root ${resolve(options.cwd, options.coordRoot)}\n`
  );
  options.io.stdout(`  ./coord run --issue <issue> --coord-root ${resolve(options.cwd, options.coordRoot)}\n`);
  options.io.stdout(
    "Transient evidence (.plans/, .signals/, .code-reviews/) appears on agent branches until R7 cleanup.\n"
  );
  return result;
};

export const runUninstall = (options: UninstallOptions): void => {
  const coordRoot = resolve(options.cwd, options.coordRoot);
  const configPath = resolve(coordRoot, "config.json");
  if (!existsSync(configPath)) throw new Error(`No workspace config at ${configPath}.`);
  const config = readConfig(configPath);
  const dryRun = options.dryRun === true;
  const stamp = config.coordination;

  for (const agent of config.agents) {
    const root = resolve(dirname(configPath), agent.root);
    if (!existsSync(root)) continue;
    teardownAgentCloneWiring(root, agent.id, { dryRun });
    if (options.deleteClones === true) {
      if (!dryRun && isDirty(root) && options.force !== true) {
        throw new Error(`Refusing to delete dirty clone ${root}; pass --force to override.`);
      }
      options.io.stdout(`${dryRun ? "DRY-RUN: would delete" : "Deleting"} clone ${root}\n`);
      if (!dryRun) rmSync(root, { recursive: true, force: true });
    }
  }

  if (stamp?.managedGitignore === true && stamp.productRoot !== undefined) {
    removeManagedProductGitignore(stamp.productRoot, { dryRun });
  }

  if (options.deleteCoordination === true) {
    if (stamp?.bootstrappedCoordination !== true) {
      throw new Error("--delete-coordination refused: install did not record bootstrap ownership.");
    }
    options.io.stdout(`${dryRun ? "DRY-RUN: would delete" : "Deleting"} coordination install ${stamp.installRoot}\n`);
    if (!dryRun) rmSync(stamp.installRoot, { recursive: true, force: true });
  }

  if (options.wipeRuntime === true) {
    options.io.stdout(`${dryRun ? "DRY-RUN: would wipe" : "Wiping"} runtime ${coordRoot}\n`);
    if (!dryRun) rmSync(coordRoot, { recursive: true, force: true });
  } else if (!dryRun) {
    unlinkSync(configPath);
    options.io.stdout(`Removed workspace config ${configPath}\n`);
  } else {
    options.io.stdout(`DRY-RUN: would remove workspace config ${configPath}\n`);
  }
};

export const loadWorkspaceConfig = (coordRoot: string, cwd: string): { configPath: string; config: CoordinatorConfig } => {
  const configPath = resolve(cwd, coordRoot, "config.json");
  if (!existsSync(configPath)) throw new Error(`No workspace config at ${configPath}.`);
  return { configPath, config: coordinatorConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8"))) };
};

export type { DoctorReport };
