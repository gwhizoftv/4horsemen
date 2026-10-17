import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliRunLoop } from "../src/cli.js";
import { localConfigGet } from "../src/gitExec.js";
import { install, onboard, uninstall } from "../src/install.js";
import { issueRuntimePaths } from "../src/paths.js";
import { agentCloneDirectory, resolveRealGit } from "../src/setupWorkspace.js";
import { readConfig, readCursorsState, readStartState } from "../src/state.js";
import { nestedConfigPath, OWNER_WORKSPACE_CONFIG_KEY } from "../src/workspace.js";
import {
  ensureBuilt,
  git,
  makeProduct,
  repoRoot,
  silence,
  writeDeclaration,
  type ProductFixture
} from "./support/workspaceFixture.js";

const products: ProductFixture[] = [];
afterEach(() => {
  for (const product of products.splice(0)) product.cleanup();
});

const product = (name = "myserver", files: Record<string, string> = {
  "package.json": `${JSON.stringify({ name: "fixture", scripts: { "check:fast": "true", check: "true" } }, null, 2)}\n`,
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n"
}): ProductFixture => {
  ensureBuilt();
  const fixture = makeProduct("plain", name);
  products.push(fixture);
  for (const [path, contents] of Object.entries(files)) writeFileSync(join(fixture.productRoot, path), contents);
  git(fixture.productRoot, "add", ...Object.keys(files));
  git(fixture.productRoot, "commit", "-qm", "add checks");
  git(fixture.productRoot, "push", "-q", "origin", "main");
  git(fixture.productRoot, "remote", "set-url", "origin", `https://github.com/acme/${name}.git`);
  return fixture;
};

const fakeLoop = (paths: ReturnType<typeof issueRuntimePaths>): CliRunLoop => ({
  initializeEffects: async () => undefined,
  runTick: async () => readCursorsState(paths),
  run: async () => undefined
});

const runner = async (argv: readonly string[]) => {
  if (argv[0] === "gh" && argv[1] === "api") {
    return { exitCode: 0, stdout: JSON.stringify({ default_branch: "main" }), stderr: "" };
  }
  if (argv[0] === "gh") {
    const issue = Number(argv[3]);
    const repository = argv[5] ?? "acme/myserver";
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        number: issue,
        title: `Issue ${issue}`,
        body: "Fixture body",
        url: `https://github.com/${repository}/issues/${issue}`
      }),
      stderr: ""
    };
  }
  if (argv.includes("ls-remote")) return { exitCode: 0, stdout: `${"a".repeat(40)}\trefs/heads/main\n`, stderr: "" };
  if (argv.includes("rev-parse")) return { exitCode: 0, stdout: `${"b".repeat(40)}\n`, stderr: "" };
  return { exitCode: 1, stdout: "", stderr: `unexpected command ${argv.join(" ")}` };
};

