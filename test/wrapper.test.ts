import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("coord wrapper", () => {
  it("keeps stale-build output off protocol stdout", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-wrapper-"));
    roots.push(root);
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "dist"));
    mkdirSync(join(root, "bin"));
    const wrapper = join(root, "coord");
    writeFileSync(wrapper, readFileSync(resolve("coord"), "utf8"), { mode: 0o700 });
    writeFileSync(join(root, "src/main.ts"), "newer\n");
    writeFileSync(join(root, "dist/main.js"), "older\n");
    const old = new Date(Date.now() - 60_000);
    const fresh = new Date();
    utimesSync(join(root, "dist/main.js"), old, old);
    utimesSync(join(root, "src/main.ts"), fresh, fresh);
    const pnpm = join(root, "bin/pnpm");
    writeFileSync(pnpm, "#!/bin/sh\necho BUILD_BANNER\n", { mode: 0o700 });
    const node = join(root, "bin/node");
    writeFileSync(node, "#!/bin/sh\nprintf '%s\\n' '---' 'actionId: protocol-only'\n", { mode: 0o700 });
    chmodSync(wrapper, 0o700);
    const result = spawnSync(wrapper, ["next"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(root, "bin")}:/usr/bin:/bin` }
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("---\nactionId: protocol-only\n");
    expect(result.stdout).not.toContain("BUILD_BANNER");
    expect(result.stderr).toContain("BUILD_BANNER");
  });
});
