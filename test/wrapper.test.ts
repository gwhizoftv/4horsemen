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

function writeNodeStub(path: string, version: string, body = "exit 0"): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "\${1:-}" = "--version" ]; then\n  printf '%s\\n' '${version}'\n  exit 0\nfi\n${body}\n`,
    { mode: 0o700 }
  );
  chmodSync(path, 0o700);
}

function writeFixture(root: string): { wrapper: string; runtime: string; bin: string } {
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "dist"));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "scripts", "lib"), { recursive: true });
  const wrapper = join(root, "coord");
  const runtime = join(root, "scripts", "lib", "node-runtime.sh");
  writeFileSync(wrapper, readFileSync(resolve("coord"), "utf8"), { mode: 0o700 });
  writeFileSync(runtime, readFileSync(resolve("scripts/lib/node-runtime.sh"), "utf8"), { mode: 0o700 });
  writeFileSync(join(root, "src/main.ts"), "newer\n");
  writeFileSync(join(root, "dist/main.js"), "older\n");
  const old = new Date(Date.now() - 60_000);
  const fresh = new Date();
  utimesSync(join(root, "dist/main.js"), old, old);
  utimesSync(join(root, "src/main.ts"), fresh, fresh);
  writeFileSync(
    join(root, "bin/pnpm"),
    "#!/bin/sh\necho \"BUILD_BANNER node=$(node --version)\"\n",
    { mode: 0o700 }
  );
  writeNodeStub(
    join(root, "bin/node"),
    "v26.0.0",
    "printf '%s\\n' \"cwd=$(pwd)\" \"path_node=$(node --version)\" '---' 'actionId: protocol-only'"
  );
  chmodSync(wrapper, 0o700);
  chmodSync(runtime, 0o700);
  return { wrapper, runtime, bin: join(root, "bin") };
}

describe("coord wrapper", () => {
  it("keeps stale-build output off protocol stdout", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-wrapper-"));
    roots.push(root);
    const { wrapper, bin } = writeFixture(root);
    const result = spawnSync(wrapper, ["next"], {
      encoding: "utf8",
      env: { ...process.env, COORD_NODE: "", PATH: `${bin}:/usr/bin:/bin` }
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
      env: { ...process.env, COORD_NODE: "", PATH: `${bin}:/usr/bin:/bin` }
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
      env: { ...process.env, COORD_NODE: "", PATH: `${bin}:/usr/bin:/bin` }
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`cwd=${realpathSync(caller)}`);
    expect(result.stderr).toContain("BUILD_BANNER");
  });

  it("selects Node >=26 from NVM_DIR during pnpm build while keeping the workspace Node on PATH for the CLI", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-wrapper-nvm-"));
    roots.push(root);
    const { wrapper, bin } = writeFixture(root);
    writeNodeStub(join(bin, "node"), "v16.18.0", "echo wrong-node >&2; exit 99");
    const nvmDir = join(root, "nvm");
    writeNodeStub(join(nvmDir, "versions/node/v16.18.0/bin/node"), "v16.18.0");
    writeNodeStub(join(nvmDir, "versions/node/v26.2.0/bin/node"), "v26.2.0", "echo old-26");
    writeNodeStub(
      join(nvmDir, "versions/node/v26.10.0/bin/node"),
      "v26.10.0",
      "printf '%s\\n' \"cli_path_node=$(node --version)\" '---' 'actionId: protocol-only'"
    );
    // Directory name claims v99, but binary reports prerelease or old version and must be ignored.
    writeNodeStub(join(nvmDir, "versions/node/v99.0.0/bin/node"), "v26.0.0-rc.1");

    const result = spawnSync(wrapper, ["next"], {
      encoding: "utf8",
      env: { ...process.env, COORD_NODE: "", NVM_DIR: nvmDir, PATH: `${bin}:/usr/bin:/bin` }
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("BUILD_BANNER node=v26.10.0");
    expect(result.stdout).toContain("cli_path_node=v16.18.0\n---\nactionId: protocol-only\n");
  });

  it("enforces COORD_NODE fail-closed rules, PATH scanning with spaces, and actionable diagnostics", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-node-runtime-"));
    roots.push(root);
    const { runtime } = writeFixture(root);
    const oldBin = join(root, "old bin");
    const newBin = join(root, "new bin");
    writeNodeStub(join(oldBin, "node"), "v16.18.0");
    writeNodeStub(join(newBin, "node"), "v26.1.0", "printf '%s\\n' \"ran:$*\"");

    const fromPath = spawnSync(runtime, ["--print-path"], {
      encoding: "utf8",
      env: { ...process.env, COORD_NODE: "", NVM_DIR: join(root, "empty-nvm"), PATH: `${oldBin}:${newBin}:/usr/bin:/bin` }
    });
    expect(fromPath.status).toBe(0);
    expect(fromPath.stdout.trim()).toBe(join(newBin, "node"));

    const badOverride = spawnSync(runtime, ["--print-path"], {
      encoding: "utf8",
      env: { ...process.env, COORD_NODE: join(oldBin, "node"), PATH: `${newBin}:/usr/bin:/bin` }
    });
    expect(badOverride.status).toBe(1);
    expect(badOverride.stdout).toBe("");
    expect(badOverride.stderr).toContain("COORD_NODE");
    expect(badOverride.stderr).toContain("v16.18.0");
    expect(badOverride.stderr).toContain(">=26.0.0");

    const relativeOverride = spawnSync(runtime, ["--print-path"], {
      encoding: "utf8",
      env: { ...process.env, COORD_NODE: "relative/node", PATH: `${newBin}:/usr/bin:/bin` }
    });
    expect(relativeOverride.status).toBe(1);
    expect(relativeOverride.stdout).toBe("");
    expect(relativeOverride.stderr).toContain("must be an absolute path");

    const noCompatible = spawnSync(runtime, ["arg1"], {
      encoding: "utf8",
      env: { ...process.env, COORD_NODE: "", NVM_DIR: join(root, "empty-nvm"), PATH: `${oldBin}:/usr/bin:/bin` }
    });
    expect(noCompatible.status).toBe(1);
    expect(noCompatible.stdout).toBe("");
    expect(noCompatible.stderr).toContain(">=26.0.0");
    expect(noCompatible.stderr).toContain("v16.18.0");
    expect(noCompatible.stderr).toContain("COORD_NODE");
  });
});
