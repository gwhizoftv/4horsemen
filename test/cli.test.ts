import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";

describe("cli", () => {
  let tmp: string;
  let coordRoot: string;
  let configPath: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "cli-test-"));
    coordRoot = join(tmp, "coord");
    mkdirSync(coordRoot);

    const agentRoot = join(tmp, "agent-clone");
    mkdirSync(agentRoot);
    execSync("git init", { cwd: agentRoot, stdio: "ignore" });
    writeFileSync(join(agentRoot, "start-testagent.sh"), "#!/bin/bash\necho started", { mode: 0o755 });

    configPath = join(tmp, "config.json");
    writeFileSync(configPath, JSON.stringify({
      project: "test",
      agents: [{ id: "testagent", root: agentRoot }],
      baseBranch: "main",
      maxRevisionRounds: 3,
      prPolicy: "owner-only",
    }));
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("--help returns code 0 with usage", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.message).toContain("coord");
  });

  it("unknown command returns code 2", async () => {
    const r = await runCli(["bogus"]);
    expect(r.code).toBe(2);
  });

  it("start requires --coord-root", async () => {
    const r = await runCli(["start", "1", "--profile", "solo", "--config", configPath]);
    expect(r.code).toBe(2);
    expect(r.message).toContain("--coord-root");
  });

  it("start with valid args succeeds", async () => {
    const r = await runCli(["start", "99", "--profile", "solo", "--config", configPath, "--coord-root", coordRoot]);
    expect(r.code).toBe(0);
    expect(r.message).toContain("Started issue 99");
  });

  it("next returns 'none yet' or action for non-existent agent", async () => {
    const r = await runCli(["next", "--coord-root", coordRoot, "--issue", "99", "--agent", "nobody"]);
    expect(r.code).toBe(0);
    expect(r.message).toBe("none yet");
  });

  it("next returns action for existing agent", async () => {
    const r = await runCli(["next", "--coord-root", coordRoot, "--issue", "99", "--agent", "testagent"]);
    expect(r.code).toBe(0);
    expect(r.message).toContain("Action:");
  });

  it("drop refuses to drop final active agent", async () => {
    const r = await runCli(["drop", "testagent", "--coord-root", coordRoot, "--issue", "99"]);
    expect(r.code).toBe(1);
    expect(r.message).toContain("Cannot drop the final active agent");
  });

  it("pause succeeds", async () => {
    const r = await runCli(["pause", "--coord-root", coordRoot, "--issue", "99"]);
    expect(r.code).toBe(0);
  });

  it("resume succeeds", async () => {
    const r = await runCli(["resume", "--coord-root", coordRoot, "--issue", "99"]);
    expect(r.code).toBe(0);
  });

  it("coord next exposes no stepId, gateId, evidenceId, or phase", async () => {
    const r = await runCli(["next", "--coord-root", coordRoot, "--issue", "99", "--agent", "testagent"]);
    expect(r.message).not.toContain("stepId");
    expect(r.message).not.toContain("gateId");
    expect(r.message).not.toContain("evidenceId");
    expect(r.message).not.toContain("phase");
  });
});
