import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliRunLoop } from "../src/cli.js";
import { localConfigGet } from "../src/gitExec.js";
import { install, onboard, uninstall } from "../src/install.js";
import { issueRuntimePaths } from "../src/paths.js";
import { agentCloneDirectory } from "../src/setupWorkspace.js";
import { readConfig, readCursorsState, readStartState } from "../src/state.js";
import { nestedConfigPath, OWNER_WORKSPACE_CONFIG_KEY } from "../src/workspace.js";
import {
  ensureBuilt,
  git,
  makeProduct,
  repoRoot,
  silence,
  type ProductFixture
} from "./support/workspaceFixture.js";

const products: ProductFixture[] = [];
afterEach(() => {
  for (const product of products.splice(0)) product.cleanup();
});

const nodeManifests: Record<string, string> = {
  "package.json": `${JSON.stringify({ name: "fixture", scripts: { "check:fast": "true", check: "true" } }, null, 2)}\n`,
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n"
};

const product = (name = "myserver", manifests = nodeManifests): ProductFixture => {
  ensureBuilt();
  const fixture = makeProduct("plain", name);
  products.push(fixture);
  for (const [path, content] of Object.entries(manifests)) writeFileSync(join(fixture.productRoot, path), content);
  git(fixture.productRoot, "add", ...Object.keys(manifests));
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
  it("applies the happy-path defaults without changing the tracked product tree", async () => {
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
    expect(config.agents.map((agent) => agent.id)).toEqual(["claude", "codex", "cursor", "antigravity"]);
    const declaration = join(fixture.workspaceRoot, "policy.json");
    const verification = {
      mode: "coordinator",
      coordinated: { precommit: [], prepush: [] },
      candidate: { checks: [{ name: "check", argv: ["pnpm", "run", "check"] }], covers: { files: [], prefixes: ["src/"] }, rules: [] }
    };
    writeFileSync(declaration, JSON.stringify({ verification }));
    expect(await runCli(["onboard", fixture.productRoot, "--declare", "policy.json"], {
      home,
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
    expect(manualAgents).toEqual([["claude", "codex", "cursor", "antigravity"]]);

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
  });

  it("persists a selected profile and numeric dispatch resumes without refetching", async () => {
    const fixture = product();
    expect(
      await runCli(["onboard", fixture.productRoot, "--agents", "claude", "--profile", "reviewed"], {
        home: null,
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
        { home: null, io: { stdout: () => undefined } }
      )
    ).toBe(0);
    const firstConfigBytes = readFileSync(join(sharedRoot, "config.json"), "utf8");
    expect(
      await runCli(
        ["onboard", second.productRoot, "--coord-runtime", sharedRoot, "--agents", "claude", "--profile", "solo"],
        { home: null, io: { stdout: () => undefined } }
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
    const quiet = { home: null, io: { stdout: () => undefined } };
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
    const quiet = { home: null, io: { stdout: () => undefined } };
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

describe("coord onboard — Python and Flutter defaults", () => {
  /** Executables that only record that something ran them; onboarding must not. */
  const toolStubs = (fixture: ProductFixture, tool: string): { path: string; marker: string } => {
    const bin = join(fixture.workspaceRoot, "bin");
    const marker = join(fixture.workspaceRoot, "tool-invoked");
    mkdirSync(bin);
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "$0 $*" >> '${marker}'\nexit 1\n`);
    chmodSync(join(bin, tool), 0o755);
    return { path: `${bin}${delimiter}${process.env.PATH ?? ""}`, marker };
  };
  const withPath = <T>(path: string, run: () => T): T => {
    const original = process.env.PATH;
    try {
      process.env.PATH = path;
      return run();
    } finally {
      process.env.PATH = original;
    }
  };
  const onboardProduct = (fixture: ProductFixture, output: string[], declarePath?: string) =>
    onboard({
      home: null,
      installRoot: repoRoot,
      productRoot: fixture.productRoot,
      agents: ["claude"],
      profile: "solo",
      log: (message) => output.push(message),
      ...(declarePath === undefined ? {} : { declarePath })
    });
  const pyproject = { "pyproject.toml": "[project]\nname = \"app\"\n" };
  const pubspec = { "pubspec.yaml": "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n" };

  it.each([
    { kind: "python", manifests: pyproject, tool: "pytest", checks: [["pytest", "-q"]], effect: "Python runs `pytest -q` at commit" },
    {
      kind: "flutter", manifests: pubspec, tool: "flutter", checks: [["flutter", "analyze"], ["flutter", "test"]],
      effect: "Flutter runs `flutter analyze` at commit and `flutter test` at push"
    }
  ])("onboards a plain $kind product, records and announces its defaults, and runs no product tool", ({ kind, manifests, tool, checks, effect }) => {
    const fixture = product(`${kind}app`, manifests);
    const stubs = toolStubs(fixture, tool);
    const output: string[] = [];
    const result = withPath(stubs.path, () => onboardProduct(fixture, output));
    expect(result.doctor.findings).toEqual([]);
    const config = readConfig(result.install.configPath);
    expect(config.toolchain).toBe(kind);
    expect(config.checks.map((check) => check.argv)).toEqual(checks);
    const text = output.join("");
    expect(text).toMatch(new RegExp(`toolchain +: ${kind} \\(inferred\\)`));
    expect(text).toContain(`: ${config.checks.map((check) => `${check.name} ${JSON.stringify(check.argv)}`).join(", ")} (inferred)`);
    expect(text).toContain(effect);
    expect(text).toContain("nothing here runs the suite");
    expect(localConfigGet(fixture.productRoot, OWNER_WORKSPACE_CONFIG_KEY)).toBe(realpathSync(result.install.configPath));
    expect(git(fixture.productRoot, "status", "--porcelain")).toBe("");
    expect(existsSync(stubs.marker)).toBe(false);
  });

  it("reports a missing Flutter SDK as a doctor finding, not an inference failure", () => {
    const fixture = product("flutterapp", pubspec);
    const result = withPath("/usr/bin:/bin", () => onboardProduct(fixture, []));
    expect(result.doctor.findings).toContainEqual(expect.objectContaining({ class: "toolchain", subject: "flutter" }));
    expect(readConfig(result.install.configPath).toolchain).toBe("flutter");
    expect(localConfigGet(fixture.productRoot, OWNER_WORKSPACE_CONFIG_KEY)).toBeNull();
  });

  it("shows a re-onboard declaration as recorded, and a dry run as proposed without writing", () => {
    const fixture = product("pythonapp", pyproject);
    const stubs = toolStubs(fixture, "pytest");
    expect(withPath(stubs.path, () => onboardProduct(fixture, [])).doctor.exitCode).toBe(0);
    const declaration = join(fixture.workspaceRoot, "policy.json");
    const unit = { name: "unit", argv: ["pytest", "tests/unit"] };
    writeFileSync(declaration, JSON.stringify({ verify: { precommit: [], prepush: [] }, checks: [unit] }));
    const output: string[] = [];
    const result = withPath(stubs.path, () => onboardProduct(fixture, output, declaration));
    expect(result.doctor.exitCode).toBe(0);
    expect(readConfig(result.install.configPath)).toMatchObject({ verify: { precommit: [], prepush: [] }, checks: [unit] });
    const text = output.join("");
    expect(text).toMatch(/precommit +: none \(explicit opt-out\) \(declared\)/);
    expect(text).toContain(`: unit ${JSON.stringify(unit.argv)} (declared)`);
    expect(text).not.toContain("Python runs");

    const fresh = product("drypython", pyproject);
    const dryOutput: string[] = [];
    const dry = install({
      installRoot: repoRoot,
      productRoot: fresh.productRoot,
      coordRoot: fresh.coordRoot,
      agents: ["claude"],
      profile: "solo",
      writeProduct: false,
      vendor: false,
      bootstrap: false,
      dryRun: true,
      home: null,
      log: (message) => dryOutput.push(message)
    });
    expect(dryOutput.join("")).toContain("Proposed verification policy (dry run; nothing written):");
    expect(dryOutput.join("")).toMatch(/precommit +: test \["pytest","-q"\] \(inferred\)/);
    expect(existsSync(dry.configPath)).toBe(false);
    expect(dry.clones.some((clone) => existsSync(clone))).toBe(false);
    expect(dry.changes.join("\n")).not.toContain("verification policy");
  });
});
