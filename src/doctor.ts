import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { git, localConfigGet, worktreeRoot } from "./gitExec.js";
import { canonicalSourceDigest, inspectCloneHooks, readHookManifest } from "./hookSync.js";
import { CLI_ENTRY_KEY, INSTALL_ROOT_KEY, unresolvableCommands, WORKSPACE_CONFIG_KEY } from "./hookPolicy.js";
import { githubRepositoryFromOrigin } from "./githubIssue.js";
import { productName } from "./setupWorkspace.js";
import { readConfig, type CoordinatorConfig } from "./state.js";
import { resolveInstalledWorkspace } from "./workspace.js";

/**
 * `coord doctor` — say exactly which part of an install is wrong.
 *
 * Each class of drift gets its own exit code, so an operator (or a CI job) can
 * act on the answer without parsing prose. The process exits with the lowest
 * code among the findings and prints all of them: a missing install root
 * usually explains the hook findings underneath it, so it should be the code
 * that surfaces.
 */

export const DOCTOR_CODES = {
  installRoot: 10,
  hooks: 11,
  vendorStamp: 12,
  launcher: 13,
  identity: 14,
  startCompatibility: 15,
  toolchain: 16,
  installDrift: 17,
  verifyUndeclared: 18,
  cloneMissing: 19
} as const;

export type DoctorClass = keyof typeof DOCTOR_CODES;

export type DoctorFinding = {
  class: DoctorClass;
  code: number;
  subject: string;
  message: string;
  remediation: string;
};

export type DoctorReport = {
  configPath: string;
  findings: DoctorFinding[];
  exitCode: number;
};

const finding = (
  klass: DoctorClass,
  subject: string,
  message: string,
  remediation: string
): DoctorFinding => ({ class: klass, code: DOCTOR_CODES[klass], subject, message, remediation });

