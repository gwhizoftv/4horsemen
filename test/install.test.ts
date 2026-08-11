import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { packageRoot } from "../src/setupWorkspace.js";
import { readConfig } from "../src/state.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (args: readonly string[], cwd: string): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const initProduct = (root: string, name: string): string => {
  const product = join(root, name);
  mkdirSync(product);
  git(["init"], product);
  git(["config", "user.email", "test@example.com"], product);
  git(["config", "user.name", "Test"], product);
  writeFileSync(join(product, "README.md"), `# ${name}\n`);
  writeFileSync(join(product, "main.go"), "package main\nfunc main() {}\n");
  git(["add", "."], product);
  git(["commit", "-m", "init"], product);
  git(["branch", "-M", "main"], product);
  // Local origin so install can resolve remote URL.
  const origin = join(root, `${name}.git`);
  git(["init", "--bare", origin], root);
  git(["remote", "add", "origin", origin], product);
  git(["push", "-u", "origin", "main"], product);
  return product;
};

const writeTemplate = (path: string, verify: unknown): void => {
  writeFileSync(
    path,
    JSON.stringify(
      {
        project: "fixture",
        origin: "https://example.com/fixture.git",
        agents: [{ id: "cursor", root: "../fixture-cursor", launcher: "start-cursor.sh", delivery: "pull" }],
        branch: "issue-{issue}/{agent}",
        baseBranch: "main",
        maxRevisionRounds: 3,
        prPolicy: "owner-only",
        digestPaths: [".plans/issue-{issue}/plan.md"],
        pollIntervalMs: 100,
        verify,
        workflowCriticalPrefixes: ["src/"],
        workflowCriticalFiles: ["main.go"],
        checks: [{ name: "true", argv: ["true"] }]
      },
      null,
      2
    )
  );
};

describe("coord install", () => {
  it("leaves the product master clean and wires only agent clones", async () => {
    const root = mkdtempSync(join(tmpdir(), "coord-install-"));
    roots.push(root);
    const product = initProduct(root, "app");
    const runtime = join(root, "runtime");
    const template = join(root, "template.json");
    writeTemplate(template, {
      precommit: [{ name: "ok", argv: ["true"] }],
      prepush: [{ name: "ok", argv: ["true"] }]
    });

    const output: string[] = [];
    const code = await runCli(
      [
        "install",
        "--product",
        product,
        "--coord-root",
        runtime,
        "--agents",
        "cursor",
        "--config",
        template,
        "--install-root",
        packageRoot
      ],
      { io: { cwd: root, stdout: (message) => output.push(message), stderr: (message) => output.push(message) } }
    );
    expect(code).toBe(0);
    expect(git(["status", "--porcelain"], product)).toBe("");
    expect(existsSync(join(product, ".git/hooks/pre-commit"))).toBe(false);

    const clone = join(root, "app-cursor");
    expect(existsSync(join(clone, ".git/hooks/pre-commit"))).toBe(true);
    expect(readFileSync(join(clone, ".git/hooks/pre-commit"), "utf8")).toContain("coord.installRoot");
    expect(git(["config", "--local", "--get", "consensus.agentId"], clone)).toBe("cursor");
    expect(git(["config", "--local", "--get", "coord.installRoot"], clone)).toBe(packageRoot);

    const config = readConfig(join(runtime, "config.json"));
    expect(config.coordination?.installRoot).toBe(packageRoot);
    expect(config.verify?.precommit?.[0]?.argv).toEqual(["true"]);

    const human = join(root, "human-clone");
    git(["clone", join(root, "app.git"), human], root);
    expect(existsSync(join(human, ".git/hooks/pre-commit"))).toBe(false);
    let humanAgent = "";
    try {
      humanAgent = git(["config", "--local", "--get", "consensus.agentId"], human);
    } catch {
      humanAgent = "";
    }
    expect(humanAgent).toBe("");

    // Second install is a no-op.
    const again = await runCli(
      [
        "install",
        "--product",
        product,
        "--coord-root",
        runtime,
        "--agents",
        "cursor",
        "--config",
        template,
        "--install-root",
        packageRoot
      ],
      { io: { cwd: root, stdout: (message) => output.push(message) } }
    );
    expect(again).toBe(0);
    expect(output.join("")).toContain("no-op");
  });

  it("uninstall clears agent wiring without deleting clones by default", async () => {
    const root = mkdtempSync(join(tmpdir(), "coord-uninstall-"));
    roots.push(root);
    const product = initProduct(root, "app");
    const runtime = join(root, "runtime");
    const template = join(root, "template.json");
    writeTemplate(template, { precommit: [], prepush: [] });

    expect(
      await runCli(
        [
          "install",
          "--product",
          product,
          "--coord-root",
          runtime,
          "--agents",
          "cursor",
          "--config",
          template,
          "--install-root",
          packageRoot
        ],
        { io: { cwd: root, stdout: () => undefined } }
      )
    ).toBe(0);

    const clone = join(root, "app-cursor");
    expect(
      await runCli(["uninstall", "--coord-root", runtime], {
        io: { cwd: root, stdout: () => undefined }
      })
    ).toBe(0);
    expect(existsSync(clone)).toBe(true);
    expect(existsSync(join(clone, ".git/hooks/pre-commit"))).toBe(false);
    expect(existsSync(join(clone, "start-cursor.sh"))).toBe(false);
    expect(existsSync(join(runtime, "config.json"))).toBe(false);
  });
});
