import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findAgentLanguageViolations } from "../src/agentLanguage.js";
import { assertInstallDeletionAllowed, install, uninstall } from "../src/install.js";
import { readConfig } from "../src/state.js";
import { inspectClaudeStatusLine } from "../src/claudeStatusLine.js";
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
    home: fixture.workspaceRoot,
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

  it("writes per-agent Terminal profile defaults into workspace config", () => {
    const fixture = product();
    const result = installOnce(fixture, {
      agents: ["claude", "codex", "cursor", "antigravity"]
    });
    const profiles = Object.fromEntries(
      readConfig(result.configPath).agents.map((agent) => [agent.id, agent.terminalProfile])
    );
    expect(profiles).toEqual({
      claude: "Claude 1",
      codex: "Codex 1",
      cursor: "Cursor 1",
      antigravity: "Gemini 1"
    });
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
    expect(launcher).toContain("exec claude --permission-mode auto");
    expect(git(clone, "config", "--local", "--get", "consensus.agentId")).toBe("claude");
    expect(git(clone, "config", "--local", "--get", "coord.installRoot")).toBe(repoRoot);
    expect(git(clone, "config", "--local", "--get", "coord.workspaceConfig")).toBe(result.configPath);
    expect(readConfig(result.configPath).prPolicy).toBe("coord-open-unmerged");
    expect(readFileSync(join(clone, ".git", "info", "exclude"), "utf8")).toContain("/start-*.sh");
    const agentsMd = readFileSync(join(clone, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("## Exact File List to be changed or deleted");
    expect(agentsMd).toContain("## Exact file list to be created");
    expect(agentsMd).toContain("## Reuse and Scope");
    expect(agentsMd).toContain("## Implementation discipline");
    for (const contract of ["A **plan review**", "A **code review**", "A **comparison**"]) {
      expect(agentsMd.indexOf(contract)).toBeLessThan(agentsMd.indexOf("## Implementation discipline"));
    }
    expect(agentsMd).toContain("action.md");
    expect(agentsMd).toContain("If `actionId` in the front matter has changed");
    expect(findAgentLanguageViolations(agentsMd)).toEqual([]);
    expect(agentsMd).toContain("skip-worktree");
    expect(agentsMd).toContain("owner-driven manual mode");
    expect(agentsMd).toContain("<agent>/<name>");
    expect(agentsMd).toContain("must not fabricate");
    expect(existsSync(join(clone, "CLAUDE.md"))).toBe(true);
    expect(readFileSync(join(clone, "CLAUDE.md"), "utf8")).toContain("@AGENTS.md");
  });

  it("seeds new agent clones from origin, not diverged local product main", () => {
    const fixture = product();
    writeFileSync(join(fixture.productRoot, "local-only.txt"), "should not seed clones\n");
    git(fixture.productRoot, "add", "local-only.txt");
    git(fixture.productRoot, "commit", "-qm", "local-only product commit");
    const result = installOnce(fixture);
    const clone = result.clones[0] as string;
    expect(existsSync(join(clone, "local-only.txt"))).toBe(false);
    expect(git(clone, "rev-parse", "HEAD")).toBe(git(fixture.originPath, "rev-parse", "refs/heads/main"));
    expect(git(clone, "remote", "get-url", "origin")).toBe(fixture.originPath);
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
    // Independent of `packageVersion`, which is what wrote this field.
    const expected = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string })
      .version;
    expect(config.coordination?.version).toBe(expected);
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
    home: fixture.workspaceRoot,
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
  it("wires and removes only a clone-local Claude tee", () => {
    const fixture = product();
    const result = installOnce(fixture, { home: fixture.workspaceRoot });
    const clone = result.clones[0]!;
    expect(inspectClaudeStatusLine(clone)).toBe("installed");
    expect(git(clone, "status", "--porcelain")).toBe("");
    uninstallOnce(fixture, { home: fixture.workspaceRoot });
    expect(inspectClaudeStatusLine(clone)).toBe("missing");
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

describe("completion mailbox wiring", () => {
  /**
   * The grant is resolved by the generated launcher at exec time, not baked in
   * at install: `githooks/post-merge` regenerates that file with no issue
   * number in hand, so a baked-in path would disagree with whichever writer ran
   * last. The clone key is how both writers reach the same mailbox.
   */
  it("records the mailbox root in the clone and grants only the current drop", () => {
    const fixture = product();
    const result = installOnce(fixture, { agents: ["claude", "codex"] });
    const config = JSON.parse(readFileSync(result.configPath, "utf8")) as {
      completesRoot?: string;
      coordination?: { completesRoot?: string };
    };
    const mailbox = config.completesRoot as string;

    expect(mailbox).toBeDefined();
    expect(isAbsolute(mailbox)).toBe(true);
    // A sibling, not a child: granting a path inside the coord root would grant
    // cursors.json and every peer's action.md along with it.
    expect(mailbox.startsWith(`${resolve(fixture.coordRoot)}/`)).toBe(false);
    expect(existsSync(mailbox)).toBe(true);
    expect(config.coordination?.completesRoot).toBe(mailbox);

    for (const clone of result.clones) {
      expect(git(clone, "config", "--local", "--get", "coord.completesRoot")).toBe(mailbox);
    }

    const launcher = readFileSync(join(result.clones[0] as string, "start-claude.sh"), "utf8");
    expect(launcher).toContain("--add-dir");
    expect(launcher).toContain('coord_drop="$coord_completes_root/issue-$COORD_ISSUE/claude"');
    // Never the whole mailbox (peers' receipts) and never the runtime.
    expect(launcher).not.toContain(`--add-dir "${mailbox}"`);
    expect(launcher).not.toContain(resolve(fixture.coordRoot));
  });

  it("stops launching Codex with blanket filesystem access", () => {
    const fixture = product();
    const result = installOnce(fixture, { agents: ["codex"] });
    const launcher = readFileSync(join(result.clones[0] as string, "start-codex.sh"), "utf8");
    // danger-full-access existed only because `complete` sat under the coord
    // root; the mailbox grant replaces the reason for it.
    expect(launcher).not.toContain("danger-full-access");
    expect(launcher).toContain("--sandbox workspace-write");
    expect(launcher).toContain("--ask-for-approval never");
  });

  /**
   * Executes the real generated launchers against stub harnesses and asserts the
   * exact argv. Asserting the rendered text alone cannot see an expansion that
   * aborts, a flag that lands in the wrong order, or a path with a space that
   * splits into two arguments — all of which reach the vendor, not the file.
   */
  it("passes each harness exactly its own current drop, and nothing in manual mode", () => {
    const fixture = product("plain");
    // A space in the path: the grant has to survive as one argument.
    const completesRoot = join(fixture.workspaceRoot, "completion mailbox");
    const agents = ["claude", "codex", "cursor", "antigravity"] as const;
    // The Antigravity launcher prepends $HOME/.local/bin, so HOME must point at
    // the fixture or the machine's real agy would shadow the stub.
    const home = join(fixture.workspaceRoot, "home");
    const result = installOnce(fixture, { agents, completesRoot, home });
    const bin = join(fixture.workspaceRoot, "stub-bin");
    mkdirSync(bin);
    for (const command of ["claude", "codex", "agent", "agy"]) {
      writeFileSync(join(bin, command), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$CAPTURE"\n', { mode: 0o755 });
    }

    const expected = {
      claude: ["--permission-mode", "auto"],
      codex: ["--ask-for-approval", "never", "--sandbox", "workspace-write"],
      cursor: ["--sandbox", "enabled"],
      antigravity: ["--mode", "accept-edits", "--dangerously-skip-permissions"]
    } as const;

    for (const [index, agent] of agents.entries()) {
      const clone = result.clones[index] as string;
      const drop = join(completesRoot, "issue-17", agent);
      mkdirSync(drop, { recursive: true });
      const responses = join(fixture.coordRoot, "issue-17", "agents", agent, "responses");
      mkdirSync(responses, { recursive: true });
      // Created before any harness starts, because the launcher resolves grants
      // once at exec and a directory appearing later can never reach it.
      const inputs = join(fixture.coordRoot, "issue-17", "inputs");
      const worktrees = join(fixture.coordRoot, "issue-17", "worktrees");
      mkdirSync(inputs, { recursive: true });
      mkdirSync(worktrees, { recursive: true });
      const capture = join(fixture.workspaceRoot, `${agent}.args`);
      // /bin/bash, not `bash`: macOS ships 3.2, where expanding an empty array
      // as "${a[@]}" under `set -u` aborts. A test that resolves a newer bash
      // from PATH cannot see that, and the launcher runs under whatever the
      // machine has.
      execFileSync("/bin/bash", [join(clone, `start-${agent}.sh`)], {
        cwd: clone,
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}`, COORD_ISSUE: "17", CAPTURE: capture },
        stdio: "ignore"
      });
      const argv = readFileSync(capture, "utf8").trimEnd().split("\n");
      expect(argv).toEqual([
        ...expected[agent],
        "--add-dir",
        drop,
        "--add-dir",
        responses,
        "--add-dir",
        inputs,
        "--add-dir",
        worktrees
      ]);
      // Never the runtime root as a grant, never the whole mailbox, never a peer's drop.
      expect(argv).not.toContain(fixture.coordRoot);
      expect(argv).not.toContain(completesRoot);
      expect(argv).not.toContain(join(completesRoot, "issue-17", agents[(index + 1) % agents.length]));
      expect(argv).not.toContain(join(fixture.coordRoot, "issue-17", "agents", agents[(index + 1) % agents.length], "responses"));
    }

    // Manual mode: no issue, so no grant — and the harness must still start.
    const claudeClone = result.clones[0] as string;
    const manual = join(fixture.workspaceRoot, "claude-manual.args");
    execFileSync("/bin/bash", [join(claudeClone, "start-claude.sh")], {
      cwd: claudeClone,
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}`, COORD_ISSUE: "", CAPTURE: manual },
      stdio: "ignore"
    });
    expect(readFileSync(manual, "utf8").trimEnd().split("\n")).toEqual(["--permission-mode", "auto"]);
  });

  /**
   * `scripts/setup_antigravity.sh` writes a user-global settings file that no
   * `coord` command reads back, so an upgrade repairs it or nothing does. Runs
   * the script's own embedded node program against a settings.json from before
   * the mailbox existed.
   */
  it("withdraws the peer-clone trust and non-workspace access an older Antigravity install kept", () => {
    const fixture = product();
    const script = readFileSync(join(repoRoot, "scripts", "setup_antigravity.sh"), "utf8");
    const program = /^node - "\$SETTINGS_FILE" "\$CLONE_DIR" <<'EOF'\n([\s\S]*?)\nEOF$/m.exec(script)?.[1];
    expect(program).toBeDefined();
    // .cjs: the embedded program uses require(), and this package is type: module.
    const programPath = join(fixture.workspaceRoot, "antigravity-settings.cjs");
    writeFileSync(programPath, program as string);

    const clone = join(fixture.workspaceRoot, "myapp-antigravity");
    const settingsPath = join(fixture.workspaceRoot, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        // What an install from before this issue left behind.
        allowNonWorkspaceAccess: true,
        permissions: { allow: ["command(ls)"] },
        trustedWorkspaces: [
          join(fixture.workspaceRoot, "myapp-claude"),
          join(fixture.workspaceRoot, "myapp-codex"),
          clone,
          join(fixture.workspaceRoot, "owner-notes")
        ]
      })
    );

    execFileSync("node", [programPath, settingsPath, clone], { stdio: "ignore" });
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      allowNonWorkspaceAccess: boolean;
      permissions: { allow: string[] };
      trustedWorkspaces: string[];
    };

    // A user-global grant of non-workspace access hands back the coordinator
    // runtime the mailbox exists to keep out; a launcher flag cannot narrow it.
    expect(settings.allowNonWorkspaceAccess).toBe(false);
    // Peer clones this script itself added are withdrawn: Antigravity must not
    // hold write trust on another agent's working tree.
    expect(settings.trustedWorkspaces).not.toContain(join(fixture.workspaceRoot, "myapp-claude"));
    expect(settings.trustedWorkspaces).not.toContain(join(fixture.workspaceRoot, "myapp-codex"));
    // Its own clone stays, and owner-authored entries are not this script's to
    // delete.
    expect(settings.trustedWorkspaces).toContain(clone);
    expect(settings.trustedWorkspaces).toContain(join(fixture.workspaceRoot, "owner-notes"));
    expect(settings.permissions.allow).toContain("command(ls)");
  });

  it("refuses a second workspace that would share one mailbox", () => {
    const first = product();
    const second = product();
    const shared = join(first.workspaceRoot, "shared-mailbox");
    installOnce(first, { completesRoot: shared });
    // Same receipts directory for a different workspace: issue-42/claude/complete
    // would be one file for two products, and the last writer would win.
    expect(() => installOnce(second, { completesRoot: shared })).toThrow(/already holds receipts for/);
  });

  it("uninstall clears the mailbox key so a stale grant cannot survive", () => {
    const fixture = product();
    const installed = installOnce(fixture, { agents: ["claude"] });
    uninstallOnce(fixture);
    expect(tryGit(installed.clones[0] as string, "config", "--local", "--get", "coord.completesRoot").exitCode).not.toBe(
      0
    );
  });
});

/**
 * The shim is what stops an agent re-deriving checkout state coordination
 * already owns. Asserting the rendered text is not enough: what matters is the
 * exit code real git invocations get, so these run the generated file.
 */
describe("generated git shim", () => {
  const runGit = (
    clone: string,
    cwd: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv = {}
  ): { status: number; stderr: string } => {
    const result = execFileSync("/bin/bash", ["-c", 'PATH="$1:$PATH"; shift; git "$@"; echo "exit=$?"', "_",
      join(clone, ".coord", "bin"), ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, COORD_ISSUE: "42", ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const match = /exit=(\d+)\s*$/.exec(result);
    return { status: Number(match?.[1] ?? -1), stderr: "" };
  };

  it("installs an untracked shim the launcher puts on PATH", () => {
    const fixture = product();
    const result = installOnce(fixture, { agents: ["claude"] });
    const clone = result.clones[0] as string;
    const shim = join(clone, ".coord", "bin", "git");

    expect(existsSync(shim)).toBe(true);
    const body = readFileSync(shim, "utf8");
    const realGit = /^REAL_GIT="(.+)"$/m.exec(body)?.[1] as string;
    expect(isAbsolute(realGit)).toBe(true);
    // Resolved from a PATH without .coord/bin, or the shim would invoke itself.
    expect(realGit).not.toContain("/.coord/bin/");
    expect(/^COORD_CLONE="(.+)"$/m.exec(body)?.[1]).toBeDefined();

    // Untracked and excluded, so the clone stays clean.
    expect(readFileSync(join(clone, ".git", "info", "exclude"), "utf8")).toContain(".coord/");
    expect(git(clone, "status", "--porcelain")).toBe("");

    const launcher = readFileSync(join(clone, "start-claude.sh"), "utf8");
    expect(launcher).toContain('.coord/bin:$PATH');
    // The startup read is exactly what the shim now refuses.
    expect(launcher).not.toContain("git status -sb");
  });

  it("refuses the reads coordination owns and delegates everything else", () => {
    const fixture = product();
    const clone = installOnce(fixture, { agents: ["claude"] }).clones[0] as string;
    const head = git(clone, "rev-parse", "HEAD");
    const tracked = git(clone, "ls-tree", "--name-only", "HEAD").split("\n")[0] as string;

    for (const args of [["status"], ["status", "--porcelain"], ["diff"], ["--no-pager", "diff"], ["-C", ".", "status"]]) {
      expect(runGit(clone, clone, args).status, args.join(" ")).toBe(2);
    }
    // Open-ended reconnaissance is refused; the exact pinned peer read stays as
    // the documented fallback for a file the coordinator could not export.
    expect(runGit(clone, clone, ["show", "HEAD"]).status).toBe(2);
    expect(runGit(clone, clone, ["show", `${head}:${tracked}`]).status).toBe(0);

    // Publishing must never be blocked, and the installed hooks run under the
    // delegate guard, so a commit that triggers them still completes.
    for (const args of [["rev-parse", "HEAD"], ["log", "--oneline", "-1"], ["config", "--get", "consensus.agentId"]]) {
      expect(runGit(clone, clone, args).status, args.join(" ")).toBe(0);
    }
  });

  /**
   * The reason the shim resolves the target repository instead of refusing on
   * the subcommand alone. A product's own tooling shells out to git against
   * other repositories, and this repository's fast suite does exactly that; a
   * blanket block breaks `pnpm check:fast`, which is the check an agent has to
   * pass before it can commit anything.
   */
  it("stays out of the way of manual mode and of other repositories", () => {
    const fixture = product();
    const clone = installOnce(fixture, { agents: ["claude"] }).clones[0] as string;
    const elsewhere = fixture.productRoot;

    expect(runGit(clone, clone, ["status"], { COORD_ISSUE: "" }).status).toBe(0);
    expect(runGit(clone, clone, ["status"], { COORD_GIT_DELEGATE: "1" }).status).toBe(0);
    expect(runGit(clone, elsewhere, ["status", "--porcelain"]).status).toBe(0);
    expect(runGit(clone, clone, ["-C", elsewhere, "status", "--porcelain"]).status).toBe(0);
    expect(runGit(clone, elsewhere, ["--git-dir", join(elsewhere, ".git"), "status", "--porcelain"]).status).toBe(0);
  });

  /**
   * The pinned peer read is the fallback for a file the coordinator could not
   * export. Once the action lists the files, the same read is the expensive
   * route to bytes already on disk — the repetition this change exists to stop.
   */
  it("blocks the pinned peer read only once the action lists the files", () => {
    const fixture = product();
    const clone = installOnce(fixture, { agents: ["claude"] }).clones[0] as string;
    const head = git(clone, "rev-parse", "HEAD");
    const tracked = git(clone, "ls-tree", "--name-only", "HEAD").split("\n")[0] as string;
    const pinned = ["show", `${head}:${tracked}`];

    const configPath = git(clone, "config", "--local", "--get", "coord.workspaceConfig");
    const actionDir = join(dirname(configPath), "issue-42", "agents", "claude");
    mkdirSync(actionDir, { recursive: true });
    const action = join(actionDir, "action.md");

    // No action yet, and an action without the section: the fallback stands.
    expect(runGit(clone, clone, pinned).status).toBe(0);
    writeFileSync(action, "body\n\n## Repo context\n\n\"docs/repo-map.md\"\n");
    expect(runGit(clone, clone, pinned).status).toBe(0);

    // The coordinator exported the files; the expensive route closes.
    writeFileSync(action, "body\n\n## Bound input files\n\n- plan from codex: \"/tmp/x\"\n");
    expect(runGit(clone, clone, pinned).status).toBe(2);

    // But `<rev>:<path>` against this clone's own history is an ordinary file
    // read, not peer reconnaissance, and a product's tooling makes it — this
    // repository's own language test reads HEAD:AGENTS.md that way.
    expect(runGit(clone, clone, ["show", `HEAD:${tracked}`]).status).toBe(0);

    // A partial export keeps the fallback open for what is missing.
    writeFileSync(
      action,
      "body\n\n## Bound input files\n\nNot every bound input could be exported; `git show <sha>:<path>` remains available for the rest.\n\n- plan from codex: \"/tmp/x\"\n"
    );
    expect(runGit(clone, clone, pinned).status).toBe(0);

    // Manual mode and the delegate guard are unaffected either way.
    expect(runGit(clone, clone, pinned, { COORD_ISSUE: "" }).status).toBe(0);
    expect(runGit(clone, clone, pinned, { COORD_GIT_DELEGATE: "1" }).status).toBe(0);
  });

  /**
   * Unlike the launcher, which may carry owner customisation, the shim is
   * coordinator-owned policy: a clone left holding an older copy keeps
   * enforcing rules this install has already withdrawn.
   */
  it("replaces its own stale copy but never a file it did not write", () => {
    const fixture = product();
    const clone = installOnce(fixture, { agents: ["claude"] }).clones[0] as string;
    const shim = join(clone, ".coord", "bin", "git");
    const canonical = readFileSync(shim, "utf8");

    writeFileSync(shim, canonical.replace("# coord-managed-git-wrapper", "# coord-managed-git-wrapper\n# stale"));
    installOnce(fixture, { agents: ["claude"] });
    expect(readFileSync(shim, "utf8")).toBe(canonical);

    writeFileSync(shim, "#!/bin/sh\necho someone else wrote this\n");
    installOnce(fixture, { agents: ["claude"] });
    expect(readFileSync(shim, "utf8")).toContain("someone else wrote this");
  });
});

describe("generated agent launchers", () => {
  /**
   * `--mode accept-edits` is an execution mode, not a permission grant, so on
   * its own it left every out-of-whitelist tool call waiting on an owner
   * prompt — time analytics attributes to agent wait rather than to work. Both
   * flags are needed, and asserting the generated content is what stops the
   * grant being dropped again by a later launcher edit.
   */
  it("launches Antigravity unattended without losing its execution mode", () => {
    const fixture = product();
    const result = installOnce(fixture, { agents: ["antigravity"] });
    const clone = result.clones[0] as string;
    const launcher = readFileSync(join(clone, "start-antigravity.sh"), "utf8");
    expect(launcher).toContain("exec agy --mode accept-edits --dangerously-skip-permissions");
    expect(launcher).toContain('export PATH="$HOME/.local/bin:$PATH"');
  });
});
