import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliRunLoop } from "../src/cli.js";
import { doctorWorkspace } from "../src/doctor.js";
import { issueRuntimePaths } from "../src/paths.js";
import { installWorkspace } from "../src/setupWorkspace.js";
import { readConfig, readCursorsState, readStartState } from "../src/state.js";
import { uninstallWorkspace } from "../src/uninstall.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (root: string, args: readonly string[], input?: string): string =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input }).trim();

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "coord-install-"));
  roots.push(root);
  const product = join(root, "go-service");
  const remote = join(root, "origin.git");
  const coordRoot = join(root, "runtime");
  mkdirSync(product);
  execFileSync("git", ["init", "--initial-branch=main", product], { stdio: "ignore" });
  git(product, ["config", "user.name", "Fixture"]);
  git(product, ["config", "user.email", "fixture@example.com"]);
  writeFileSync(join(product, "go.mod"), "module example.test/service\n\ngo 1.24\n");
  writeFileSync(join(product, "main.go"), "package main\nfunc main() {}\n");
  git(product, ["add", "."]);
  git(product, ["commit", "-m", "initial"]);
  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
  git(product, ["remote", "add", "origin", remote]);
  git(product, ["push", "-u", "origin", "main"]);
  return { root, product, remote, coordRoot };
};

const install = (input: ReturnType<typeof fixture>, extra: Partial<Parameters<typeof installWorkspace>[0]> = {}) =>
  installWorkspace({
    product: input.product,
    coordRoot: input.coordRoot,
    agents: ["codex"],
    profile: "solo",
    installRoot: resolve("."),
    ...extra
  });

