import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearAgentHooks, writeHookShims } from "../src/hookSync.js";
import { packageRoot } from "../src/setupWorkspace.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (args: readonly string[], cwd: string): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const initRepo = (path: string): void => {
  mkdirSync(path, { recursive: true });
  git(["init"], path);
  git(["config", "user.email", "test@example.com"], path);
  git(["config", "user.name", "Test"], path);
  writeFileSync(join(path, "README.md"), "hi\n");
  git(["add", "."], path);
  git(["commit", "-m", "init"], path);
  git(["checkout", "-b", "issue-1/cursor"], path);
};

describe("hookSync", () => {
  it("blocks commits when install root is missing on an agent-wired clone", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-hooks-"));
    roots.push(root);
    const clone = join(root, "agent");
    initRepo(clone);
    writeHookShims(clone);
    git(["config", "--local", "consensus.agentId", "cursor"], clone);
    git(["config", "--local", "consensus.agentLabel", "Cursor"], clone);
    // No coord.installRoot
    writeFileSync(join(clone, "x.txt"), "x\n");
    git(["add", "x.txt"], clone);
    let failed = false;
    try {
      execFileSync("git", ["commit", "-m", "Cursor: x"], { cwd: clone, encoding: "utf8" });
    } catch (error) {
      failed = true;
      const stderr = error instanceof Error && "stderr" in error ? String((error as { stderr: string }).stderr) : "";
      expect(stderr).toContain("coordination is not installed");
    }
    expect(failed).toBe(true);
  });

  it("does not install shims into a human clone by default", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-human-"));
    roots.push(root);
    const human = join(root, "human");
    initRepo(human);
    expect(existsSync(join(human, ".git/hooks/pre-commit"))).toBe(false);
    clearAgentHooks(human);
    expect(existsSync(join(human, ".git/hooks/pre-commit"))).toBe(false);
  });

  it("executes install-root hook bodies when installRoot is set", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-shim-ok-"));
    roots.push(root);
    const clone = join(root, "agent");
    initRepo(clone);
    writeHookShims(clone);
    git(["config", "--local", "consensus.agentId", "cursor"], clone);
    git(["config", "--local", "consensus.agentLabel", "Cursor"], clone);
    git(["config", "--local", "coord.installRoot", packageRoot], clone);

    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        project: "x",
        origin: "https://example.com/x.git",
        agents: [{ id: "cursor", root: clone, launcher: "start-cursor.sh", delivery: "pull" }],
        branch: "issue-{issue}/{agent}",
        baseBranch: "main",
        maxRevisionRounds: 3,
        prPolicy: "owner-only",
        digestPaths: [".plans/issue-{issue}/plan.md"],
        checks: [{ name: "true", argv: ["true"] }],
        verify: { precommit: [{ name: "ok", argv: ["true"] }], prepush: [] }
      })
    );
    git(["config", "--local", "coord.workspaceConfig", configPath], clone);
    chmodSync(join(packageRoot, "githooks/pre-commit"), 0o755);

    writeFileSync(join(clone, "y.txt"), "y\n");
    git(["add", "y.txt"], clone);
    git(["commit", "-m", "Cursor: y"], clone);
  });
});
