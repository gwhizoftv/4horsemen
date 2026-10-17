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
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A stand-in Node: answers the selector's probe, and otherwise reports what ran it. */
function writeNode(path: string, version: string, label: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    "#!/bin/sh\n" +
      `if [ "$1" = --version ]; then echo ${version}; exit 0; fi\n` +
      `printf '%s\\n' "cwd=$(pwd)" "ran=${label}" "path=$PATH" "product=$(node --version)" '---' 'actionId: protocol-only'\n`,
    { mode: 0o700 }
  );
}

function writeFixture(root: string): { wrapper: string; bin: string } {
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "dist"));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "scripts/lib"), { recursive: true });
  const wrapper = join(root, "coord");
  writeFileSync(wrapper, readFileSync(resolve("coord"), "utf8"), { mode: 0o700 });
  writeFileSync(join(root, "scripts/lib/node-runtime.sh"), readFileSync(resolve("scripts/lib/node-runtime.sh"), "utf8"), {
    mode: 0o700
  });
  writeFileSync(join(root, "src/main.ts"), "newer\n");
  writeFileSync(join(root, "dist/main.js"), "older\n");
  const old = new Date(Date.now() - 60_000);
  const fresh = new Date();
  utimesSync(join(root, "dist/main.js"), old, old);
  utimesSync(join(root, "src/main.ts"), fresh, fresh);
  writeFileSync(join(root, "bin/pnpm"), "#!/bin/sh\necho BUILD_BANNER\necho \"build-node=$(node --version)\"\n", {
    mode: 0o700
  });
  writeNode(join(root, "bin/node"), "v26.0.0", "path-node");
  chmodSync(wrapper, 0o700);
  return { wrapper, bin: join(root, "bin") };
}

/** The caller's environment with only fixture runtimes visible: no inherited override or nvm tree. */
function fixtureEnv(root: string, path: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: path, NVM_DIR: join(root, "no-nvm"), ...extra };
  if (extra.COORD_NODE === undefined) delete env.COORD_NODE;
  return env;
}

describe("coord wrapper", () => {
  it("keeps stale-build output off protocol stdout", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-wrapper-"));
    roots.push(root);
    const { wrapper, bin } = writeFixture(root);
    const result = spawnSync(wrapper, ["next"], {
      encoding: "utf8",
      env: fixtureEnv(root, `${bin}:/usr/bin:/bin`)
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
      env: fixtureEnv(root, `${bin}:/usr/bin:/bin`)
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
      env: fixtureEnv(root, `${bin}:/usr/bin:/bin`)
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`cwd=${realpathSync(caller)}`);
    expect(result.stderr).toContain("BUILD_BANNER");
  });

  it("skips an older product Node for coordination's own, leaving PATH to the product's children", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-wrapper-node-"));
    roots.push(root);
    const { wrapper, bin } = writeFixture(root);
    const product = join(root, "product bin");
    writeNode(join(product, "node"), "v16.18.0", "product-node");
    const path = `${product}:${bin}:/usr/bin:/bin`;
    const result = spawnSync(wrapper, ["next", "an argument"], { encoding: "utf8", env: fixtureEnv(root, path) });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("ran=path-node\n");
    expect(result.stdout).toContain(`path=${path}\n`);
    expect(result.stdout).toContain("product=v16.18.0\n");
    expect(result.stdout).toContain("---\nactionId: protocol-only\n");
    expect(result.stderr).toContain("build-node=v26.0.0");
  });

  it("falls back to the newest supported nvm install, then to an explicit COORD_NODE first", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-wrapper-nvm-"));
    roots.push(root);
    const { wrapper } = writeFixture(root);
    const product = join(root, "product");
    writeNode(join(product, "node"), "v16.18.0", "product-node");
    writeFileSync(join(product, "pnpm"), "#!/bin/sh\necho \"build-node=$(node --version)\"\n", { mode: 0o700 });
    const nvm = join(root, "nvm home");
    writeNode(join(nvm, "versions/node/v26.9.0/bin/node"), "v26.9.0", "nvm-26.9");
    writeNode(join(nvm, "versions/node/v26.10.0/bin/node"), "v26.10.0", "nvm-26.10");
    writeNode(join(nvm, "versions/node/v27.0.0/bin/node"), "v27.0.0-nightly", "nvm-nightly");
    const path = `${product}:/usr/bin:/bin`;
    const fallback = spawnSync(wrapper, ["next"], { encoding: "utf8", env: fixtureEnv(root, path, { NVM_DIR: nvm }) });
    expect(fallback.status, fallback.stderr).toBe(0);
    expect(fallback.stdout).toContain("ran=nvm-26.10\n");
    expect(fallback.stdout).toContain("product=v16.18.0\n");
    expect(fallback.stderr).toContain("build-node=v26.10.0");

    const override = join(root, "override/node");
    writeNode(override, "v26.1.0", "override");
    const chosen = spawnSync(wrapper, ["next"], {
      encoding: "utf8",
      env: fixtureEnv(root, path, { NVM_DIR: nvm, COORD_NODE: override })
    });
    expect(chosen.status, chosen.stderr).toBe(0);
    expect(chosen.stdout).toContain("ran=override\n");
  });

  it("refuses before building or loading the CLI when no supported Node exists", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-wrapper-refuse-"));
    roots.push(root);
    const { wrapper, bin } = writeFixture(root);
    const product = join(root, "product");
    writeNode(join(product, "node"), "v16.18.0", "product-node");
    writeFileSync(join(product, "pnpm"), "#!/bin/sh\necho BUILD_BANNER\n", { mode: 0o700 });
    const prerelease = join(root, "prerelease");
    writeNode(join(prerelease, "node"), "v26.0.0-rc.1", "prerelease");
    const missing = spawnSync(wrapper, ["next"], {
      encoding: "utf8",
      env: fixtureEnv(root, `${product}:${prerelease}:/usr/bin:/bin`)
    });
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("Node >= 26 is required");
    expect(missing.stderr).toContain("node on PATH: v16.18.0");
    expect(missing.stderr).toContain("COORD_NODE");
    expect(missing.stderr).not.toContain("BUILD_BANNER");

    // An explicit override is never silently replaced by a supported PATH Node.
    const tooOld = spawnSync(wrapper, ["next"], {
      encoding: "utf8",
      env: fixtureEnv(root, `${bin}:/usr/bin:/bin`, { COORD_NODE: join(product, "node") })
    });
    expect(tooOld.status).toBe(1);
    expect(tooOld.stdout).toBe("");
    expect(tooOld.stderr).toContain("is Node v16.18.0; coordination needs Node >= 26");
    expect(tooOld.stderr).not.toContain("BUILD_BANNER");
  });

  it("keeps the selector's minimum in step with package.json engines and .nvmrc", () => {
    const minimum = /^COORD_NODE_MIN_MAJOR=(\d+)$/m.exec(readFileSync(resolve("scripts/lib/node-runtime.sh"), "utf8"))?.[1];
    const engines = (JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { engines: { node: string } }).engines.node;
    expect(engines).toBe(`>=${minimum}.0.0`);
    expect(readFileSync(resolve(".nvmrc"), "utf8").trim()).toBe(minimum);
  });
});