describe("coord onboard", () => {
  it("discovers and refreshes a remote-tracking default without moving working branches", async () => {
    const fixture = product();
    const tip = git(fixture.productRoot, "rev-parse", "HEAD");
    git(fixture.productRoot, "checkout", "-qb", "feature/work");
    git(fixture.productRoot, "branch", "-d", "main");
    git(fixture.productRoot, "update-ref", "refs/remotes/origin/release/alpha", tip);
    git(fixture.productRoot, "update-ref", "refs/remotes/origin/release/beta", tip);
    let branch = "release/alpha";
    const argv = ["onboard", fixture.productRoot, "--agents", "claude", "--profile", "solo"];
    const dependencies = { home: null, io: { stdout: () => undefined }, processRunner: async (command: readonly string[]) => {
      expect(command).toEqual(["gh", "api", "repos/acme/myserver"]);
      return { exitCode: 0, stdout: JSON.stringify({ default_branch: branch }), stderr: "" };
    } };
    expect(await runCli(argv, dependencies)).toBe(0);
    const clone = agentCloneDirectory(fixture.workspaceRoot, "myserver", "claude");
    const configPath = join(fixture.workspaceRoot, "coord-runtime", "config.json");
    expect(readConfig(configPath).baseBranch).toBe("release/alpha");
    expect(localConfigGet(clone, "consensus.sharedBranch")).toBe("release/alpha");
    expect(git(clone, "branch", "--show-current")).toBe("release/alpha");
    expect(git(clone, "rev-parse", "HEAD")).toBe(tip);
    expect(readFileSync(join(clone, "start-claude.sh"), "utf8")).toContain("shared: release/alpha");

    git(clone, "checkout", "-qb", "claude/work");
    writeFileSync(join(clone, "README.md"), "unfinished work\n");
    branch = "release/beta";
    expect(await runCli(argv, dependencies)).toBe(0);
    expect(readConfig(configPath).baseBranch).toBe("release/beta");
    expect(localConfigGet(clone, "consensus.sharedBranch")).toBe("release/beta");
    expect(readFileSync(join(clone, "start-claude.sh"), "utf8")).toContain("shared: release/beta");
    expect(git(clone, "branch", "--show-current")).toBe("claude/work");
    expect(git(clone, "rev-parse", "HEAD")).toBe(tip);
    expect(readFileSync(join(clone, "README.md"), "utf8")).toBe("unfinished work\n");
    expect(git(fixture.productRoot, "branch", "--show-current")).toBe("feature/work");
    expect(git(fixture.productRoot, "rev-parse", "HEAD")).toBe(tip);
    expect(git(fixture.productRoot, "status", "--porcelain")).toBe("");
  });

  it.each(["python", "flutter"])("onboards %s without declarations and reports the effective policy", async (language) => {
    const files: Record<string, string> = language === "python"
      ? { "pyproject.toml": "# pytest project\n" }
      : { "pubspec.yaml": 'dependencies: {flutter: {sdk: "flutter"}}\n' };
    const fixture = product(language, files);
    const coordRoot = join(fixture.workspaceRoot, "coord-runtime");
    const configPath = join(coordRoot, "config.json");
    const clone = agentCloneDirectory(fixture.workspaceRoot, language, "claude");
    const output: string[] = [];
    const log = (message: string) => output.push(message);
    const options = { installRoot: repoRoot, productRoot: fixture.productRoot, agents: ["claude"], profile: "solo", home: null, log };
    install({ ...options, coordRoot, writeProduct: false, vendor: false, bootstrap: false, dryRun: true });
    expect(output.join("")).toContain("Proposed verification policy:");
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(clone)).toBe(false);

    const bin = join(fixture.workspaceRoot, "bin");
    mkdirSync(bin);
    // Resolve the process-wide Git cache before introducing disposable PATH entries.
    symlinkSync(resolveRealGit(), join(bin, "git"));
    for (const command of ["cat", "chmod", "sh", "dirname", "mkdir"]) {
      symlinkSync(execFileSync("which", [command], { encoding: "utf8" }).trim(), join(bin, command));
    }
    symlinkSync(process.execPath, join(bin, "node"));
    symlinkSync("/bin/bash", join(bin, "bash"));
    const executable = language === "python" ? "pytest" : "flutter";
    const tool = join(bin, executable);
    // Initially non-executable: the fixture PATH contains no real product tools.
    writeFileSync(tool, '#!/bin/sh\n: > "$0.called"\nexit 0\n', { mode: 0o644 });
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = bin;
      const unavailable = onboard(options);
      expect(unavailable.doctor.findings).toContainEqual(expect.objectContaining({ class: "toolchain", subject: executable }));
      expect(unavailable.doctor.exitCode).not.toBe(0);
      expect(localConfigGet(fixture.productRoot, OWNER_WORKSPACE_CONFIG_KEY)).toBeNull();
      // Keep re-onboarding local: a working agent branch is never fetched or reset.
      git(clone, "checkout", "-qb", "claude/manual");
      chmodSync(tool, 0o755);
      output.length = 0;
      const argv = ["onboard", fixture.productRoot, "--agents", "claude", "--profile", "solo"];
      expect(await runCli(argv, { home: null, processRunner: runner, io: { stdout: log, stderr: log } })).toBe(0);
      const configured = readConfig(configPath);
      const checks = language === "python" ? [{ name: "test", argv: ["pytest", "-q"] }] : [
        { name: "analyze", argv: ["flutter", "analyze", "--no-fatal-infos"] }, { name: "test", argv: ["flutter", "test"] }
      ];
      expect(configured.toolchain).toBe(language);
      expect(configured.checks).toEqual(checks);
      expect(configured.verify?.precommit).toEqual([checks[0]]);
      expect(configured.verify?.prepush).toEqual(language === "python" ? [] : [checks[1]]);
      expect(localConfigGet(fixture.productRoot, OWNER_WORKSPACE_CONFIG_KEY)).toBe(realpathSync(configPath));
      const summary = output.join("");
      expect(summary).toContain(`toolchain (inferred): ${language}`);
      for (const check of checks) expect(summary).toContain(`${check.name} ${JSON.stringify(check.argv)}`);
      expect(summary).toContain("documentation-only (inferred)");
      expect(summary).toContain("product dependencies are not installed");
      expect(summary).toContain(language === "python" ? "no tests collected is a failure" : "informational diagnostics do not block");
      expect(existsSync(`${tool}.called`)).toBe(false);
      expect(git(fixture.productRoot, "status", "--porcelain")).toBe("");

      const declaration = writeDeclaration(fixture.workspaceRoot, {
        verify: { precommit: [], prepush: [] }, workflowCriticalPrefixes: ["custom/"], workflowCriticalFiles: []
      });
      output.length = 0;
      expect(await runCli([...argv, "--declare", declaration], { home: null, processRunner: runner, io: { stdout: log, stderr: log } })).toBe(0);
      expect(readConfig(configPath).verify).toEqual({ precommit: [], prepush: [] });
      expect(readConfig(configPath).checks).toEqual(checks);
      expect(output.join("")).toContain("local precommit (declared): none");
      expect(output.join("")).toContain('critical prefixes (declared): ["custom/"]');
      expect(output.join("")).not.toContain("local precommit (inferred)");

      if (language === "python") {
        // Coordinator-mode labels must keep local, coordinated, candidate and final commands distinct.
        const local = { name: "local", argv: ["node", "--version"] };
        const final = { name: "final", argv: ["node", "--help"] };
        writeDeclaration(fixture.workspaceRoot, { toolchain: "custom", verify: { precommit: [local], prepush: [] }, checks: [final],
          verification: { mode: "coordinator", coordinated: { precommit: [], prepush: [local] },
            candidate: { checks: [final], covers: { prefixes: ["src/"] }, rules: [] } } });
        output.length = 0;
        expect(await runCli([...argv, "--declare", declaration], { home: null, processRunner: runner, io: { stdout: log, stderr: log } })).toBe(0);
        expect(readConfig(configPath).checks).toEqual([final]);
        expect(output.join("")).toContain('local precommit (declared): local ["node","--version"]');
        expect(output.join("")).toContain("coordinated precommit (declared): none");
        expect(output.join("")).toContain('coordinated prepush (declared): local ["node","--version"]');
        expect(output.join("")).toContain('candidate checks (declared): final ["node","--help"]');
        expect(output.join("")).toContain('finalization (declared): final ["node","--help"]');
        expect(output.join("")).not.toContain("pytest must be on PATH");
      }
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it("applies the happy-path defaults without changing the tracked product tree", async () => {
    // Five default agents (incl. Muse) make this slower than the prior four-agent onboard.
    const fixture = product();
    const output: string[] = [];
    const aliasParent = join(fixture.workspaceRoot, "aliases");
    const productAlias = join(aliasParent, "myserver");
    // Outside the product parent: a home inside it is never trusted as one.
    const home = join(product("home-owner").workspaceRoot, "home");
    mkdirSync(aliasParent);
    symlinkSync(fixture.productRoot, productAlias, "dir");
    expect(
      await runCli(["onboard", productAlias], {
        home,
        processRunner: runner,
        io: { stdout: (message) => output.push(message), stderr: (message) => output.push(message) }
      })
    ).toBe(0);

    const coordRoot = join(dirname(fixture.productRoot), "coord-runtime");
    const configPath = join(coordRoot, "config.json");
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(join(aliasParent, "coord-runtime"))).toBe(false);
    expect(
      await runCli(["onboard", fixture.productRoot], {
        home,
        processRunner: runner,
        io: { stdout: (message) => output.push(message), stderr: (message) => output.push(message) }
      })
    ).toBe(0);
    expect(existsSync(join(coordRoot, "workspaces"))).toBe(false);
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      profile: string;
      digestPaths: string[];
      agents: Array<{ id: string; nudgeSubmit: string[] }>;
    };
    expect(config.agents.find((agent) => agent.id === "codex")?.nudgeSubmit).toEqual(["Enter"]);
    expect(config.profile).toBe("consensus");
    expect(config.digestPaths).toEqual([]);
    expect(config.agents.map((agent) => agent.id)).toEqual(["claude", "codex", "cursor", "antigravity", "muse"]);
    const declaration = join(fixture.workspaceRoot, "policy.json");
    const verification = {
      mode: "coordinator",
      coordinated: { precommit: [], prepush: [] },
      candidate: { checks: [{ name: "check", argv: ["pnpm", "run", "check"] }], covers: { files: [], prefixes: ["src/"] }, rules: [] }
    };
    writeFileSync(declaration, JSON.stringify({ verification }));
    expect(await runCli(["onboard", fixture.productRoot, "--declare", "policy.json"], {
      home,
      processRunner: runner,
      io: { cwd: fixture.workspaceRoot, stdout: (message) => output.push(message), stderr: (message) => output.push(message) }
    })).toBe(0);
    expect(JSON.parse(readFileSync(configPath, "utf8")).verification).toMatchObject(verification);
    const trust = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    expect(trust.projects[dirname(realpathSync(fixture.productRoot))].hasTrustDialogAccepted).toBe(true);
    expect(readFileSync(join(home, ".codex/config.toml"), "utf8"))
      .toContain(`[projects.${JSON.stringify(dirname(realpathSync(fixture.productRoot)))}]\ntrust_level = "trusted"`);
    expect(localConfigGet(fixture.productRoot, OWNER_WORKSPACE_CONFIG_KEY)).toBe(realpathSync(configPath));
    for (const key of ["coord.installRoot", "coord.cliEntry", "coord.workspaceConfig"]) {
      expect(localConfigGet(fixture.productRoot, key)).toBeNull();
    }
    expect(git(fixture.productRoot, "status", "--porcelain")).toBe("");
    expect(output.join("")).toContain("no findings");
    expect(output.join("")).toContain("coord manual");

    const manualAgents: string[][] = [];
    expect(
      await runCli(["manual"], {
        io: { cwd: fixture.productRoot, stdout: () => undefined },
        sessionExists: async () => false,
        manualUi: async (input) => {
          manualAgents.push(input.agents.map((agent) => agent.id));
          return { status: "already-open", count: input.agents.length };
        }
      })
    ).toBe(0);
    expect(manualAgents).toEqual([["claude", "codex", "cursor", "antigravity", "muse"]]);

    const human = join(fixture.workspaceRoot, "human");
    execFileSync("git", ["clone", "-q", fixture.originPath, human]);
    expect(localConfigGet(human, OWNER_WORKSPACE_CONFIG_KEY)).toBeNull();
    expect(existsSync(join(human, ".git", "hooks", "coord-hooks.json"))).toBe(false);

    const unrelated = product("unrelated");
    const errors: string[] = [];
    expect(
      await runCli(["10"], {
        io: { cwd: unrelated.productRoot, stderr: (message) => errors.push(message) },
        processRunner: async () => {
          throw new Error("workspace resolution must fail before issue lookup");
        },
        makeRunLoop: fakeLoop
      })
    ).toBe(2);
    expect(errors.join("")).toContain("is not onboarded in this worktree");
    expect(existsSync(issueRuntimePaths(coordRoot, 10).issueRoot)).toBe(false);
  }, 60_000);

  it("persists a selected profile and numeric dispatch resumes without refetching", async () => {
    const fixture = product();
    expect(
      await runCli(["onboard", fixture.productRoot, "--agents", "claude", "--profile", "reviewed"], {
        home: null,
        processRunner: runner,
        io: { stdout: () => undefined }
      })
    ).toBe(0);
    const coordRoot = join(dirname(fixture.productRoot), "coord-runtime");
    expect(
      await runCli(["9"], {
        processRunner: runner,
        makeRunLoop: fakeLoop,
        io: { cwd: fixture.productRoot, stdout: () => undefined }
      })
    ).toBe(0);
    const paths = issueRuntimePaths(coordRoot, 9);
    expect(readStartState(paths).profile).toBe("reviewed");

    let resumed = false;
    expect(
      await runCli(["9"], {
        processRunner: async () => {
          throw new Error("resume must not refetch or rebind the issue");
        },
        makeRunLoop: () => ({
          initializeEffects: async () => undefined,
          runTick: async () => readCursorsState(paths),
          run: async () => {
            resumed = true;
          }
        }),
        io: { cwd: fixture.productRoot, stdout: () => undefined }
      })
    ).toBe(0);
    expect(resumed).toBe(true);

    expect(
      await runCli(["start", "10", "--product", fixture.productRoot], {
        processRunner: runner,
        makeRunLoop: fakeLoop,
        io: { stdout: () => undefined }
      })
    ).toBe(0);
    expect(readStartState(issueRuntimePaths(coordRoot, 10)).profile).toBe("reviewed");
  });

  it("isolates the same issue number for two products sharing an outer runtime", async () => {
    const first = product("alpha");
    const second = product("beta");
    const sharedRoot = first.coordRoot;
    expect(
      await runCli(
        ["onboard", first.productRoot, "--coord-runtime", sharedRoot, "--agents", "claude", "--profile", "solo"],
        { home: null, processRunner: runner, io: { stdout: () => undefined } }
      )
    ).toBe(0);
    const firstConfigBytes = readFileSync(join(sharedRoot, "config.json"), "utf8");
    expect(
      await runCli(
        ["onboard", second.productRoot, "--coord-runtime", sharedRoot, "--agents", "claude", "--profile", "solo"],
        { home: null, processRunner: runner, io: { stdout: () => undefined } }
      )
    ).toBe(0);
    expect(readFileSync(join(sharedRoot, "config.json"), "utf8")).toBe(firstConfigBytes);

    for (const fixture of [first, second]) {
      expect(
        await runCli(["42", "--product", fixture.productRoot], {
          processRunner: runner,
          makeRunLoop: fakeLoop,
          io: { stdout: () => undefined }
        })
      ).toBe(0);
    }

    const flat = issueRuntimePaths(sharedRoot, 42);
    const nested = issueRuntimePaths(dirname(nestedConfigPath(sharedRoot, "beta")), 42);
    expect(readStartState(flat).configPath).toBe(join(sharedRoot, "config.json"));
    expect(readStartState(nested).configPath).toBe(nestedConfigPath(sharedRoot, "beta"));
    expect(flat.issueRoot).not.toBe(nested.issueRoot);
    expect(flat.mirror).not.toBe(nested.mirror);
    expect(flat.tmuxNamespace).toBeNull();
    expect(flat.terminalGroup).toMatch(/^[a-f0-9]{10}$/);
    expect(nested.tmuxNamespace).not.toBeNull();
    expect(nested.terminalGroup).toBe(nested.tmuxNamespace);
    expect(
      await runCli(["pause", "--issue", "42", "--product", second.productRoot], {
        io: { stdout: () => undefined }
      })
    ).toBe(0);
    expect(readCursorsState(nested).paused).toBe(true);
    expect(
      await runCli(["resume", "--issue", "42", "--product", second.productRoot], {
        io: { stdout: () => undefined }
      })
    ).toBe(0);
    expect(readCursorsState(nested).paused).toBe(false);

    expect(
      await runCli(["43", "--product", second.productRoot], {
        processRunner: runner,
        makeRunLoop: fakeLoop,
        io: { stdout: () => undefined }
      })
    ).toBe(0);
    const nestedLegacySource = issueRuntimePaths(dirname(nestedConfigPath(sharedRoot, "beta")), 43);
    const legacy = issueRuntimePaths(sharedRoot, 43);
    renameSync(nestedLegacySource.issueRoot, legacy.issueRoot);
    let resumedRoot = "";
    expect(
      await runCli(["43", "--product", second.productRoot], {
        processRunner: async () => {
          throw new Error("legacy resume must not refetch the issue");
        },
        makeRunLoop: (paths) => ({
          initializeEffects: async () => undefined,
          runTick: async () => readCursorsState(paths),
          run: async () => {
            resumedRoot = paths.issueRoot;
          }
        }),
        io: { stdout: () => undefined }
      })
    ).toBe(0);
    expect(resumedRoot).toBe(legacy.issueRoot);
    expect(
      await runCli(["pause", "--issue", "43", "--product", second.productRoot], {
        io: { stdout: () => undefined }
      })
    ).toBe(0);
    expect(readCursorsState(legacy).paused).toBe(true);

    uninstall({
      coordRoot: sharedRoot,
      productRoot: second.productRoot,
      deleteClones: false,
      wipeRuntime: true,
      deleteCoordination: false,
      force: false,
      dryRun: false,
      log: () => undefined
    });
    expect(existsSync(nestedConfigPath(sharedRoot, "beta"))).toBe(false);
    expect(readFileSync(join(sharedRoot, "config.json"), "utf8")).toBe(firstConfigBytes);
    expect(localConfigGet(second.productRoot, OWNER_WORKSPACE_CONFIG_KEY)).toBeNull();
  });

  it("re-onboarding without --coord-runtime keeps the registered custom runtime", async () => {
    const fixture = product();
    const parent = dirname(fixture.productRoot);
    const customRoot = join(parent, "myserver-runtime");
    const solo = ["--agents", "claude", "--profile", "solo"];
    const quiet = { home: null, processRunner: runner, io: { stdout: () => undefined } };
    expect(await runCli(["onboard", fixture.productRoot, "--coord-runtime", customRoot, ...solo], quiet)).toBe(0);
    const customConfig = join(customRoot, "config.json");
    const clone = agentCloneDirectory(parent, "myserver", "claude");
    expect(localConfigGet(fixture.productRoot, OWNER_WORKSPACE_CONFIG_KEY)).toBe(customConfig);
    const cloneLocator = localConfigGet(clone, "coord.workspaceConfig");
    expect(cloneLocator).not.toBeNull();
    mkdirSync(join(customRoot, "issue-7"));

    expect(await runCli(["onboard", fixture.productRoot, ...solo], quiet)).toBe(0);
    expect(existsSync(join(parent, "coord-runtime"))).toBe(false);
    expect(localConfigGet(fixture.productRoot, OWNER_WORKSPACE_CONFIG_KEY)).toBe(customConfig);
    expect(localConfigGet(clone, "coord.workspaceConfig")).toBe(cloneLocator);
    expect(existsSync(customConfig)).toBe(true);
    expect(existsSync(join(customRoot, "issue-7"))).toBe(true);

    const otherRoot = join(parent, "other-runtime");
    expect(await runCli(["onboard", fixture.productRoot, "--coord-runtime", otherRoot, ...solo], quiet)).toBe(0);
    expect(localConfigGet(fixture.productRoot, OWNER_WORKSPACE_CONFIG_KEY)).toBe(join(otherRoot, "config.json"));
  });

  it("re-onboarding a registered nested workspace keeps the shared runtime", async () => {
    const first = product("alpha");
    const second = product("beta");
    const sharedRoot = first.coordRoot;
    const solo = ["--agents", "claude", "--profile", "solo"];
    const quiet = { home: null, processRunner: runner, io: { stdout: () => undefined } };
    for (const fixture of [first, second]) {
      expect(await runCli(["onboard", fixture.productRoot, "--coord-runtime", sharedRoot, ...solo], quiet)).toBe(0);
    }
    const firstConfigBytes = readFileSync(join(sharedRoot, "config.json"), "utf8");
    const nested = nestedConfigPath(sharedRoot, "beta");
    expect(localConfigGet(second.productRoot, OWNER_WORKSPACE_CONFIG_KEY)).toBe(nested);

    expect(await runCli(["onboard", second.productRoot, ...solo], quiet)).toBe(0);
    expect(localConfigGet(second.productRoot, OWNER_WORKSPACE_CONFIG_KEY)).toBe(nested);
    expect(existsSync(join(dirname(second.productRoot), "coord-runtime"))).toBe(false);
    expect(readFileSync(join(sharedRoot, "config.json"), "utf8")).toBe(firstConfigBytes);
  });

  it("does not publish the owner locator when doctor fails", () => {
    const fixture = product();
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = "/usr/bin:/bin";
      const result = onboard({
        home: null,
        installRoot: repoRoot,
        productRoot: fixture.productRoot,
        agents: ["claude"],
        profile: "solo",
        log: silence().log
      });
      expect(result.doctor.exitCode).not.toBe(0);
      expect(result.doctor.findings.map((finding) => finding.class)).toContain("toolchain");
      expect(localConfigGet(fixture.productRoot, OWNER_WORKSPACE_CONFIG_KEY)).toBeNull();
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("keeps a valid locator when a later re-onboard doctor check fails", () => {
    const fixture = product();
    const first = onboard({
      home: null,
      installRoot: repoRoot,
      productRoot: fixture.productRoot,
      agents: ["claude"],
      profile: "solo",
      log: silence().log
    });
    expect(first.doctor.exitCode).toBe(0);
    const locator = localConfigGet(fixture.productRoot, OWNER_WORKSPACE_CONFIG_KEY);
    expect(locator).not.toBeNull();

    const originalPath = process.env.PATH;
    try {
      process.env.PATH = "/usr/bin:/bin";
      const second = onboard({
        home: null,
        installRoot: repoRoot,
        productRoot: fixture.productRoot,
        agents: ["claude"],
        profile: "solo",
        log: silence().log
      });
      expect(second.doctor.exitCode).not.toBe(0);
      expect(localConfigGet(fixture.productRoot, OWNER_WORKSPACE_CONFIG_KEY)).toBe(locator);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
