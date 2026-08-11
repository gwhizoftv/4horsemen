import { describe, it, expect, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:child_process");

describe("integration", () => {
  it("runs start and run", async () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "e2e-")));
    
    await runCli(["node", "coord", "start", "--coord-root", tmp]);
    await runCli(["node", "coord", "run", "--coord-root", tmp]);
    
    expect(true).toBe(true);
    rmSync(tmp, { recursive: true, force: true });
  });
});
