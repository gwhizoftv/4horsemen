import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertInstallDeletionAllowed, install, uninstall } from "../src/install.js";
import { readConfig } from "../src/state.js";
import { nestedConfigPath } from "../src/workspace.js";
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
  it("advertises owner-driven manual work after installation", () => {
    const fixture = product();
    const output: string[] = [];
    installOnce(fixture, { log: (message) => output.push(message) });
    expect(output.join("")).toContain("coord manual --product ");
  });

  it("keeps every vendor identity source manual-aware", () => {
    const branches: Record<string, string> = {
      claude: "claude/<name>",
      codex: "codex/<name>",
      cursor: "cursor/<name>",
      antigravity: "antigravity/<name>"
    };
    for (const [agent, branch] of Object.entries(branches)) {
      const source = readFileSync(join(repoRoot, `scripts/setup_${agent}.sh`), "utf8");
      expect(source).toContain("manual chat task");
      expect(source).toContain(branch);
      expect(source).toContain("fabricate coordinator evidence");
      expect(source).toContain("NEVER use --no-verify");
    }
  });

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
    const launcher = readFileSync(join(clone, "start-claude.sh"), "utf8");
    expect(launcher).toContain("Owner-driven manual mode");
    expect(launcher).toContain("claude/<name>");
    expect(git(clone, "config", "--local", "--get", "consensus.agentId")).toBe("claude");
    expect(git(clone, "config", "--local", "--get", "coord.installRoot")).toBe(repoRoot);
    expect(git(clone, "config", "--local", "--get", "coord.workspaceConfig")).toBe(result.configPath);
    expect(readConfig(result.configPath).prPolicy).toBe("coord-open-unmerged");
    expect(readFileSync(join(clone, ".git", "info", "exclude"), "utf8")).toContain("/start-*.sh");
    const agentsMd = readFileSync(join(clone, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("## Exact File List to be changed or deleted");
    expect(agentsMd).toContain("## Exact file list to be created");
    expect(agentsMd).toContain("action.md");
    expect(agentsMd).toContain("If `actionId` in the front matter has changed");
    expect(agentsMd).toContain("skip-worktree");
    expect(agentsMd).toContain("owner-driven manual mode");
    expect(agentsMd).toContain("<agent>/<name>");
    expect(agentsMd).toContain("must not fabricate");
    expect(existsSync(join(clone, "CLAUDE.md"))).toBe(true);
    expect(readFileSync(join(clone, "CLAUDE.md"), "utf8")).toContain("@AGENTS.md");
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
    expect(config.coordination?.version).toBe("0.0.14");
    expect(config.coordination?.vendored).toBe(false);
    expect(config.agents[0]?.launcher).toBe("start-claude.sh");
  });

  it("records the install stamp under coord-root, never in the product tree", () => {
    const fixture = product();
    const result = installOnce(fixture);
    expect(result.configPath.startsWith(fixture.coordRoot)).toBe(true);
    expect(result.configPath).toBe(join(fixture.coordRoot, "config.json"));
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

  it("preserves human AGENTS.md text and appends the protocol block with --write-product", () => {
    const fixture = product();
    writeFileSync(join(fixture.productRoot, "AGENTS.md"), "# ours\n");
    installOnce(fixture, { writeProduct: true });
    const agents = readFileSync(join(fixture.productRoot, "AGENTS.md"), "utf8");
    expect(agents.startsWith("# ours\n")).toBe(true);
    expect(agents).toContain("coordination protocol");
    expect(agents).toContain("## Exact File List to be changed or deleted");
    expect(agents).toContain("action.md");
  });
});

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

const expectCoordinationDeletionRefused = (
  fixture: ProductFixture,
  installed: ReturnType<typeof install>
): void => {
  const owned = readConfig(installed.configPath).coordination?.ownsInstallRoot === true;
  expect(() => uninstallOnce(fixture, { deleteCoordination: true })).toThrow(
    owned ? /test run \(VITEST is set\) must not delete/ : /not create the coordination checkout/
  );
  expect(existsSync(join(repoRoot, "package.json"))).toBe(true);
};

