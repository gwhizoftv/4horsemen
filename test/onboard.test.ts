import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliRunLoop } from "../src/cli.js";
import { localConfigGet } from "../src/gitExec.js";
import { onboard, uninstall } from "../src/install.js";
import { issueRuntimePaths } from "../src/paths.js";
import { readCursorsState, readStartState } from "../src/state.js";
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

const product = (name = "myserver"): ProductFixture => {
  ensureBuilt();
  const fixture = makeProduct("plain", name);
  products.push(fixture);
  writeFileSync(
    join(fixture.productRoot, "package.json"),
    `${JSON.stringify({ name: "fixture", scripts: { "check:fast": "true", check: "true" } }, null, 2)}\n`
  );
  writeFileSync(join(fixture.productRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  git(fixture.productRoot, "add", "package.json", "pnpm-lock.yaml");
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
    mkdirSync(aliasParent);
    symlinkSync(fixture.productRoot, productAlias, "dir");
    expect(
      await runCli(["onboard", productAlias], {
        io: { stdout: (message) => output.push(message), stderr: (message) => output.push(message) }
      })
    ).toBe(0);

    const coordRoot = join(dirname(fixture.productRoot), "coord-runtime");
    const configPath = join(coordRoot, "config.json");
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(join(aliasParent, "coord-runtime"))).toBe(false);
    expect(
      await runCli(["onboard", fixture.productRoot], {
        io: { stdout: (message) => output.push(message), stderr: (message) => output.push(message) }
      })
    ).toBe(0);
    expect(existsSync(join(coordRoot, "workspaces"))).toBe(false);
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      profile: string;
      digestPaths: string[];
      agents: Array<{ id: string }>;
    };
    expect(config.profile).toBe("consensus");
    expect(config.digestPaths).toEqual([]);
    expect(config.agents.map((agent) => agent.id)).toEqual(["claude", "codex", "cursor", "antigravity"]);
    expect(localConfigGet(fixture.productRoot, OWNER_WORKSPACE_CONFIG_KEY)).toBe(realpathSync(configPath));
    for (const key of ["coord.installRoot", "coord.cliEntry", "coord.workspaceConfig"]) {
      expect(localConfigGet(fixture.productRoot, key)).toBeNull();
    }
    expect(git(fixture.productRoot, "status", "--porcelain")).toBe("");
    expect(output.join("")).toContain("no findings");

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
        ["onboard", first.productRoot, "--coord-root", sharedRoot, "--agents", "claude", "--profile", "solo"],
        { io: { stdout: () => undefined } }
      )
    ).toBe(0);
    const firstConfigBytes = readFileSync(join(sharedRoot, "config.json"), "utf8");
    expect(
      await runCli(
        ["onboard", second.productRoot, "--coord-root", sharedRoot, "--agents", "claude", "--profile", "solo"],
        { io: { stdout: () => undefined } }
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
    expect(nested.tmuxNamespace).not.toBeNull();
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

  it("does not publish the owner locator when doctor fails", () => {
    const fixture = product();
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = "/usr/bin:/bin";
      const result = onboard({
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
