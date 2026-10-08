import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { git, localConfigGet, worktreeRoot } from "./gitExec.js";
import { canonicalSourceDigest, inspectCloneHooks, readHookManifest } from "./hookSync.js";
import { CLI_ENTRY_KEY, INSTALL_ROOT_KEY, unresolvableCommands, WORKSPACE_CONFIG_KEY } from "./hookPolicy.js";
import { githubRepositoryFromOrigin } from "./githubIssue.js";
import { GIT_WRAPPER_RELATIVE_PATH, productName } from "./setupWorkspace.js";
import { readConfig, type CoordinatorConfig } from "./state.js";
import { resolveWorkspaceLocation } from "./workspace.js";
import { inspectAgentLifecycleHooks } from "./agentHookSync.js";
import { cloneAgentsProtocolState } from "./agentsProtocol.js";
import { inspectClaudeStatusLine } from "./claudeStatusLine.js";

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
  cloneMissing: 19,
  lifecycleHooks: 20,
  agentsProtocol: 21,
  resourceTelemetry: 22,
  gitShim: 23
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

/**
 * Read-only install/hooks/shim/lifecycle inspection for one agent clone.
 * Used by doctor and by run-loop startup diagnostics. Omits issue-branch
 * overlay advice and resource-telemetry probes that belong only to full doctor.
 */
