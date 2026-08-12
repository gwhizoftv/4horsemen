import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { repoRoot } from "./support/workspaceFixture.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const bootstrap = join(repoRoot, "scripts", "bootstrap.sh");

const runBootstrap = (
  env: NodeJS.ProcessEnv,
  args: string[] = []
): { exitCode: number; stdout: string; stderr: string } => {
  try {
    const stdout = execFileSync("sh", [bootstrap, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { exitCode: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
};

describe("scripts/bootstrap.sh", () => {
  it("refuses a dirty install without moving HEAD", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-boot-"));
    roots.push(root);
    const installRoot = join(root, "coordination");
    execFileSync("git", ["clone", "--quiet", repoRoot, installRoot]);
    const before = execFileSync("git", ["-C", installRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    writeFileSync(join(installRoot, "dirty.txt"), "nope\n");
    const result = runBootstrap(
      { COORD_INSTALL_ROOT: installRoot, HOME: root, PATH: process.env.PATH },
      ["--no-path"]
    );
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/dirty/);
    expect(execFileSync("git", ["-C", installRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(before);
  });

  it("refuses to overwrite an unrelated launcher file", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-boot-"));
    roots.push(root);
    const bin = join(root, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "coord"), "#!/bin/sh\necho foreign\n", { mode: 0o755 });
    const script = execFileSync("cat", [bootstrap], { encoding: "utf8" });
    expect(script).toContain("refusing to overwrite unrelated file");
    expect(existsSync(join(bin, "coord"))).toBe(true);
  });

  it("documents --root precedence over COORD_INSTALL_ROOT", () => {
    const script = execFileSync("cat", [bootstrap], { encoding: "utf8" });
    expect(script).toContain("--root");
    expect(script).toContain("COORD_INSTALL_ROOT");
    expect(script).toContain("--no-path");
    expect(script).toContain("coord-bootstrap-owner");
  });
});
