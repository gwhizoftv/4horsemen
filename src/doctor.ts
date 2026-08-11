import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { HOOK_NAMES } from "./hookSync.js";
import type { CoordinatorConfig } from "./state.js";

export type DoctorFinding = {
  code:
    | "missing-install-root"
    | "bad-hooks"
    | "stale-vendor-stamp"
    | "missing-launcher"
    | "bad-identity"
    | "config-incompatible"
    | "missing-command"
    | "missing-workspace-config"
    | "ok";
  severity: "error" | "warning" | "info";
  message: string;
};

export type DoctorReport = {
  ok: boolean;
  findings: DoctorFinding[];
};

export type DoctorOptions = {
  configPath: string;
  config: CoordinatorConfig;
  requirePathCommands?: boolean;
};

const which = (command: string): boolean => {
  try {
    execFileSync("which", [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
};

const runGit = (args: readonly string[], cwd: string): string => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

const resolveAgentRoot = (configPath: string, root: string): string =>
  isAbsolute(root) ? root : resolve(dirname(configPath), root);

export const runDoctorChecks = (options: DoctorOptions): DoctorReport => {
  const findings: DoctorFinding[] = [];
  const { config, configPath } = options;
  const stamp = config.coordination;

  try {
    // Ensure start can still parse the emitted file (strict schema).
    if (config.agents.length === 0) {
      findings.push({
        code: "config-incompatible",
        severity: "error",
        message: "Workspace config has no agents."
      });
    }
  } catch (error) {
    findings.push({
      code: "config-incompatible",
      severity: "error",
      message: `Workspace config incompatible with coord start: ${error instanceof Error ? error.message : String(error)}`
    });
  }

  if (stamp === undefined) {
    findings.push({
      code: "missing-install-root",
      severity: "warning",
      message: "Workspace config has no coordination install stamp."
    });
  } else {
    if (!existsSync(stamp.installRoot) || !existsSync(join(stamp.installRoot, "githooks"))) {
      findings.push({
        code: "missing-install-root",
        severity: "error",
        message: `Install root missing or incomplete: ${stamp.installRoot}`
      });
    } else {
      const head = runGit(["rev-parse", "HEAD"], stamp.installRoot);
      if (head !== "" && head !== stamp.commit) {
        findings.push({
          code: "stale-vendor-stamp",
          severity: "warning",
          message: `Install stamp commit ${stamp.commit} differs from installRoot HEAD ${head}`
        });
      }
    }
  }

  for (const agent of config.agents) {
    const root = resolveAgentRoot(configPath, agent.root);
    if (!existsSync(root)) {
      findings.push({
        code: "config-incompatible",
        severity: "error",
        message: `Configured agent root missing: ${root}`
      });
      continue;
    }

    const agentId = runGit(["config", "--local", "--get", "consensus.agentId"], root);
    const label = runGit(["config", "--local", "--get", "consensus.agentLabel"], root);
    const installRoot = runGit(["config", "--local", "--get", "coord.installRoot"], root);
    const workspaceConfig = runGit(["config", "--local", "--get", "coord.workspaceConfig"], root);

    if (agentId !== agent.id) {
      findings.push({
        code: "bad-identity",
        severity: "error",
        message: `Clone ${root} consensus.agentId is '${agentId || "<unset>"}' (expected ${agent.id})`
      });
    }
    if (label === "") {
      findings.push({
        code: "bad-identity",
        severity: "error",
        message: `Clone ${root} is missing consensus.agentLabel`
      });
    }
    if (installRoot === "") {
      findings.push({
        code: "missing-install-root",
        severity: "error",
        message: `Clone ${root} is missing coord.installRoot`
      });
    } else if (stamp !== undefined && resolve(installRoot) !== resolve(stamp.installRoot)) {
      findings.push({
        code: "missing-install-root",
        severity: "error",
        message: `Clone ${root} installRoot ${installRoot} does not match stamp ${stamp.installRoot}`
      });
    }
    if (workspaceConfig === "" || !existsSync(workspaceConfig)) {
      findings.push({
        code: "missing-workspace-config",
        severity: "error",
        message: `Clone ${root} coord.workspaceConfig is missing or unreadable`
      });
    }

    const launcher = join(root, agent.launcher);
    if (!existsSync(launcher)) {
      findings.push({
        code: "missing-launcher",
        severity: "error",
        message: `Missing launcher ${launcher}`
      });
    }

    for (const hook of HOOK_NAMES) {
      const hookPath = join(root, ".git/hooks", hook);
      if (!existsSync(hookPath)) {
        findings.push({
          code: "bad-hooks",
          severity: "error",
          message: `Missing agent hook shim ${hookPath}`
        });
        continue;
      }
      const body = readFileSync(hookPath, "utf8");
      const vendor = stamp?.vendor === true;
      if (!vendor && !body.includes("coord.installRoot")) {
        findings.push({
          code: "bad-hooks",
          severity: "error",
          message: `Hook ${hookPath} is not a coordination shim`
        });
      }
      if (vendor) {
        const stampPath = join(root, ".git/hooks/.coordination-vendor-stamp");
        if (!existsSync(stampPath)) {
          findings.push({
            code: "stale-vendor-stamp",
            severity: "error",
            message: `Vendor hooks at ${root} are missing .coordination-vendor-stamp`
          });
        } else if (stamp !== undefined) {
          const recorded = readFileSync(stampPath, "utf8").trim();
          if (resolve(recorded) !== resolve(stamp.installRoot)) {
            findings.push({
              code: "stale-vendor-stamp",
              severity: "error",
              message: `Vendor stamp ${recorded} does not match installRoot ${stamp.installRoot}`
            });
          }
        }
      }
    }
  }

  if (options.requirePathCommands === true) {
    const commands: string[] = [];
    for (const check of config.checks) {
      commands.push(check.argv[0]!);
    }
    if (config.verify !== undefined) {
      for (const command of [...config.verify.precommit, ...config.verify.prepush]) {
        commands.push(command.argv[0]!);
      }
    }
    for (const command of new Set(commands)) {
      if (command.includes("/") || command === "true" || command === "false") continue;
      if (!which(command)) {
        findings.push({
          code: "missing-command",
          severity: "error",
          message: `Declared argv[0] '${command}' is not on PATH`
        });
      }
    }
  }

  if (findings.length === 0) {
    findings.push({ code: "ok", severity: "info", message: "Doctor checks passed." });
  }

  return {
    ok: findings.every((finding) => finding.severity !== "error"),
    findings
  };
};

export const formatDoctorReport = (report: DoctorReport): string =>
  report.findings.map((finding) => `[${finding.severity}] ${finding.code}: ${finding.message}`).join("\n") + "\n";