const isExecutable = (path: string): boolean => {
  try {
    return (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

const cloneOf = (configPath: string, root: string): string => resolve(dirname(configPath), root);

const checkInstallRoot = (config: CoordinatorConfig): DoctorFinding[] => {
  const stamp = config.coordination;
  if (stamp === undefined) {
    return [
      finding(
        "installRoot",
        config.project,
        "The workspace config carries no install stamp, so what it runs against is unknown.",
        "Re-run coord install for this product."
      )
    ];
  }
  const findings: DoctorFinding[] = [];
  if (!existsSync(stamp.installRoot)) {
    findings.push(
      finding(
        "installRoot",
        stamp.installRoot,
        "The recorded coordination install root does not exist.",
        "Restore the checkout, or re-run coord install with the current --coord-root and product."
      )
    );
    return findings;
  }
  if (!existsSync(join(stamp.installRoot, "githooks"))) {
    findings.push(
      finding(
        "installRoot",
        stamp.installRoot,
        "The install root has no githooks/ directory, so every shim in every agent clone will block.",
        "Point the install at a complete coordination checkout and re-run coord install."
      )
    );
  }
  if (!existsSync(stamp.cliEntry)) {
    findings.push(
      finding(
        "installRoot",
        stamp.cliEntry,
        "The recorded CLI entry point is missing, so hooks cannot resolve declared verification.",
        "Run pnpm build in the install root."
      )
    );
  }
  const head = git(stamp.installRoot, "rev-parse", "--verify", "HEAD^{commit}");
  if (head.exitCode === 0 && head.stdout.trim() !== stamp.commit) {
    findings.push(
      finding(
        "installDrift",
        stamp.installRoot,
        `The install root is at ${head.stdout.trim().slice(0, 12)} but this workspace was installed against ${stamp.commit.slice(0, 12)}.`,
        "Re-run coord install to adopt the upgrade deliberately, or check out the recorded commit."
      )
    );
  }
  return findings;
};

const checkClone = (input: {
  config: CoordinatorConfig;
  configPath: string;
  agent: CoordinatorConfig["agents"][number];
  installDigest: string | null;
}): DoctorFinding[] => {
  const findings: DoctorFinding[] = [];
  const clone = cloneOf(input.configPath, input.agent.root);
  const stamp = input.config.coordination;

  if (!existsSync(clone)) {
    findings.push(
      finding("cloneMissing", clone, `Agent clone for '${input.agent.id}' is missing.`, "Re-run coord install to recreate it.")
    );
    return findings;
  }

  if (worktreeRoot(clone) === null) {
    findings.push(
      finding(
        "cloneMissing",
        clone,
        "The agent clone path exists but is not a git worktree, so nothing about its wiring can be verified.",
        "Restore or remove the directory, then re-run coord install."
      )
    );
    return findings;
  }

  const identity = localConfigGet(clone, "consensus.agentId");
  if (identity === null) {
    findings.push(
      finding(
        "identity",
        clone,
        `consensus.agentId is unset, but this clone is configured as agent '${input.agent.id}'.`,
        "Re-run coord install; hooks fail closed until identity is recorded."
      )
    );
  } else if (identity !== input.agent.id) {
    findings.push(
      finding(
        "identity",
        clone,
        `consensus.agentId is '${identity}' but the config assigns this root to '${input.agent.id}'.`,
        "Two clones are crossed. Fix the config or re-run coord install with the intended layout."
      )
    );
  }
  if (localConfigGet(clone, "consensus.agentLabel") === null) {
    findings.push(
      finding("identity", clone, "consensus.agentLabel is unset, so the commit-message prefix is unresolved.", "Re-run coord install.")
    );
  }
  const manifest = readHookManifest(clone);
  const vendored = manifest.kind === "ok" && manifest.manifest.mode === "vendor";
  const requiredKeys = vendored ? [CLI_ENTRY_KEY, WORKSPACE_CONFIG_KEY] : [INSTALL_ROOT_KEY, CLI_ENTRY_KEY, WORKSPACE_CONFIG_KEY];
  for (const key of requiredKeys) {
    if (localConfigGet(clone, key) === null) {
      findings.push(finding("installRoot", clone, `${key} is unset in this agent clone.`, "Re-run coord install."));
    }
  }
  if (stamp !== undefined && !vendored) {
    for (const [key, expected] of [
      [INSTALL_ROOT_KEY, stamp.installRoot],
      [CLI_ENTRY_KEY, stamp.cliEntry]
    ] as const) {
      const actual = localConfigGet(clone, key);
      if (actual !== null && actual !== expected) {
        findings.push(
          finding(
            "installDrift",
            clone,
            `${key} is '${actual}' but this workspace was installed against '${expected}'.`,
            "Re-run coord install so every clone resolves the same hook bodies."
          )
        );
      }
    }
  }
  if (localConfigGet(clone, WORKSPACE_CONFIG_KEY) !== input.configPath) {
    findings.push(
      finding(
        "startCompatibility",
        clone,
        `${WORKSPACE_CONFIG_KEY} does not point at ${input.configPath}, so hooks and coord start would read different policy.`,
        "Re-run coord install with this --coord-root."
      )
    );
  }

  if (stamp !== undefined) {
    const drift = inspectCloneHooks({
      clone,
      installRoot: stamp.installRoot,
      installCommit: stamp.commit,
      ...(input.installDigest === null ? {} : { canonicalDigest: input.installDigest })
    });
    if (drift.kind === "absent") {
      findings.push(
        finding("hooks", clone, "This agent clone has no coordination hooks, so its commits are ungated.", "Re-run coord install.")
      );
    } else if (drift.kind === "unmanaged") {
      findings.push(
        finding(
          "hooks",
          clone,
          "Hook files exist but no coordination manifest does, so what runs here is unknown.",
          "Inspect .git/hooks by hand, then re-run coord install."
        )
      );
    } else if (drift.kind === "missing") {
      findings.push(
        finding("hooks", clone, `Installed hooks are missing: ${drift.files.join(", ")}.`, "Re-run coord install.")
      );
    } else if (drift.kind === "modified") {
      findings.push(
        finding(
          "hooks",
          clone,
          `Installed hooks were edited after installation: ${drift.files.join(", ")}.`,
          "Edit the bodies in the coordination install instead, then re-run coord install."
        )
      );
    } else if (drift.kind === "shadowed") {
      findings.push(
        finding(
          "hooks",
          clone,
          `core.hooksPath is set to '${drift.hooksPath}', which shadows the installed hooks in .git/hooks.`,
          "Unset it: git -C <clone> config --local --unset core.hooksPath, or re-run coord install."
        )
      );
    } else if (drift.kind === "not-executable") {
      findings.push(
        finding(
          "hooks",
          clone,
          `Installed hooks are not executable: ${drift.files.join(", ")}. Git skips a hook without its execute bit and reports nothing.`,
          "Re-run coord install to restore the mode."
        )
      );
    } else if (drift.kind === "invalid-manifest") {
      findings.push(
        finding(
          "hooks",
          clone,
          `The coordination hook manifest is unreadable or names paths it may not (${drift.reason}).`,
          "Re-run coord install to rewrite it; uninstall will not act on a manifest it cannot validate."
        )
      );
    } else if (drift.kind === "install-modified") {
      findings.push(
        finding(
          "installDrift",
          stamp.installRoot,
          "The canonical hook sources in the install root differ from the bytes this workspace was installed against, with no new commit.",
          "Commit or revert the change in the install root, then re-run coord install."
        )
      );
    } else if (drift.kind === "stale-vendor") {
      findings.push(
        finding(
          "vendorStamp",
          clone,
          `Vendored hook bodies were copied at ${drift.recordedCommit.slice(0, 12)} but the install is at ${drift.installCommit.slice(0, 12)}.`,
          "Re-run coord install --vendor to refresh the copies."
        )
      );
    }
  }

  const launcher = join(clone, input.agent.launcher);
  if (!existsSync(launcher)) {
    findings.push(finding("launcher", launcher, "The agent launcher is missing.", "Re-run coord install."));
  } else if (!isExecutable(launcher)) {
    findings.push(finding("launcher", launcher, "The agent launcher is not executable.", `chmod +x ${launcher}`));
  }

  return findings;
};

const checkStartCompatibility = (config: CoordinatorConfig, configPath: string): DoctorFinding[] => {
  const findings: DoctorFinding[] = [];
  // Every start binds a GitHub issue snapshot; unsupported origins fail before launch.
  if (githubRepositoryFromOrigin(config.origin) === null) {
    findings.push(
      finding(
        "startCompatibility",
        configPath,
        `origin ${config.origin} is not a supported github.com repository; coord start cannot fetch an issue snapshot.`,
        "Point origin at a github.com HTTPS or SSH remote."
      )
    );
  }
  if (config.prPolicy === "coord-open-unmerged" && githubRepositoryFromOrigin(config.origin) === null) {
    findings.push(
      finding(
        "startCompatibility",
        configPath,
        `prPolicy "coord-open-unmerged" requires a supported github.com origin; ${config.origin} is incompatible.`,
        'Set prPolicy to "owner-only", or point origin at a github.com repository.'
      )
    );
  }
  for (const template of config.digestPaths) {
    if (!template.includes("{issue}")) {
      findings.push(
        finding(
          "startCompatibility",
          template,
          "A digest path has no {issue} placeholder, so every issue would hash the same automation input.",
          "Parameterise it, for example .plans/issue-{issue}/plan.md."
        )
      );
    }
  }
  return findings;
};

const checkDeclarations = (config: CoordinatorConfig, configPath: string, cwd: string): DoctorFinding[] => {
  const findings: DoctorFinding[] = [];
  if (config.verify === undefined) {
    findings.push(
      finding(
        "verifyUndeclared",
        configPath,
        "No `verify` is declared, so every agent commit in every clone will block.",
        'Declare argument vectors, or opt out explicitly with "verify": { "precommit": [], "prepush": [] }.'
      )
    );
  }
  for (const executable of unresolvableCommands(config, cwd)) {
    findings.push(
      finding(
        "toolchain",
        executable,
        `Declared command '${executable}' is not on PATH, so it would fail at an agent's first commit rather than now.`,
        `Install ${executable}, or change the declaration in ${configPath}.`
      )
    );
  }
  return findings;
};

export type DoctorOptions = {
  coordRoot: string;
  productRoot?: string;
  project?: string;
  configPath?: string;
};

export const doctor = (options: DoctorOptions): DoctorReport => {
  const coordRoot = resolve(options.coordRoot);
  const project = options.project ?? (options.productRoot === undefined ? undefined : productName(resolve(options.productRoot)));
  if (project === undefined && options.configPath === undefined) {
    throw new Error("doctor requires --product, --project, or an explicit config path.");
  }

  let configPath: string;
  if (options.configPath !== undefined) {
    configPath = resolve(options.configPath);
  } else {
    const location = resolveInstalledWorkspace(coordRoot, project as string);
    if (location !== null) {
      configPath = location.configPath;
    } else {
      // Prefer the flat path when present (even if unreadable), else nested.
      const flat = join(coordRoot, "config.json");
      const nested = join(coordRoot, "workspaces", project as string, "config.json");
      if (existsSync(flat)) configPath = flat;
      else if (existsSync(nested)) configPath = nested;
      else {
        throw new Error(
          `No installed workspace for '${project}' under ${coordRoot}. Run coord onboard or coord install first.`
        );
      }
    }
  }

  let config: CoordinatorConfig;
  try {
    config = readConfig(configPath);
  } catch (error) {
    const report: DoctorReport = {
      configPath,
      findings: [
        finding(
          "startCompatibility",
          configPath,
          `The workspace config is not one coord start can read: ${error instanceof Error ? error.message : String(error)}`,
          "Repair the file, or re-run coord install to regenerate it."
        )
      ],
      exitCode: DOCTOR_CODES.startCompatibility
    };
    return report;
  }

  let installDigest: string | null = null;
  if (config.coordination !== undefined && existsSync(join(config.coordination.installRoot, "githooks"))) {
    try {
      installDigest = canonicalSourceDigest(config.coordination.installRoot);
    } catch {
      installDigest = null;
    }
  }

  const findings = [
    ...checkInstallRoot(config),
    ...config.agents.flatMap((agent) => checkClone({ config, configPath, agent, installDigest })),
    ...checkStartCompatibility(config, configPath),
    ...checkDeclarations(config, configPath, dirname(configPath))
  ];

  const exitCode = findings.length === 0 ? 0 : Math.min(...findings.map((item) => item.code));
  return { configPath, findings, exitCode };
};

export const renderDoctorReport = (report: DoctorReport): string => {
  if (report.findings.length === 0) return `coord doctor: ${report.configPath} — no findings.\n`;
  const lines = [`coord doctor: ${report.findings.length} finding(s) for ${report.configPath}`];
  for (const item of report.findings) {
    lines.push(`  [${item.code}] ${item.class}: ${item.subject}`);
    lines.push(`        ${item.message}`);
    lines.push(`        fix: ${item.remediation}`);
  }
  lines.push(`exit ${report.exitCode}`);
  return `${lines.join("\n")}\n`;
};