describe("install deletion guard", () => {
  it("refuses to delete an install while VITEST is set", () => {
    expect(() =>
      assertInstallDeletionAllowed("/tmp/coord-install", {
        force: false,
        cwd: "/elsewhere",
        env: { VITEST: "true" }
      })
    ).toThrow(/test run \(VITEST is set\) must not delete/);
  });

  it("does not treat --force as a test-run escape hatch", () => {
    expect(() =>
      assertInstallDeletionAllowed("/tmp/coord-install", {
        force: true,
        cwd: "/elsewhere",
        env: { VITEST: "true" }
      })
    ).toThrow(/test run \(VITEST is set\) must not delete/);
  });

  it("allows a disposable install when COORD_ALLOW_DELETE_INSTALL is set", () => {
    expect(() =>
      assertInstallDeletionAllowed("/tmp/coord-install", {
        force: false,
        cwd: "/elsewhere",
        env: { VITEST: "true", COORD_ALLOW_DELETE_INSTALL: "1" }
      })
    ).not.toThrow();
  });

  it("refuses to delete the install that contains cwd unless --force", () => {
    expect(() =>
      assertInstallDeletionAllowed("/tmp/coord-install", {
        force: false,
        cwd: "/tmp/coord-install/src",
        env: {}
      })
    ).toThrow(/current working directory/);
    expect(() =>
      assertInstallDeletionAllowed("/tmp/coord-install", {
        force: true,
        cwd: "/tmp/coord-install/src",
        env: {}
      })
    ).not.toThrow();
  });
});

describe("coord uninstall", () => {
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

  it("refuses --delete-coordination for a checkout it did not create", () => {
    const fixture = product();
    const installed = installOnce(fixture);
    expectCoordinationDeletionRefused(fixture, installed);
  });
});

describe("coord install — preflight before effects", () => {
  it("rejects a malformed or duplicated agent id before creating anything", () => {
    const fixture = product();
    expect(() => installOnce(fixture, { agents: ["../../escaped"] })).toThrow(/not a valid agent id/);
    expect(() => installOnce(fixture, { agents: ["claude", "claude"] })).toThrow(/more than once/);
    expect(() => installOnce(fixture, { agents: ["nosuchagent"] })).toThrow(/No launch command/);
    expect(readdirSync(fixture.workspaceRoot).sort()).toEqual(["d.json", "declare.json", "myserver", "myserver-origin.git"].filter((entry) => readdirSync(fixture.workspaceRoot).includes(entry)));
    expect(existsSync(join(fixture.workspaceRoot, "escaped"))).toBe(false);
    expect(existsSync(join(fixture.workspaceRoot, "myserver-claude"))).toBe(false);
  });

  it("refuses an undeclarable product without leaving a wired clone behind", () => {
    const fixture = product("plain");
    expect(() =>
      installOnce(fixture, {
        declarePath: writeDeclaration(fixture.workspaceRoot, { verify: passingVerify }, "no-checks")
      })
    ).toThrow(/Cannot infer finalization checks/);
    expect(existsSync(join(fixture.workspaceRoot, "myserver-claude"))).toBe(false);
    expect(git(fixture.productRoot, "status", "--porcelain")).toBe("");
  });

  it("refuses to adopt a directory that is not a clone of this product", () => {
    const notARepo = product();
    const path = join(notARepo.workspaceRoot, "myserver-claude");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "UNRELATED.txt"), "someone else's files\n");
    expect(() => installOnce(notARepo)).toThrow(/not the root of a git worktree/);
    expect(readdirSync(path)).toEqual(["UNRELATED.txt"]);

    const wrongOrigin = product();
    const stranger = join(wrongOrigin.workspaceRoot, "myserver-claude");
    git(wrongOrigin.workspaceRoot, "init", "-q", stranger);
    git(stranger, "remote", "add", "origin", "https://example.com/other.git");
    expect(() => installOnce(wrongOrigin)).toThrow(/not of /);
  });

  it("leaves no staging file in the clone during a dry run", () => {
    const fixture = product();
    const result = installOnce(fixture);
    const dry = installOnce(fixture, { dryRun: true });
    expect(dry.changes).toEqual([]);
    expect(readdirSync(result.clones[0] as string).filter((entry) => entry.includes("coord-tmp"))).toEqual([]);
  });
});