export const inspectAgentStartupWiring = (input: {
  config: CoordinatorConfig;
  configPath: string;
  agent: CoordinatorConfig["agents"][number];
  installDigest?: string | null;
}): DoctorFinding[] => {
  const findings: DoctorFinding[] = [];
  const clone = cloneOf(input.configPath, input.agent.root);
  const stamp = input.config.coordination;
  const installDigest = input.installDigest ?? null;

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

  if (stamp === undefined) {
    // Installation stamp absence is reported by checkInstallRoot for full doctor;
    // startup still surfaces unknown wiring without treating it as healthy.
    findings.push(
      finding(
        "installRoot",
        input.config.project,
        "The workspace config carries no install stamp, so hook wiring is unknown.",
        "Re-run coord install for this repository."
      )
    );
    return findings;
  }

  const drift = inspectCloneHooks({
    clone,
    installRoot: stamp.installRoot,
    installCommit: stamp.commit,
    ...(installDigest === null ? {} : { canonicalDigest: installDigest })
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

  const shim = join(clone, GIT_WRAPPER_RELATIVE_PATH);
  if (!isExecutable(shim)) {
    findings.push(finding("gitShim", shim,
      "Coordinator Git shim is missing or not executable; the native guard also needs it for policy checks.",
      "Re-run coord install. Runtime coverage must be measured in the actual agent tool; see coord status."));
  }
  const lifecycle = inspectAgentLifecycleHooks({
    clone,
    agent: input.agent.id,
    cliEntry: stamp.cliEntry
  });
  if (
    lifecycle.kind === "unsupported" &&
    (input.agent.delivery === "nudge" || input.agent.delivery === "both")
  ) {
    findings.push(
      finding(
        "lifecycleHooks",
        clone,
        `Agent '${input.agent.id}' has nudge delivery enabled but no supported lifecycle-hook vendor mapping.`,
        "Use a supported vendor agent id (claude, codex, cursor, or antigravity), or set delivery to pull so hook-gated nudging is not promised."
      )
    );
  } else if (lifecycle.kind === "missing") {
    findings.push(
      finding(
        "lifecycleHooks",
        lifecycle.path ?? clone,
        "Coordinator CLI lifecycle hooks and shell guard are missing; runtime coverage is unverified (see coord status).",
        "Re-run coord install, then restart this agent CLI so it reloads hooks."
      )
    );
  } else if (lifecycle.kind === "modified") {
    findings.push(
      finding(
        "lifecycleHooks",
        lifecycle.path ?? clone,
        "Coordinator CLI lifecycle hooks or shell guard differ from installed definitions; runtime coverage requires a new actual-tool probe (see coord status).",
        "Preserve any third-party entries, then re-run coord install to repair only coordinator-managed entries."
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
  home: string | null;
}): DoctorFinding[] => {
  const clone = cloneOf(input.configPath, input.agent.root);
  const stamp = input.config.coordination;
  const findings = inspectAgentStartupWiring({
    config: input.config,
    configPath: input.configPath,
    agent: input.agent,
    installDigest: input.installDigest
  });
  if (findings.some((item) => item.class === "cloneMissing")) return findings;

  // Branch preparation clears skip-worktree to move HEAD and re-sets it after.
  // A clone found with the bit clear means that restore did not finish, and the
  // only symptom otherwise is a confusing "uncommitted changes" refusal on the
  // next start, on a file the agent is forbidden to touch.
  const protocolState = cloneAgentsProtocolState(clone);
  if (protocolState.tracked && !protocolState.skipWorktree) {
    findings.push(
      finding(
        "agentsProtocol",
        clone,
        "AGENTS.md is tracked but skip-worktree is not set, so the coordination overlay shows as an uncommitted change.",
        "Re-run coord install, or start/resume the issue so branch preparation re-sets it."
      )
    );
  }
  const headBranch = git(clone, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
  if (
    /^issue-\d+\//.test(headBranch) &&
    protocolState.tracked &&
    protocolState.overlayPresent &&
    protocolState.skipWorktree
  ) {
    const issueMatch = /^issue-(\d+)\//.exec(headBranch);
    const issueHint = issueMatch?.[1] ?? "<issue>";
    findings.push(
      finding(
        "agentsProtocol",
        clone,
        `Agent clone is on ${headBranch} with a managed AGENTS.md protocol overlay (skip-worktree). ` +
          `Raw git checkout ${input.config.baseBranch} will fail because Git treats the overlay as local changes.`,
        `Do not run git checkout ${input.config.baseBranch}. Run: coord reset-clones ${issueHint} --product <path> ` +
          "(or --config <path> --coord-root <path>)."
      )
    );
  }

  // Resource telemetry is read-only here: no probe, no mutation, no owner command or account id printed.
  if (input.agent.id === "claude" && stamp !== undefined) {
    const tee = inspectClaudeStatusLine({
      clone, home: input.home, cliEntry: stamp.cliEntry, launcher: join(clone, input.agent.launcher)
    });
    if (tee.kind === "missing") {
      findings.push(finding("resourceTelemetry", tee.path, "The Claude status-line tee is not installed, so quota windows are never observed.", "Re-run coord install."));
    } else if (tee.kind === "modified" || tee.kind === "disabled") {
      findings.push(finding("resourceTelemetry", tee.path, `Claude quota telemetry is ${tee.kind}: ${tee.reason}.`,
        tee.kind === "modified" ? "Re-run coord install to follow the owner's current status line." :
          "Holds keep an unknown reset and owner release; resolve the reported ambiguity to enable telemetry."));
    }
  }
  if (input.agent.codexQuota !== undefined && !existsSync(input.agent.codexQuota.codexHome)) {
    findings.push(finding("resourceTelemetry", clone, "The configured codexQuota home does not exist, so quota reads cannot confirm the bound account.",
      "Point codexQuota.codexHome at the agent's CODEX_HOME, or remove the binding."));
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
  if (githubRepositoryFromOrigin(config.origin) === null) {
    findings.push(
      finding(
        "startCompatibility",
        configPath,
        `Starting an issue requires a supported github.com origin; ${config.origin} is incompatible.`,
        "Point origin at the GitHub repository whose issues define coordination work."
      )
    );
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
  /** Owner home for Claude's user settings layer; tests pass their own. */
  home?: string | null;
  productRoot?: string;
  project?: string;
};

export const doctor = (options: DoctorOptions): DoctorReport => {
  const coordRoot = resolve(options.coordRoot);
  const project = options.project ?? (options.productRoot === undefined ? undefined : productName(resolve(options.productRoot)));
  if (project === undefined) throw new Error("doctor requires --product or --project.");
  const workspace = resolveWorkspaceLocation(coordRoot, project, { acceptUnreadableFlat: true });
  if (workspace === null) {
    throw new Error(`No installed workspace for '${project}' under ${coordRoot}. Run coord onboard or coord install first.`);
  }
  const configPath = workspace.configPath;
  let config: CoordinatorConfig;
  try {
    config = readConfig(configPath);
  } catch (error) {
    // A config `coord start` would refuse is exactly the startCompatibility
    // class. Letting readConfig throw produced a generic exit 2 and no finding.
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

  // Recomputed from the install root rather than read from the stamp: the point
  // is to notice when those bytes changed without the stamp changing.
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
    ...config.agents.flatMap((agent) => checkClone({
      config, configPath, agent, installDigest, home: options.home === undefined ? homedir() : options.home
    })),
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