describe("coord install", () => {
  it("onboards a non-Node product with zero product-tree footprint and is idempotent", () => {
    const value = fixture();
    const before = git(value.product, ["status", "--porcelain"]);
    const first = install(value);
    expect(first.changed).toBe(true);
    expect(git(value.product, ["status", "--porcelain"])).toBe(before);

    const clone = first.cloneRoots[0] as string;
    expect(readFileSync(join(clone, ".git", "hooks", "pre-commit"), "utf8")).toContain("coord-managed-hook-v1");
    expect(git(clone, ["config", "--local", "--get", "consensus.agentId"])).toBe("codex");
    expect(readConfig(first.configPath).verify).toEqual({ precommit: [], prepush: [] });
    expect(doctorWorkspace({ product: value.product, coordRoot: value.coordRoot })).toMatchObject({ ok: true });

    const second = install(value);
    expect(second.changed).toBe(false);
    expect(readFileSync(first.configPath, "utf8")).toBe(readFileSync(second.configPath, "utf8"));
  });

  it("leaves a fresh human clone entirely unaffected", () => {
    const value = fixture();
    install(value);
    const human = join(value.root, "human");
    execFileSync("git", ["clone", value.remote, human], { stdio: "ignore" });
    git(human, ["config", "user.name", "Human"]);
    git(human, ["config", "user.email", "human@example.com"]);
    expect(existsSync(join(human, ".git", "hooks", "pre-commit"))).toBe(false);
    writeFileSync(join(human, "human.txt"), "ordinary developer\n");
    git(human, ["add", "human.txt"]);
    expect(() => git(human, ["commit", "-m", "ordinary human commit"])).not.toThrow();
  });

  it("dry-runs without creating clones, runtime, or product changes", () => {
    const value = fixture();
    const result = install(value, { dryRun: true });
    expect(result.changed).toBe(false);
    expect(existsSync(value.coordRoot)).toBe(false);
    expect(existsSync(join(value.root, "go-service-codex"))).toBe(false);
    expect(git(value.product, ["status", "--porcelain"])).toBe("");
    expect(result.actions.some((action) => action.startsWith("clone "))).toBe(true);
  });

  it("fails install before cloning when a declared argv executable is unavailable", () => {
    const value = fixture();
    const policy = join(value.root, "policy.json");
    writeFileSync(policy, JSON.stringify({
      project: "fixture",
      origin: value.remote,
      agents: [{ id: "codex", root: "unused", launcher: "start-codex.sh", delivery: "pull" }],
      branch: "issue-{issue}/{agent}",
      baseBranch: "main",
      maxRevisionRounds: 3,
      prPolicy: "owner-only",
      digestPaths: [],
      verify: {
        precommit: [{ name: "missing", argv: ["definitely-not-a-coordination-command"] }],
        prepush: []
      },
      workflowCriticalPrefixes: [],
      workflowCriticalFiles: [],
      checks: [],
      pollIntervalMs: 1000
    }));
    expect(() => install(value, { configSource: policy })).toThrow(/not executable on PATH/);
    expect(existsSync(join(value.root, "go-service-codex"))).toBe(false);
  });

  it("runs declared argv for agent verification, blocks missing declarations, and permits explicit empty arrays", () => {
    const value = fixture();
    const result = install(value);
    const clone = result.cloneRoots[0] as string;
    git(clone, ["config", "user.name", "Codex"]);
    git(clone, ["config", "user.email", "codex@example.com"]);
    git(clone, ["checkout", "-b", "issue-4/codex"]);
    writeFileSync(join(clone, "main.go"), "package main\nfunc main() { panic(\"test\") }\n");
    git(clone, ["add", "main.go"]);

    const config = JSON.parse(readFileSync(result.configPath, "utf8")) as Record<string, unknown>;
    config.verify = {
      precommit: [{ name: "fixture failure", argv: [process.execPath, "-e", "process.exit(7)"] }],
      prepush: []
    };
    writeFileSync(result.configPath, `${JSON.stringify(config, null, 2)}\n`);
    const failing = spawnSync(join(clone, ".git", "hooks", "pre-commit"), { cwd: clone, encoding: "utf8" });
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain("fixture failure");

    delete config.verify;
    writeFileSync(result.configPath, `${JSON.stringify(config, null, 2)}\n`);
    const missing = spawnSync(join(clone, ".git", "hooks", "pre-commit"), { cwd: clone, encoding: "utf8" });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("no verify declaration");

    config.verify = { precommit: [], prepush: [] };
    writeFileSync(result.configPath, `${JSON.stringify(config, null, 2)}\n`);
    const empty = spawnSync(join(clone, ".git", "hooks", "pre-commit"), { cwd: clone, encoding: "utf8" });
    expect(empty.status).toBe(0);
  });

  it("fails closed when agent install wiring disappears and doctor reports command drift", () => {
    const value = fixture();
    const result = install(value);
    const clone = result.cloneRoots[0] as string;
    git(clone, ["config", "--local", "--unset-all", "coord.installRoot"]);
    const commit = spawnSync(join(clone, ".git", "hooks", "pre-commit"), { cwd: clone, encoding: "utf8" });
    expect(commit.status).toBe(1);
    expect(commit.stderr).toContain("coord.installRoot");
    const push = spawnSync(join(clone, ".git", "hooks", "pre-push"), ["origin", value.remote], {
      cwd: clone,
      encoding: "utf8",
      input: ""
    });
    expect(push.status).toBe(1);
    expect(push.stderr).toContain("coord.installRoot");

    git(clone, ["config", "--local", "coord.installRoot", resolve(".")]);
    const config = JSON.parse(readFileSync(result.configPath, "utf8")) as Record<string, unknown>;
    config.verify = { precommit: [{ name: "missing", argv: ["definitely-not-a-coordination-command"] }], prepush: [] };
    writeFileSync(result.configPath, `${JSON.stringify(config, null, 2)}\n`);
    expect(doctorWorkspace({ product: value.product, coordRoot: value.coordRoot }).issues).toContainEqual(
      expect.objectContaining({ code: "MISSING_COMMAND" })
    );
  });

  it("uninstalls conservatively without deleting agent clones", () => {
    const value = fixture();
    const result = install(value);
    const clone = result.cloneRoots[0] as string;
    const removed = uninstallWorkspace({ product: value.product, coordRoot: value.coordRoot });
    expect(removed.changed).toBe(true);
    expect(existsSync(clone)).toBe(true);
    expect(existsSync(result.configPath)).toBe(false);
    expect(existsSync(join(clone, ".git", "hooks", "pre-commit"))).toBe(false);
    expect(existsSync(join(clone, "start-codex.sh"))).toBe(false);
    expect(git(value.product, ["status", "--porcelain"])).toBe("");
  });

  it("chains and restores an existing agent-clone hook instead of clobbering it", () => {
    const value = fixture();
    const clone = join(value.root, "go-service-codex");
    execFileSync("git", ["clone", value.remote, clone], { stdio: "ignore" });
    const original = "#!/bin/sh\necho product-hook\n";
    writeFileSync(join(clone, ".git", "hooks", "pre-commit"), original, { mode: 0o755 });
    const result = install(value);
    expect(readFileSync(join(clone, ".git", "hooks", "pre-commit.coord-original"), "utf8")).toBe(original);
    expect(readFileSync(join(clone, ".git", "hooks", "pre-commit"), "utf8")).toContain("coord-managed-hook-v1");
    uninstallWorkspace({ product: value.product, coordRoot: value.coordRoot, configPath: result.configPath });
    expect(readFileSync(join(clone, ".git", "hooks", "pre-commit"), "utf8")).toBe(original);
    expect(existsSync(join(clone, ".git", "hooks", "pre-commit.coord-original"))).toBe(false);
  });

  it("supports single-authority vendor mode and reports copied-body drift", () => {
    const value = fixture();
    const result = install(value, { vendor: true });
    const clone = result.cloneRoots[0] as string;
    git(clone, ["checkout", "-b", "issue-4/codex"]);
    git(clone, ["config", "--local", "--unset-all", "coord.installRoot"]);
    const offline = spawnSync(join(clone, ".git", "hooks", "pre-commit"), { cwd: clone, encoding: "utf8" });
    expect(offline.status).toBe(0);
    expect(doctorWorkspace({ product: value.product, coordRoot: value.coordRoot }).issues).not.toContainEqual(
      expect.objectContaining({ code: "MISSING_INSTALL_ROOT", agent: "codex" })
    );
    writeFileSync(join(clone, ".git", "hooks", ".coord-vendor", "githooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
    expect(doctorWorkspace({ product: value.product, coordRoot: value.coordRoot }).issues).toContainEqual(
      expect.objectContaining({ code: "STALE_VENDOR", agent: "codex" })
    );
  });

  it("keeps opt-in product writes additive and never replaces an existing AGENTS.md", () => {
    const value = fixture();
    writeFileSync(join(value.product, "AGENTS.md"), "# Product-owned instructions\n");
    writeFileSync(join(value.product, ".gitignore"), "product-cache/\n");
    const result = install(value, { writeProduct: true, vendor: true });
    expect(readFileSync(join(value.product, "AGENTS.md"), "utf8")).toBe("# Product-owned instructions\n");
    expect(readFileSync(join(value.product, ".gitignore"), "utf8")).toContain("product-cache/");
    expect(readFileSync(join(value.product, ".gitignore"), "utf8")).toContain("# BEGIN coord managed");
    expect(existsSync(join(value.product, "githooks", "pre-commit"))).toBe(true);
    uninstallWorkspace({ product: value.product, coordRoot: value.coordRoot, configPath: result.configPath });
    expect(readFileSync(join(value.product, ".gitignore"), "utf8")).toBe("product-cache/\n");
    expect(readFileSync(join(value.product, "AGENTS.md"), "utf8")).toBe("# Product-owned instructions\n");
  });

  it("keeps the runtime config outside both product and agent clones", () => {
    const value = fixture();
    const result = install(value);
    expect(dirname(result.configPath)).toBe(join(value.coordRoot, "workspaces"));
    expect(result.configPath.startsWith(value.product)).toBe(false);
    expect(result.cloneRoots.some((root) => result.configPath.startsWith(root))).toBe(false);
  });

  it("emits a workspace config that coord start accepts unchanged", async () => {
    const value = fixture();
    const result = install(value);
    const fakeLoop = (paths: ReturnType<typeof issueRuntimePaths>): CliRunLoop => ({
      initializeEffects: async () => undefined,
      runTick: async () => readCursorsState(paths),
      run: async () => undefined
    });
    const exitCode = await runCli(
      ["start", "9", "--profile", "solo", "--config", result.configPath, "--coord-root", value.coordRoot],
      {
        io: { cwd: value.root },
        processRunner: async (argv) => argv.includes("ls-remote")
          ? { exitCode: 0, stdout: `${"a".repeat(40)}\trefs/heads/main\n`, stderr: "" }
          : { exitCode: 0, stdout: `${"b".repeat(40)}\n`, stderr: "" },
        startEffects: async () => ({ cleanup: async () => undefined }),
        makeRunLoop: fakeLoop
      }
    );
    expect(exitCode).toBe(0);
    expect(readStartState(issueRuntimePaths(value.coordRoot, 9))).toMatchObject({
      configPath: result.configPath,
      checks: []
    });
  });
});