describe("coord install — reinstall", () => {
  it("fast-forwards a clean clone and refuses to rewrite a dirty one", () => {
    const fixture = product();
    const clone = installOnce(fixture).clones[0] as string;
    const before = git(clone, "rev-parse", "HEAD");

    writeFileSync(join(fixture.productRoot, "cmd", "later.go"), "package main\n");
    git(fixture.productRoot, "add", "-A");
    git(fixture.productRoot, "commit", "-qm", "later work");
    git(fixture.productRoot, "push", "-q", "origin", "main");

    installOnce(fixture);
    expect(git(clone, "rev-parse", "HEAD")).not.toBe(before);

    writeFileSync(join(clone, "dirty.txt"), "uncommitted\n");
    const advanced = git(clone, "rev-parse", "HEAD");
    installOnce(fixture);
    expect(git(clone, "rev-parse", "HEAD")).toBe(advanced);
    expect(readFileSync(join(clone, "dirty.txt"), "utf8")).toBe("uncommitted\n");
  });

  it("refreshes every stamp field that the run's options changed", () => {
    const fixture = product();
    installOnce(fixture);
    const result = installOnce(fixture, { writeProduct: true });
    expect(readConfig(result.configPath).coordination?.wroteProductIgnore).toBe(true);

    uninstallOnce(fixture);
    expect(readFileSync(join(fixture.productRoot, ".gitignore"), "utf8")).not.toContain("coordination managed block");
    expect(existsSync(join(fixture.productRoot, "AGENTS.md"))).toBe(false);
  });
});

describe("coord uninstall — scope", () => {
  it("keeps owner-authored material in the workspace directory", () => {
    const fixture = product();
    const result = installOnce(fixture);
    const plans = join(dirname(result.configPath), ".plans", "issue-7");
    mkdirSync(plans, { recursive: true });
    writeFileSync(join(plans, "plan.md"), "# owner-authored plan\n");

    uninstallOnce(fixture);
    expect(existsSync(result.configPath)).toBe(false);
    expect(readFileSync(join(plans, "plan.md"), "utf8")).toContain("owner-authored");
  });

  it("decides the dirty-clone refusal before unwiring anything", () => {
    const fixture = product();
    const result = install({
      installRoot: repoRoot,
      productRoot: fixture.productRoot,
      coordRoot: fixture.coordRoot,
      agents: ["claude", "codex"],
      profile: "consensus",
      declarePath: writeDeclaration(fixture.workspaceRoot, { checks: declaredChecks, verify: passingVerify }, "two"),
      writeProduct: false,
      vendor: false,
      bootstrap: false,
      dryRun: false,
      log: silence().log
    });
    const [claude, codex] = result.clones as [string, string];
    writeFileSync(join(codex, "dirty.txt"), "uncommitted\n");

    expect(() => uninstallOnce(fixture, { deleteClones: true })).toThrow(/Nothing has been changed/);
    expect(existsSync(claude)).toBe(true);
    expect(existsSync(join(claude, ".git", "hooks", "pre-commit"))).toBe(true);
    expect(git(claude, "config", "--local", "--get", "consensus.agentId")).toBe("claude");
  });

  it("flat --wipe-runtime deletes the outer root when it is the sole workspace", () => {
    const fixture = product();
    installOnce(fixture);
    mkdirSync(join(fixture.coordRoot, "issue-1"));
    mkdirSync(join(fixture.coordRoot, "mirror.git"));
    uninstallOnce(fixture, { wipeRuntime: true });
    expect(existsSync(fixture.coordRoot)).toBe(false);
  });

  it("flat --wipe-runtime never deletes nested siblings when forced on a shared root", () => {
    const first = product();
    installOnce(first);
    const second = makeProduct("go", "otherserver");
    fixtures.push(second);
    install({
      installRoot: repoRoot,
      productRoot: second.productRoot,
      coordRoot: first.coordRoot,
      agents: ["codex"],
      profile: "solo",
      declarePath: writeDeclaration(second.workspaceRoot, { checks: declaredChecks, verify: passingVerify }),
      writeProduct: false,
      vendor: false,
      bootstrap: false,
      dryRun: false,
      log: silence().log
    });
    // Two products share one runtime; both workspaces live under it.
    const otherWorkspace = dirname(nestedConfigPath(first.coordRoot, "otherserver"));
    expect(existsSync(otherWorkspace)).toBe(true);
    mkdirSync(join(first.coordRoot, "issue-1"));
    mkdirSync(join(first.coordRoot, "mirror.git"));

    expect(() => uninstallOnce(first, { wipeRuntime: true })).toThrow(/other workspace/);
    expect(existsSync(otherWorkspace)).toBe(true);
    uninstallOnce(first, { wipeRuntime: true, force: true });
    expect(existsSync(first.coordRoot)).toBe(true);
    expect(existsSync(nestedConfigPath(first.coordRoot, "otherserver"))).toBe(true);
    expect(existsSync(join(first.coordRoot, "issue-1"))).toBe(false);
    expect(existsSync(join(first.coordRoot, "mirror.git"))).toBe(false);
  });

  it("refuses --delete-coordination because no install owns the checkout", () => {
    const fixture = product();
    const installed = installOnce(fixture, { bootstrap: false });
    expectCoordinationDeletionRefused(fixture, installed);
  });
});
