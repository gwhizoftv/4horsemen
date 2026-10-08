import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeCloneAgentsProtocol } from "../src/agentsProtocol.js";
import { DOCTOR_CODES, doctor, inspectAgentWiring, renderDoctorReport } from "../src/doctor.js";
import { readConfig } from "../src/state.js";
import { install } from "../src/install.js";
import {
  declaredChecks,
  ensureBuilt,
  git,
  makeProduct,
  passingVerify,
  repoRoot,
  silence,
  writeDeclaration,
  type ProductFixture
} from "./support/workspaceFixture.js";

const fixtures: ProductFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

type Installed = { fixture: ProductFixture; clone: string; configPath: string };

const installed = (
  declaration: Record<string, unknown> = { checks: declaredChecks, verify: passingVerify },
  kind: "go" | "plain" = "go"
): Installed => {
  ensureBuilt();
  const fixture = makeProduct(kind);
  fixtures.push(fixture);
  git(fixture.productRoot, "remote", "set-url", "origin", "https://github.com/example/myserver.git");
  const result = install({
    installRoot: repoRoot,
    productRoot: fixture.productRoot,
    coordRoot: fixture.coordRoot,
    agents: ["claude"],
    profile: "solo",
    declarePath: writeDeclaration(fixture.workspaceRoot, declaration),
    writeProduct: false,
    vendor: false,
    bootstrap: false,
    dryRun: false,
    log: silence().log
  });
  return { fixture, clone: result.clones[0] as string, configPath: result.configPath };
};

const report = (fixture: ProductFixture) => doctor({ coordRoot: fixture.coordRoot, productRoot: fixture.productRoot });

const editConfig = (configPath: string, mutate: (config: Record<string, unknown>) => void): void => {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  mutate(config);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
};

