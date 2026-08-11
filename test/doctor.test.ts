import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DOCTOR_CODES, doctor, renderDoctorReport } from "../src/doctor.js";
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

  it("reports a missing or crossed agent identity", () => {
    const { fixture, clone } = installed();
    git(clone, "config", "--local", "--unset", "consensus.agentId");
    expect(report(fixture).findings.map((item) => item.code)).toContain(DOCTOR_CODES.identity);

    git(clone, "config", "--local", "consensus.agentId", "codex");
    const crossed = report(fixture).findings.find((item) => item.class === "identity");
    expect(crossed?.message).toContain("'codex'");
  });

  it("reports a stale vendor stamp", () => {
    const { fixture, clone } = installed();
    const manifestPath = join(clone, ".git", "hooks", "coord-hooks.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, mode: "vendor", sourceCommit: "a".repeat(40) }, null, 2));
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
