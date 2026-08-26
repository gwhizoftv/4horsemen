import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { wipeIssue } from "../src/wipeIssue.js";
import { coordinatorConfigSchema } from "../src/state.js";
import { git, tryGit } from "./support/workspaceFixture.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const stamp = (workspace: string, product: string) => ({
  installRoot: workspace,
  cliEntry: join(workspace, "coord"),
  version: "0.0.0",
  commit: "a".repeat(40),
  canonicalDigest: "b".repeat(64),
  installedAt: "2026-08-12T00:00:00.000Z",
  productRoot: product,
  cloneRoot: workspace,
  vendored: false,
  bootstrapped: false,
  ownsInstallRoot: false,
  wroteProductIgnore: false,
  wroteAgentsMd: false
});

const initClone = (path: string, origin: string): void => {
  mkdirSync(path, { recursive: true });
  git(path, "clone", "-q", origin, path);
  git(path, "config", "user.name", "Fixture");
  git(path, "config", "user.email", "fixture@example.com");
};

describe("wipeIssue", () => {
  it("deletes origin and local issue-N refs including tracking and -final, then wipe cannot resume", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "coord-wipe-"));
    roots.push(workspace);
    const origin = join(workspace, "origin.git");
    const product = join(workspace, "app");
    const claude = join(workspace, "app-claude");
    const codex = join(workspace, "app-codex");
    const coordRoot = join(workspace, "coord-runtime");
    const mirror = join(coordRoot, "mirror.git");
    mkdirSync(coordRoot, { recursive: true });

    mkdirSync(product, { recursive: true });
    git(product, "init", "-q", "--initial-branch=main");
    git(product, "config", "user.name", "Fixture");
    git(product, "config", "user.email", "fixture@example.com");
    writeFileSync(join(product, "README.md"), "# app\n");
    git(product, "add", "README.md");
    git(product, "commit", "-qm", "init");
    git(product, "clone", "--bare", "-q", product, origin);
    git(product, "remote", "add", "origin", origin);
    git(product, "push", "-q", "-u", "origin", "main");

    initClone(claude, origin);
    initClone(codex, origin);
    for (const clone of [claude, codex]) {
      const agent = clone.endsWith("claude") ? "claude" : "codex";
      const branch = `issue-9/${agent}`;
      git(clone, "checkout", "-qb", branch);
      writeFileSync(join(clone, "signal.txt"), `${agent}\n`);
      git(clone, "add", "signal.txt");
      git(clone, "commit", "-qm", `${agent}: signal`);
      git(clone, "push", "-q", "-u", "origin", branch);
    }
    git(claude, "push", "-q", origin, "issue-9/claude:refs/heads/issue-9/claude-final");
    git(product, "fetch", "-q", "origin");
    git(product, "branch", "issue-9/claude", "origin/issue-9/claude");
    git(claude, "fetch", "-q", "origin");
    git(codex, "fetch", "-q", "origin");
    git(coordRoot, "clone", "--bare", "-q", origin, mirror);
    git(mirror, "fetch", "-q", "origin", "+refs/heads/issue-9/*:refs/remotes/origin/issue-9/*");

    const configPath = join(coordRoot, "config.json");
    const config = coordinatorConfigSchema.parse({
      project: "app",
      origin,
      agents: [
        { id: "claude", root: claude, launcher: "start-claude.sh", delivery: "both" },
        { id: "codex", root: codex, launcher: "start-codex.sh", delivery: "both" }
      ],
      branch: "issue-{issue}/{agent}",
      baseBranch: "main",
      profile: "consensus",
      maxRevisionRounds: 3,
      prPolicy: "owner-only",
      digestPaths: [],
      pollIntervalMs: 1000,
      checks: [{ name: "true", argv: ["true"] }],
      coordination: stamp(workspace, product)
    });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    mkdirSync(join(coordRoot, "issue-9", "agents"), { recursive: true });
    // A receipt left in the mailbox outlives the runtime it belongs to: the
    // next run that reuses issue 9 would read it as that agent's completion.
    const completesRoot = join(workspace, "completes");
    const claudeDrop = join(completesRoot, "issue-9", "claude");
    const keptDrop = join(completesRoot, "issue-10", "claude");
    mkdirSync(claudeDrop, { recursive: true });
    mkdirSync(keptDrop, { recursive: true });
    writeFileSync(join(claudeDrop, "complete"), `${"a".repeat(40)}\n`);
    writeFileSync(join(keptDrop, "complete"), `${"b".repeat(40)}\n`);

    const outcome = await wipeIssue({
      issue: 9,
      config,
      configPath,
      coordRoot,
      completesRoot,
      terminalCloser: null,
      log: () => undefined
    });

    expect(outcome.resetClones).toEqual([claude, codex]);
    expect(outcome.deletedRemoteBranches.sort()).toEqual([
      "issue-9/claude",
      "issue-9/claude-final",
      "issue-9/codex"
    ]);
    expect(outcome.wipedRuntime).toBe(join(coordRoot, "issue-9"));
    expect(existsSync(join(coordRoot, "issue-9"))).toBe(false);
    expect(outcome.wipedCompletes).toBe(join(completesRoot, "issue-9"));
    expect(existsSync(join(completesRoot, "issue-9"))).toBe(false);
    // Only this issue: another issue's receipts are not this wipe's business.
    expect(existsSync(join(keptDrop, "complete"))).toBe(true);
    expect(git(claude, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(codex, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(tryGit(claude, "show-ref", "--verify", "--quiet", "refs/heads/issue-9/claude").exitCode).not.toBe(0);
    expect(tryGit(claude, "show-ref", "--verify", "--quiet", "refs/remotes/origin/issue-9/claude").exitCode).not.toBe(
      0
    );
    expect(tryGit(claude, "show-ref", "--verify", "--quiet", "refs/remotes/origin/issue-9/claude-final").exitCode).not.toBe(
      0
    );
    expect(tryGit(product, "show-ref", "--verify", "--quiet", "refs/heads/issue-9/claude").exitCode).not.toBe(0);
    expect(tryGit(product, "show-ref", "--verify", "--quiet", "refs/remotes/origin/issue-9/claude").exitCode).not.toBe(
      0
    );
    expect(tryGit(mirror, "show-ref", "--verify", "--quiet", "refs/heads/issue-9/claude").exitCode).not.toBe(0);
    expect(tryGit(mirror, "show-ref", "--verify", "--quiet", "refs/remotes/origin/issue-9/claude").exitCode).not.toBe(0);
    expect(tryGit(product, "ls-remote", "--exit-code", "--heads", "origin", "issue-9/claude").exitCode).not.toBe(0);
    expect(tryGit(product, "ls-remote", "--exit-code", "--heads", "origin", "issue-9/claude-final").exitCode).not.toBe(
      0
    );
    expect(tryGit(product, "ls-remote", "--exit-code", "--heads", "origin", "issue-9/codex").exitCode).not.toBe(0);
    expect(tryGit(claude, "checkout", "issue-9/claude").exitCode).not.toBe(0);
  });

  it("deletes the reserved coordinator-evidence branch on wipe-issue", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "coord-wipe-evidence-"));
    roots.push(workspace);
    const origin = join(workspace, "origin.git");
    const product = join(workspace, "app");
    const claude = join(workspace, "app-claude");
    const coordRoot = join(workspace, "coord-runtime");
    mkdirSync(coordRoot, { recursive: true });

    mkdirSync(product, { recursive: true });
    git(product, "init", "-q", "--initial-branch=main");
    git(product, "config", "user.name", "Fixture");
    git(product, "config", "user.email", "fixture@example.com");
    writeFileSync(join(product, "README.md"), "# app\n");
    git(product, "add", "README.md");
    git(product, "commit", "-qm", "init");
    git(product, "clone", "--bare", "-q", product, origin);
    git(product, "remote", "add", "origin", origin);
    git(product, "push", "-q", "-u", "origin", "main");

    initClone(claude, origin);
    git(claude, "checkout", "-qb", "issue-11/claude");
    writeFileSync(join(claude, "signal.txt"), "claude\n");
    git(claude, "add", "signal.txt");
    git(claude, "commit", "-qm", "claude: signal");
    git(claude, "push", "-q", "-u", "origin", "issue-11/claude");
    git(claude, "push", "-q", "origin", "HEAD:refs/heads/issue-11/coordinator-evidence");
    git(claude, "push", "-q", "origin", "HEAD:refs/heads/issue-11/owner-scratch");

    const configPath = join(coordRoot, "config.json");
    const config = coordinatorConfigSchema.parse({
      project: "app",
      origin,
      agents: [{ id: "claude", root: claude, launcher: "start-claude.sh", delivery: "both" }],
      branch: "issue-{issue}/{agent}",
      baseBranch: "main",
      profile: "solo",
      maxRevisionRounds: 3,
      prPolicy: "owner-only",
      digestPaths: [],
      pollIntervalMs: 1000,
      checks: [{ name: "true", argv: ["true"] }],
      coordination: stamp(workspace, product)
    });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const outcome = await wipeIssue({
      issue: 11,
      config,
      configPath,
      coordRoot,
      terminalCloser: null,
      log: () => undefined
    });

    expect(outcome.deletedRemoteBranches.sort()).toEqual([
      "issue-11/claude",
      "issue-11/coordinator-evidence"
    ]);
    expect(outcome.deletedRemoteBranches).not.toContain("issue-11/owner-scratch");
    expect(tryGit(product, "ls-remote", "--exit-code", "--heads", "origin", "issue-11/coordinator-evidence").exitCode).not.toBe(
      0
    );
    expect(tryGit(product, "ls-remote", "--exit-code", "--heads", "origin", "issue-11/owner-scratch").exitCode).toBe(0);
  });

  it("keeps product-local issue branches that have owner commits or uncommitted work", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "coord-wipe-owner-"));
    roots.push(workspace);
    const origin = join(workspace, "origin.git");
    const product = join(workspace, "app");
    const claude = join(workspace, "app-claude");
    const codex = join(workspace, "app-codex");
    const coordRoot = join(workspace, "coord-runtime");
    mkdirSync(coordRoot, { recursive: true });

    mkdirSync(product, { recursive: true });
    git(product, "init", "-q", "--initial-branch=main");
    git(product, "config", "user.name", "Fixture");
    git(product, "config", "user.email", "fixture@example.com");
    writeFileSync(join(product, "README.md"), "# app\n");
    git(product, "add", "README.md");
    git(product, "commit", "-qm", "init");
    git(product, "clone", "--bare", "-q", product, origin);
    git(product, "remote", "add", "origin", origin);
    git(product, "push", "-q", "-u", "origin", "main");

    initClone(claude, origin);
    initClone(codex, origin);
    for (const clone of [claude, codex]) {
      const agent = clone.endsWith("claude") ? "claude" : "codex";
      const branch = `issue-9/${agent}`;
      git(clone, "checkout", "-qb", branch);
      writeFileSync(join(clone, "signal.txt"), `${agent}\n`);
      git(clone, "add", "signal.txt");
      git(clone, "commit", "-qm", `${agent}: signal`);
      git(clone, "push", "-q", "-u", "origin", branch);
    }
    git(product, "fetch", "-q", "origin");
    git(product, "checkout", "-qb", "issue-9/claude", "origin/issue-9/claude");
    writeFileSync(join(product, "owner.md"), "owner commit\n");
    git(product, "add", "owner.md");
    git(product, "commit", "-qm", "owner work on claude branch");
    git(product, "checkout", "-qb", "issue-9/codex", "origin/issue-9/codex");
    writeFileSync(join(product, "scratch.txt"), "uncommitted\n");

    const configPath = join(coordRoot, "config.json");
    const config = coordinatorConfigSchema.parse({
      project: "app",
      origin,
      agents: [
        { id: "claude", root: claude, launcher: "start-claude.sh", delivery: "both" },
        { id: "codex", root: codex, launcher: "start-codex.sh", delivery: "both" }
      ],
      branch: "issue-{issue}/{agent}",
      baseBranch: "main",
      profile: "consensus",
      maxRevisionRounds: 3,
      prPolicy: "owner-only",
      digestPaths: [],
      pollIntervalMs: 1000,
      checks: [{ name: "true", argv: ["true"] }],
      coordination: stamp(workspace, product)
    });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const outcome = await wipeIssue({
      issue: 9,
      config,
      configPath,
      coordRoot,
      terminalCloser: null,
      log: () => undefined
    });

    expect(outcome.keptProductBranches.sort()).toEqual(["issue-9/claude", "issue-9/codex"]);
    expect(git(product, "rev-parse", "--abbrev-ref", "HEAD")).toBe("issue-9/codex");
    expect(existsSync(join(product, "scratch.txt"))).toBe(true);
    expect(tryGit(product, "show-ref", "--verify", "--quiet", "refs/heads/issue-9/claude").exitCode).toBe(0);
    expect(tryGit(product, "show-ref", "--verify", "--quiet", "refs/heads/issue-9/codex").exitCode).toBe(0);
    expect(git(product, "log", "-1", "--format=%s", "issue-9/claude")).toBe("owner work on claude branch");
    expect(tryGit(product, "show-ref", "--verify", "--quiet", "refs/remotes/origin/issue-9/claude").exitCode).not.toBe(
      0
    );
    expect(tryGit(product, "show-ref", "--verify", "--quiet", "refs/remotes/origin/issue-9/codex").exitCode).not.toBe(0);
    expect(tryGit(product, "ls-remote", "--exit-code", "--heads", "origin", "issue-9/claude").exitCode).not.toBe(0);
    expect(tryGit(product, "ls-remote", "--exit-code", "--heads", "origin", "issue-9/codex").exitCode).not.toBe(0);
    expect(git(claude, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("keeps origin when the product pushed commits the clone does not have", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "coord-wipe-ahead-"));
    roots.push(workspace);
    const origin = join(workspace, "origin.git");
    const product = join(workspace, "app");
    const claude = join(workspace, "app-claude");
    const coordRoot = join(workspace, "runtime");
    mkdirSync(coordRoot, { recursive: true });
    mkdirSync(product, { recursive: true });
    git(product, "init", "-q", "--initial-branch=main");
    git(product, "config", "user.name", "Fixture");
    git(product, "config", "user.email", "fixture@example.com");
    writeFileSync(join(product, "README.md"), "# app\n");
    git(product, "add", "README.md");
    git(product, "commit", "-qm", "init");
    git(product, "clone", "--bare", "-q", product, origin);
    git(product, "remote", "add", "origin", origin);
    git(product, "push", "-q", "-u", "origin", "main");
    initClone(claude, origin);
    git(claude, "checkout", "-qb", "issue-4/claude");
    writeFileSync(join(claude, "signal.txt"), "claude\n");
    git(claude, "add", "signal.txt");
    git(claude, "commit", "-qm", "claude: signal");
    git(claude, "push", "-q", "-u", "origin", "issue-4/claude");
    git(product, "fetch", "-q", "origin");
    git(product, "checkout", "-qb", "issue-4/claude", "origin/issue-4/claude");
    writeFileSync(join(product, "owner.md"), "pushed owner work\n");
    git(product, "add", "owner.md");
    git(product, "commit", "-qm", "owner pushed ahead of clone");
    git(product, "push", "-q", "origin", "issue-4/claude");

    const configPath = join(coordRoot, "config.json");
    const config = coordinatorConfigSchema.parse({
      project: "app",
      origin,
      agents: [{ id: "claude", root: claude, launcher: "start-claude.sh", delivery: "both" }],
      branch: "issue-{issue}/{agent}",
      baseBranch: "main",
      profile: "solo",
      maxRevisionRounds: 3,
      prPolicy: "owner-only",
      digestPaths: [],
      pollIntervalMs: 1000,
      checks: [{ name: "true", argv: ["true"] }],
      coordination: stamp(workspace, product)
    });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const outcome = await wipeIssue({
      issue: 4,
      config,
      configPath,
      coordRoot,
      terminalCloser: null,
      log: () => undefined
    });

    expect(outcome.keptProductBranches).toEqual(["issue-4/claude"]);
    expect(outcome.deletedRemoteBranches).not.toContain("issue-4/claude");
    expect(tryGit(product, "ls-remote", "--exit-code", "--heads", "origin", "issue-4/claude").exitCode).toBe(0);
    expect(tryGit(product, "show-ref", "--verify", "--quiet", "refs/heads/issue-4/claude").exitCode).toBe(0);
    expect(tryGit(product, "show-ref", "--verify", "--quiet", "refs/remotes/origin/issue-4/claude").exitCode).toBe(0);
    expect(git(product, "rev-parse", "--abbrev-ref", "HEAD")).toBe("issue-4/claude");
  });

  it("lifts skip-worktree AGENTS.md so wipe can check the clone out on main", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "coord-wipe-skip-"));
    roots.push(workspace);
    const origin = join(workspace, "origin.git");
    const product = join(workspace, "app");
    const claude = join(workspace, "app-claude");
    const coordRoot = join(workspace, "runtime");
    mkdirSync(coordRoot, { recursive: true });
    mkdirSync(product, { recursive: true });
    git(product, "init", "-q", "--initial-branch=main");
    git(product, "config", "user.name", "Fixture");
    git(product, "config", "user.email", "fixture@example.com");
    writeFileSync(join(product, "README.md"), "# app\n");
    writeFileSync(join(product, "AGENTS.md"), "# product\n");
    git(product, "add", "README.md", "AGENTS.md");
    git(product, "commit", "-qm", "init");
    git(product, "clone", "--bare", "-q", product, origin);
    git(product, "remote", "add", "origin", origin);
    git(product, "push", "-q", "-u", "origin", "main");
    initClone(claude, origin);
    git(claude, "checkout", "-qb", "issue-3/claude");
    git(claude, "push", "-q", "-u", "origin", "issue-3/claude");
    writeFileSync(join(claude, "AGENTS.md"), "# protocol overlay\n");
    git(claude, "update-index", "--skip-worktree", "--", "AGENTS.md");

    const configPath = join(coordRoot, "config.json");
    const config = coordinatorConfigSchema.parse({
      project: "app",
      origin,
      agents: [{ id: "claude", root: claude, launcher: "start-claude.sh", delivery: "both" }],
      branch: "issue-{issue}/{agent}",
      baseBranch: "main",
      profile: "solo",
      maxRevisionRounds: 3,
      prPolicy: "owner-only",
      digestPaths: [],
      pollIntervalMs: 1000,
      checks: [{ name: "true", argv: ["true"] }],
      coordination: stamp(workspace, product)
    });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    await wipeIssue({
      issue: 3,
      config,
      configPath,
      coordRoot,
      force: true,
      terminalCloser: null,
      log: () => undefined
    });

    expect(git(claude, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(tryGit(claude, "show-ref", "--verify", "--quiet", "refs/heads/issue-3/claude").exitCode).not.toBe(0);
    expect(tryGit(claude, "show-ref", "--verify", "--quiet", "refs/remotes/origin/issue-3/claude").exitCode).not.toBe(
      0
    );
  });

  it("refuses dirty clones without --force", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "coord-wipe-dirty-"));
    roots.push(workspace);
    const origin = join(workspace, "origin.git");
    const product = join(workspace, "app");
    const claude = join(workspace, "app-claude");
    const coordRoot = join(workspace, "runtime");
    mkdirSync(coordRoot, { recursive: true });
    mkdirSync(product, { recursive: true });
    git(product, "init", "-q", "--initial-branch=main");
    git(product, "config", "user.name", "Fixture");
    git(product, "config", "user.email", "fixture@example.com");
    writeFileSync(join(product, "README.md"), "# app\n");
    git(product, "add", "README.md");
    git(product, "commit", "-qm", "init");
    git(product, "clone", "--bare", "-q", product, origin);
    git(product, "remote", "add", "origin", origin);
    git(product, "push", "-q", "-u", "origin", "main");
    initClone(claude, origin);
    writeFileSync(join(claude, "dirty.txt"), "nope\n");

    const configPath = join(coordRoot, "config.json");
    const config = coordinatorConfigSchema.parse({
      project: "app",
      origin,
      agents: [{ id: "claude", root: claude, launcher: "start-claude.sh", delivery: "both" }],
      branch: "issue-{issue}/{agent}",
      baseBranch: "main",
      profile: "solo",
      maxRevisionRounds: 3,
      prPolicy: "owner-only",
      digestPaths: [],
      pollIntervalMs: 1000,
      checks: [{ name: "true", argv: ["true"] }],
      coordination: stamp(workspace, product)
    });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    await expect(
      wipeIssue({ issue: 3, config, configPath, coordRoot, terminalCloser: null, log: () => undefined })
    ).rejects.toThrow(/uncommitted changes/);
    expect(existsSync(join(claude, "dirty.txt"))).toBe(true);
  });
});