describe("coord doctor", () => {
  it("distinguishes a missing or disabled shim from a removed native guard", () => {
    const { fixture, clone } = installed();
    const shim = join(clone, ".coord/bin/git");
    chmodSync(shim, 0o600);
    expect(report(fixture).findings.map((item) => item.class)).toContain("gitShim");
    rmSync(shim);
    expect(report(fixture).findings.map((item) => item.class)).toContain("gitShim");
    const hooks = join(clone, ".claude/settings.local.json");
    const doc = JSON.parse(readFileSync(hooks, "utf8")) as { hooks: Record<string, unknown> };
    delete doc.hooks.PreToolUse;
    writeFileSync(hooks, JSON.stringify(doc));
    expect(report(fixture).findings).toContainEqual(expect.objectContaining({ class: "lifecycleHooks", message: expect.stringContaining("shell guard") }));
  });
  it("reports nothing on a healthy install", () => {
    const { fixture } = installed();
    const result = report(fixture);
    expect(result.findings).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(renderDoctorReport(result)).toContain("no findings");
  });

  it("reports a missing install root distinctly", () => {
    const { fixture, configPath } = installed();
    editConfig(configPath, (config) => {
      (config.coordination as Record<string, unknown>).installRoot = join(fixture.workspaceRoot, "gone");
    });
    const result = report(fixture);
    expect(result.exitCode).toBe(DOCTOR_CODES.installRoot);
    expect(result.findings.map((item) => item.class)).toContain("installRoot");
  });

  it("reports missing hooks distinctly from a missing launcher", () => {
    const withoutHooks = installed();
    rmSync(join(withoutHooks.clone, ".git", "hooks", "coord-hooks.json"));
    rmSync(join(withoutHooks.clone, ".git", "hooks", "pre-commit"));
    expect(report(withoutHooks.fixture).findings.map((item) => item.code)).toContain(DOCTOR_CODES.hooks);

    const withoutLauncher = installed();
    rmSync(join(withoutLauncher.clone, "start-claude.sh"));
    const launcherFindings = report(withoutLauncher.fixture).findings;
    expect(launcherFindings.map((item) => item.code)).toContain(DOCTOR_CODES.launcher);
    expect(launcherFindings.map((item) => item.code)).not.toContain(DOCTOR_CODES.hooks);
  });

  it("reports disabled Claude quota telemetry without changing anything", () => {
    const { fixture, clone } = installed();
    const launcher = join(clone, "start-claude.sh");
    writeFileSync(launcher, `${readFileSync(launcher, "utf8")}\n# exec claude --settings /elsewhere.json\n`);
    const local = readFileSync(join(clone, ".claude", "settings.local.json"), "utf8");
    const telemetry = report(fixture).findings.filter((item) => item.class === "resourceTelemetry");
    expect(telemetry).toEqual([expect.objectContaining({ code: DOCTOR_CODES.resourceTelemetry, message: expect.stringContaining("--settings") })]);
    expect(readFileSync(join(clone, ".claude", "settings.local.json"), "utf8")).toBe(local);
  });

  it("reports missing CLI lifecycle hooks separately from Git hooks", () => {
    const { fixture, clone } = installed();
    rmSync(join(clone, ".claude", "settings.local.json"));
    const findings = report(fixture).findings;
    expect(findings.map((item) => item.code)).toContain(DOCTOR_CODES.lifecycleHooks);
    expect(findings.map((item) => item.code)).not.toContain(DOCTOR_CODES.hooks);
  });

  it("reports nudge delivery for an agent id with no lifecycle vendor mapping", () => {
    const { fixture, clone, configPath } = installed();
    editConfig(configPath, (config) => {
      const agent = (config.agents as Array<Record<string, unknown>>)[0];
      if (agent === undefined) throw new Error("missing fixture agent");
      agent.id = "claude-a";
    });
    git(clone, "config", "--local", "consensus.agentId", "claude-a");

    const lifecycle = report(fixture).findings.find((item) => item.class === "lifecycleHooks");
    expect(lifecycle?.message).toContain("no supported lifecycle-hook vendor mapping");
    expect(lifecycle?.remediation).toContain("delivery to pull");
  });

  it("reports a missing or crossed agent identity", () => {
    const { fixture, clone } = installed();
    git(clone, "config", "--local", "--unset", "consensus.agentId");
    expect(report(fixture).findings.map((item) => item.code)).toContain(DOCTOR_CODES.identity);

    git(clone, "config", "--local", "consensus.agentId", "codex");
    const crossed = report(fixture).findings.find((item) => item.class === "identity");
    expect(crossed?.message).toContain("'codex'");
  });

  it("reports a stale vendor stamp", () => {
    // A genuine vendor install: the copies exist, so what makes them stale is
    // the recorded source commit, not their absence.
    ensureBuilt();
    const fixture = makeProduct();
    fixtures.push(fixture);
    install({
      installRoot: repoRoot,
      productRoot: fixture.productRoot,
      coordRoot: fixture.coordRoot,
      agents: ["claude"],
      profile: "solo",
      declarePath: writeDeclaration(fixture.workspaceRoot, { checks: declaredChecks, verify: passingVerify }),
      writeProduct: false,
      vendor: true,
      bootstrap: false,
      dryRun: false,
      log: silence().log
    });
    const configPath = join(fixture.coordRoot, "config.json");
    editConfig(configPath, (config) => {
      (config.coordination as Record<string, unknown>).commit = "a".repeat(40);
    });
    expect(report(fixture).findings.map((item) => item.code)).toContain(DOCTOR_CODES.vendorStamp);
  });

  it("reports a config coord start would refuse", () => {
    const { fixture, configPath } = installed();
    editConfig(configPath, (config) => {
      config.prPolicy = "coord-open-unmerged";
      config.origin = "/local/path/not-github.git";
    });
    const findings = report(fixture).findings;
    expect(findings.map((item) => item.code)).toContain(DOCTOR_CODES.startCompatibility);
    expect(findings.find((item) => item.class === "startCompatibility")?.message).toContain("github.com");
  });

  it("reports a declared executable that is not on PATH, at install time", () => {
    const { fixture } = installed({
      checks: [{ name: "test", argv: ["definitely-not-a-real-binary-xyz"] }],
      verify: passingVerify
    });
    const findings = report(fixture).findings;
    expect(findings.map((item) => item.code)).toContain(DOCTOR_CODES.toolchain);
    expect(findings.find((item) => item.class === "toolchain")?.subject).toBe("definitely-not-a-real-binary-xyz");
  });

  it("reports an undeclared verify, which would block every agent commit", () => {
    // A tree with no recognisable ecosystem gets no proposed verify either,
    // so nothing quietly fills the gap.
    const { fixture } = installed({ checks: declaredChecks }, "plain");
    expect(report(fixture).findings.map((item) => item.code)).toContain(DOCTOR_CODES.verifyUndeclared);
  });

  it("reports install-root drift separately from a missing install root", () => {
    const { fixture, configPath } = installed();
    editConfig(configPath, (config) => {
      (config.coordination as Record<string, unknown>).commit = "b".repeat(40);
    });
    const findings = report(fixture).findings;
    expect(findings.map((item) => item.code)).toContain(DOCTOR_CODES.installDrift);
    expect(findings.map((item) => item.code)).not.toContain(DOCTOR_CODES.installRoot);
  });

  it("exits with the lowest code when several classes are wrong at once", () => {
    const { fixture, clone } = installed();
    rmSync(join(clone, "start-claude.sh"));
    git(clone, "config", "--local", "--unset", "consensus.agentLabel");
    const result = report(fixture);
    expect(result.findings.length).toBeGreaterThan(1);
    expect(result.exitCode).toBe(Math.min(...result.findings.map((item) => item.code)));
    expect(renderDoctorReport(result)).toContain(`exit ${result.exitCode}`);
  });
});

