import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { install, uninstall } from "../src/install.js";
import { readConfig } from "../src/state.js";
import { workspaceConfigPath } from "../src/setupWorkspace.js";
import {
  declaredChecks,
  ensureBuilt,
  git,
  makeProduct,
  passingVerify,
  repoRoot,
  silence,
  tryGit,
  writeDeclaration,
  type ProductFixture
} from "./support/workspaceFixture.js";

const fixtures: ProductFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

const product = (kind: "go" | "plain" = "go"): ProductFixture => {
  ensureBuilt();
  const fixture = makeProduct(kind);
  fixtures.push(fixture);
  return fixture;
};

const installOnce = (
  fixture: ProductFixture,
  overrides: Partial<Parameters<typeof install>[0]> = {}
): ReturnType<typeof install> => {
  const io = silence();
  return install({
    installRoot: repoRoot,
    productRoot: fixture.productRoot,
    coordRoot: fixture.coordRoot,
    agents: ["claude"],
    profile: "solo",
    writeProduct: false,
    vendor: false,
    bootstrap: false,
    dryRun: false,
    log: io.log,
    declarePath: writeDeclaration(fixture.workspaceRoot, { checks: declaredChecks, verify: passingVerify }),
    ...overrides
  });
};

describe("coord install — two-mode footprint", () => {
  it("leaves the product master with an empty git status", () => {
    const fixture = product();
    installOnce(fixture);
    expect(git(fixture.productRoot, "status", "--porcelain")).toBe("");
    expect(existsSync(join(fixture.productRoot, "githooks"))).toBe(false);
    expect(existsSync(join(fixture.productRoot, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(fixture.productRoot, ".gitignore"))).toBe(false);
  });

  it("leaves a fresh human clone with no coordination hooks and no new obligations", () => {
    const fixture = product();
    installOnce(fixture);

    const humanClone = join(fixture.workspaceRoot, "human");
    git(fixture.workspaceRoot, "clone", "-q", fixture.originPath, humanClone);
    git(humanClone, "config", "user.name", "Human");
    git(humanClone, "config", "user.email", "human@example.com");

    expect(existsSync(join(humanClone, ".git", "hooks", "coord-hooks.json"))).toBe(false);
    expect(existsSync(join(humanClone, ".git", "hooks", "pre-commit"))).toBe(false);

    // On main, with no agent prefix, and with no coordination anywhere on PATH.
    writeFileSync(join(humanClone, "notes.txt"), "human edit\n");
    git(humanClone, "add", "-A");
    const committed = tryGit(humanClone, "commit", "-qm", "just a normal commit");
    expect(committed.exitCode).toBe(0);
    expect(`${committed.stdout}${committed.stderr}`).not.toContain("coordination");
  });

  it("wires the agent clone rather than the product", () => {
    const fixture = product();
    const result = installOnce(fixture);
    const clone = result.clones[0] as string;

    expect(existsSync(join(clone, ".git", "hooks", "pre-commit"))).toBe(true);
    expect(existsSync(join(clone, "start-claude.sh"))).toBe(true);
    expect(git(clone, "config", "--local", "--get", "consensus.agentId")).toBe("claude");
    expect(git(clone, "config", "--local", "--get", "coord.installRoot")).toBe(repoRoot);
    expect(git(clone, "config", "--local", "--get", "coord.workspaceConfig")).toBe(result.configPath);
    expect(readFileSync(join(clone, ".git", "info", "exclude"), "utf8")).toContain("/start-*.sh");
  });
});

describe("coord install — idempotence", () => {
  it("makes no changes on a second run", () => {
    const fixture = product();
    const first = installOnce(fixture);
    expect(first.changes.length).toBeGreaterThan(0);

    const second = installOnce(fixture);
    expect(second.changes).toEqual([]);
  });

  it("dry-run reports work without performing it", () => {
    const fixture = product();
    const dry = installOnce(fixture, { dryRun: true });
    expect(dry.changes.length).toBeGreaterThan(0);
    expect(existsSync(dry.configPath)).toBe(false);
    expect(existsSync(join(fixture.workspaceRoot, "myserver-claude"))).toBe(false);
    expect(git(fixture.productRoot, "status", "--porcelain")).toBe("");
  });
});

describe("coord install — emitted config", () => {
  it("is accepted by the driver's own config parser unchanged", () => {
    const fixture = product();
    const result = installOnce(fixture);
    const config = readConfig(result.configPath);
    expect(config.project).toBe("myserver");
    expect(config.checks).toEqual(declaredChecks);
    expect(config.coordination?.installRoot).toBe(repoRoot);
    expect(config.coordination?.version).toBe("0.1.0");
    expect(config.coordination?.vendored).toBe(false);
    expect(config.agents[0]?.launcher).toBe("start-claude.sh");
  });

  it("records the install stamp under coord-root, never in the product tree", () => {
    const fixture = product();
    const result = installOnce(fixture);
    expect(result.configPath.startsWith(fixture.coordRoot)).toBe(true);
    expect(result.configPath).toBe(workspaceConfigPath(fixture.coordRoot, "myserver"));
    expect(git(fixture.productRoot, "status", "--porcelain")).toBe("");
  });

  it("refuses to install a workspace whose finalization checks nobody declared", () => {
    const fixture = product("plain");
    expect(() =>
      installOnce(fixture, {
        declarePath: writeDeclaration(fixture.workspaceRoot, { verify: passingVerify }, "verify-only")
      })
    ).toThrow(/Cannot infer finalization checks/);
  });
});

describe("coord install — opt-in product changes", () => {
  it("writes the managed ignore block and AGENTS.md only with --write-product", () => {
    const fixture = product();
    installOnce(fixture, { writeProduct: true });
    const ignore = readFileSync(join(fixture.productRoot, ".gitignore"), "utf8");
    expect(ignore).toContain("coordination managed block");
    expect(ignore).toContain("/start-*.sh");
    expect(existsSync(join(fixture.productRoot, "AGENTS.md"))).toBe(true);
    expect(git(fixture.productRoot, "status", "--porcelain")).not.toBe("");
  });

  it("never overwrites a human-authored AGENTS.md", () => {
    const fixture = product();
    writeFileSync(join(fixture.productRoot, "AGENTS.md"), "# ours\n");
    installOnce(fixture, { writeProduct: true });
    expect(readFileSync(join(fixture.productRoot, "AGENTS.md"), "utf8")).toBe("# ours\n");
  });
});

describe("coord uninstall", () => {
  const uninstallOnce = (fixture: ProductFixture, overrides: Partial<Parameters<typeof uninstall>[0]> = {}) =>
    uninstall({
      coordRoot: fixture.coordRoot,
      productRoot: fixture.productRoot,
      deleteClones: false,
      wipeRuntime: false,
      deleteCoordination: false,
      force: false,
      dryRun: false,
      log: silence().log,
      ...overrides
    });

  it("clears the wiring and the workspace entry, and keeps the clone", () => {
    const fixture = product();
    const result = installOnce(fixture);
    const clone = result.clones[0] as string;

    uninstallOnce(fixture);

    expect(existsSync(clone)).toBe(true);
    expect(existsSync(join(clone, ".git", "hooks", "pre-commit"))).toBe(false);
    expect(existsSync(join(clone, ".git", "hooks", "coord-hooks.json"))).toBe(false);
    expect(existsSync(join(clone, "start-claude.sh"))).toBe(false);
    expect(tryGit(clone, "config", "--local", "--get", "consensus.agentId").exitCode).not.toBe(0);
    expect(readFileSync(join(clone, ".git", "info", "exclude"), "utf8")).not.toContain("coordination managed block");
    expect(existsSync(result.configPath)).toBe(false);
  });

  it("removes the managed product ignore block only when the install wrote it", () => {
    const written = product();
    writeFileSync(join(written.productRoot, ".gitignore"), "# product's own\nbuild/\n");
    installOnce(written, { writeProduct: true });
    uninstallOnce(written);
    const remaining = readFileSync(join(written.productRoot, ".gitignore"), "utf8");
    expect(remaining).toContain("build/");
    expect(remaining).not.toContain("coordination managed block");

    const untouched = product();
    writeFileSync(join(untouched.productRoot, ".gitignore"), "# product's own\nbuild/\n");
    git(untouched.productRoot, "add", "-A");
    git(untouched.productRoot, "commit", "-qm", "add ignore");
    installOnce(untouched);
    uninstallOnce(untouched);
    expect(readFileSync(join(untouched.productRoot, ".gitignore"), "utf8")).toBe("# product's own\nbuild/\n");
  });

  it("refuses to delete a dirty clone without --force", () => {
    const fixture = product();
    const result = installOnce(fixture);
    const clone = result.clones[0] as string;
    writeFileSync(join(clone, "cmd", "extra.go"), "package main\n");
    git(clone, "add", "-A");

    expect(() => uninstallOnce(fixture, { deleteClones: true })).toThrow(/uncommitted changes/);
    expect(existsSync(clone)).toBe(true);

    uninstallOnce(fixture, { deleteClones: true, force: true });
    expect(existsSync(clone)).toBe(false);
  });

  it("refuses --delete-coordination unless the install bootstrapped it", () => {
    const fixture = product();
    installOnce(fixture);
    expect(() => uninstallOnce(fixture, { deleteCoordination: true })).toThrow(/bootstrap ownership/);
    expect(existsSync(join(repoRoot, "package.json"))).toBe(true);
  });
});
