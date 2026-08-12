import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeFixture(root: string): { wrapper: string; bin: string } {
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
  writeFileSync(join(root, "bin/pnpm"), "#!/bin/sh\necho BUILD_BANNER\n", { mode: 0o700 });
  writeFileSync(
    join(root, "bin/node"),
    "#!/bin/sh\nprintf '%s\\n' \"cwd=$(pwd)\" '---' 'actionId: protocol-only'\n",
    { mode: 0o700 }
  );
  chmodSync(wrapper, 0o700);
  return { wrapper, bin: join(root, "bin") };
}

describe("coord wrapper", () => {
  it("keeps stale-build output off protocol stdout", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-wrapper-"));
    roots.push(root);
    const { wrapper, bin } = writeFixture(root);
    const result = spawnSync(wrapper, ["next"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` }
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("---\nactionId: protocol-only\n");
    expect(result.stdout).not.toContain("BUILD_BANNER");
    expect(result.stderr).toContain("BUILD_BANNER");
  });

  it("resolves a PATH symlink to the install root before pnpm build", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-wrapper-symlink-"));
    roots.push(root);
    const { wrapper, bin } = writeFixture(root);
    const linkDir = join(root, "path-bin");
    mkdirSync(linkDir);
    const link = join(linkDir, "coord");
    symlinkSync(wrapper, link);
    const result = spawnSync(link, ["next"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` }
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("---\nactionId: protocol-only\n");
    expect(result.stderr).toContain("BUILD_BANNER");
  });

  it("preserves the caller cwd so relative product paths resolve there", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-wrapper-cwd-"));
    roots.push(root);
    const { wrapper, bin } = writeFixture(root);
    const caller = join(root, "caller");
    mkdirSync(caller);
    const result = spawnSync(wrapper, ["onboard", "./testapp"], {
      cwd: caller,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` }
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`cwd=${realpathSync(caller)}`);
    expect(result.stderr).toContain("BUILD_BANNER");
  });
});