describe("startup agent wiring", () => {
  it("checks one agent's installed wiring and issue branch without doctor's overlay advice", () => {
    const { clone, configPath } = installed();
    const config = readConfig(configPath);
    const agent = config.agents[0]!;
    git(clone, "checkout", "-qb", "issue-9/claude");
    git(clone, "add", "-f", "--", "AGENTS.md");
    git(clone, "commit", "-qm", "Claude: track agents");
    writeCloneAgentsProtocol({ clone, installRoot: repoRoot, options: { dryRun: false, log: () => undefined, changes: [] } });
    expect(inspectAgentWiring({ config, configPath, agent, expectedBranch: "issue-9/claude" })).toEqual([]);
    expect(inspectAgentWiring({ config, configPath, agent, expectedBranch: "issue-10/claude" }))
      .toEqual([expect.objectContaining({ class: "startCompatibility", message: expect.stringContaining("not the issue branch 'issue-10/claude'") })]);
    rmSync(join(clone, ".claude", "settings.local.json"));
    expect(inspectAgentWiring({ config, configPath, agent, expectedBranch: null }).map((item) => item.class)).toEqual(["lifecycleHooks"]);
    const unstamped = { ...config };
    delete unstamped.coordination;
    expect(inspectAgentWiring({ config: unstamped, configPath, agent, expectedBranch: null }))
      .toContainEqual(expect.objectContaining({ class: "installRoot", message: expect.stringContaining("hook wiring is unknown") }));
  });
});

describe("coord doctor — broken clones and configs", () => {
  it("reports, rather than throws, when a clone is no longer a repository", () => {
    const { fixture, clone } = installed();
    rmSync(join(clone, ".git"), { recursive: true, force: true });
    const result = report(fixture);
    expect(result.findings.map((item) => item.code)).toContain(DOCTOR_CODES.cloneMissing);
    expect(result.findings.map((item) => item.class)).not.toContain("identity");
  });

  it("reports a missing clone under its own class, not as an identity fault", () => {
    const { fixture, clone } = installed();
    rmSync(clone, { recursive: true, force: true });
    const findings = report(fixture).findings;
    expect(findings.map((item) => item.code)).toContain(DOCTOR_CODES.cloneMissing);
    expect(findings.map((item) => item.code)).not.toContain(DOCTOR_CODES.identity);
  });

  it("classifies a config coord start could not read", () => {
    const { fixture, configPath } = installed();
    writeFileSync(configPath, "{ not json");
    const result = report(fixture);
    expect(result.exitCode).toBe(DOCTOR_CODES.startCompatibility);
    expect(result.findings[0]?.class).toBe("startCompatibility");
  });

  // Branch preparation clears the bit to move HEAD and re-sets it afterwards. A
  // clone found with it clear means that restore did not finish, and the only
  // other symptom is a confusing "uncommitted changes" refusal on the next start.
  it("reports an AGENTS.md that lost its skip-worktree bit", () => {
    const { fixture, clone } = installed();
    // This workspace installed without --write-product, so the overlay sits in
    // an untracked AGENTS.md and the bit does not apply. Stage it to get the
    // tracked shape a --write-product workspace has.
    git(clone, "add", "-f", "--", "AGENTS.md");
    git(clone, "update-index", "--skip-worktree", "--", "AGENTS.md");
    expect(report(fixture).findings.map((item) => item.class)).not.toContain("agentsProtocol");

    git(clone, "update-index", "--no-skip-worktree", "--", "AGENTS.md");
    const findings = report(fixture).findings;
    expect(findings.map((item) => item.code)).toContain(DOCTOR_CODES.agentsProtocol);
    expect(findings.find((item) => item.class === "agentsProtocol")?.message).toContain("skip-worktree");
  });

  it("tells the owner to run coord reset-clones when overlay sits on an issue branch", () => {
    const { fixture, clone } = installed();
    git(clone, "checkout", "-qb", "issue-9/claude");
    git(clone, "add", "-f", "--", "AGENTS.md");
    git(clone, "commit", "-qm", "Claude: track agents");
    writeCloneAgentsProtocol({
      clone,
      installRoot: repoRoot,
      options: { dryRun: false, log: () => undefined, changes: [] }
    });
    const findings = report(fixture).findings;
    const protocol = findings.find((item) => item.class === "agentsProtocol");
    expect(protocol?.message).toContain("issue-9/claude");
    expect(protocol?.remediation).toContain("coord reset-clones 9");
    expect(protocol?.remediation).toContain("Do not run git checkout main");
  });

  it("reports a clone redirected at a different install root", () => {
    const { fixture, clone } = installed();
    git(clone, "config", "--local", "coord.installRoot", join(fixture.workspaceRoot, "another-checkout"));
    expect(report(fixture).findings.map((item) => item.code)).toContain(DOCTOR_CODES.installDrift);
  });

  it("reports hooks that lost the execute bit", () => {
    const { fixture, clone } = installed();
    chmodSync(join(clone, ".git", "hooks", "pre-commit"), 0o644);
    const findings = report(fixture).findings;
    expect(findings.map((item) => item.code)).toContain(DOCTOR_CODES.hooks);
    expect(findings.find((item) => item.class === "hooks")?.message).toContain("not executable");
  });

  it("reports a manifest that names a path it may not", () => {
    const { fixture, clone } = installed();
    const manifestFile = join(clone, ".git", "hooks", "coord-hooks.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as { files: Record<string, string> };
    manifest.files["../../../victim"] = "a".repeat(64);
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    expect(report(fixture).findings.map((item) => item.code)).toContain(DOCTOR_CODES.hooks);
  });
});
