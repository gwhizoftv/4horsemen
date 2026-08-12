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
  it("resets clones, deletes local and remote issue branches, and wipes runtime", () => {
    const workspace = mkdtempSync(join(tmpdir(), "coord-wipe-"));
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

    const outcome = wipeIssue({
      issue: 9,
      config,
      configPath,
      coordRoot,
      log: () => undefined
    });

    expect(outcome.resetClones).toEqual([claude, codex]);
    expect(outcome.deletedRemoteBranches.sort()).toEqual(["issue-9/claude", "issue-9/codex"]);
    expect(outcome.wipedRuntime).toBe(join(coordRoot, "issue-9"));
    expect(existsSync(join(coordRoot, "issue-9"))).toBe(false);
    expect(git(claude, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(codex, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(tryGit(claude, "show-ref", "--verify", "--quiet", "refs/heads/issue-9/claude").exitCode).not.toBe(0);
    expect(tryGit(product, "ls-remote", "--exit-code", "--heads", "origin", "issue-9/claude").exitCode).not.toBe(0);
    expect(tryGit(product, "ls-remote", "--exit-code", "--heads", "origin", "issue-9/codex").exitCode).not.toBe(0);
  });

  it("refuses dirty clones without --force", () => {
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

    expect(() =>
      wipeIssue({ issue: 3, config, configPath, coordRoot, log: () => undefined })
    ).toThrow(/Nothing has been changed/);
    expect(existsSync(join(claude, "dirty.txt"))).toBe(true);
  });
});
